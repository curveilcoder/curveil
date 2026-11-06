// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AssetRegistry} from "../../src/shared/AssetRegistry.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {ShieldedPool} from "../../src/vault/ShieldedPool.sol";
import {IGroth16Verifier9} from "../../src/vault/interfaces/IGroth16Verifier9.sol";

/// @dev Accepts every proof. With the circuits taken out, the pool's own accounting is all that
///      stands between a spender and the pool's tokens, which is what these invariants test.
contract AcceptAllVerifier is IGroth16Verifier9 {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[9] calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }
}

contract VaultHandler is Test {
    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    ShieldedPool public pool;
    TestToken[2] public tokens;
    address[3] internal actors;
    bytes internal note;

    uint256 public nextNullifier = 1;
    uint256 public spendsOk;
    uint256 public doubleSpendsAccepted;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public paidOut; // to recipients and fee recipients
    mapping(address => uint256) public donated;

    constructor(ShieldedPool pool_, TestToken[2] memory tokens_, address[3] memory actors_) {
        pool = pool_;
        tokens = tokens_;
        actors = actors_;
        note = new bytes(129);
        note[0] = bytes1(uint8(1));
    }

    function _token(uint256 seed) internal view returns (TestToken) {
        return tokens[seed % 2];
    }

    function shield(uint256 seed, uint256 amount) external {
        TestToken t = _token(seed);
        address who = actors[seed % 3];
        amount = bound(amount, 1, 1_000_000e6);
        t.mint(who, amount);
        vm.startPrank(who);
        t.approve(address(pool), amount);
        pool.shield(address(t), amount, uint256(keccak256(abi.encode(seed))) % P, note);
        vm.stopPrank();
        deposited[address(t)] += amount;
    }

    function withdraw(uint256 seed, uint256 amount, uint256 fee) external {
        TestToken t = _token(seed);
        uint256 bal = pool.shieldedBalance(address(t));
        // Ask for up to 10% more than is shielded: the excess must revert.
        amount = bound(amount, 1, bal + bal / 10 + 1);
        fee = bound(fee, 0, amount / 10);
        ShieldedPool.WithdrawArgs memory a;
        a.root = pool.getLastRoot();
        a.nullifiers = [nextNullifier, nextNullifier + 1];
        a.commitment = uint256(keccak256(abi.encode("change", seed))) % P;
        a.token = address(t);
        a.amount = amount;
        a.fee = fee;
        a.recipient = actors[(seed % 3 + 1) % 3];
        a.feeRecipient = fee == 0 ? address(0) : actors[(seed % 3 + 2) % 3];
        a.deadline = block.timestamp;
        a.encryptedChange = note;
        uint256 before = t.balanceOf(address(pool));
        try pool.withdraw(_proof(), a) {
            nextNullifier += 2;
            spendsOk++;
            paidOut[address(t)] += before - t.balanceOf(address(pool));
        } catch {}
    }

    function transferWithFee(uint256 seed, uint256 fee) external {
        TestToken t = _token(seed);
        uint256 bal = pool.shieldedBalance(address(t));
        fee = bound(fee, 0, bal + 1);
        ShieldedPool.TransferArgs memory a;
        a.root = pool.getLastRoot();
        a.nullifiers = [nextNullifier, nextNullifier + 1];
        a.commitments = [uint256(keccak256(abi.encode("c0", seed))) % P, uint256(keccak256(abi.encode("c1", seed))) % P];
        a.fee = fee;
        a.feeResource = fee == 0 ? 0 : pool.resourceOf(address(t));
        a.feeRecipient = fee == 0 ? address(0) : actors[seed % 3];
        a.deadline = block.timestamp;
        a.encryptedNote0 = note;
        a.encryptedNote1 = note;
        uint256 before = t.balanceOf(address(pool));
        try pool.transfer(_proof(), a) {
            nextNullifier += 2;
            spendsOk++;
            paidOut[address(t)] += before - t.balanceOf(address(pool));
        } catch {}
    }

    /// Replays nullifiers that were already spent; the pool must refuse every time.
    function replay(uint256 seed, uint256 which) external {
        if (nextNullifier == 1) return;
        uint256 n = bound(which, 1, nextNullifier - 1);
        ShieldedPool.WithdrawArgs memory a;
        a.root = pool.getLastRoot();
        a.nullifiers = [n, nextNullifier + 1_000_000];
        a.commitment = 7;
        a.token = address(_token(seed));
        a.amount = 1;
        a.recipient = actors[seed % 3];
        a.deadline = block.timestamp;
        a.encryptedChange = note;
        try pool.withdraw(_proof(), a) {
            doubleSpendsAccepted++;
        } catch {}
    }

    /// Tokens sent straight to the pool must never become withdrawable.
    function donate(uint256 seed, uint256 amount) external {
        TestToken t = _token(seed);
        amount = bound(amount, 1, 100_000e6);
        t.mint(address(pool), amount);
        donated[address(t)] += amount;
    }

    function claimFees(uint256 seed) external {
        TestToken t = _token(seed);
        uint256 before = t.balanceOf(address(pool));
        try pool.claimProtocolFees(address(t)) {
            paidOut[address(t)] += before - t.balanceOf(address(pool));
        } catch {}
    }

    function _proof() internal pure returns (ShieldedPool.Proof memory p) {}
}

/// @notice Whitepaper section 20, vault: no unbacked claims and no double spend. Every token the
///         pool holds is either shielded, owed as protocol fees or a donation; nothing leaves
///         beyond what was deposited; no nullifier is accepted twice.
contract VaultInvariantTest is Test {
    ShieldedPool pool;
    TestToken[2] tokens;
    VaultHandler handler;
    address treasury = makeAddr("treasury");

    function setUp() public {
        AssetRegistry registry = new AssetRegistry(address(this));
        tokens[0] = new TestToken("Test USDG", "tUSDG", 6, address(this));
        tokens[1] = new TestToken("Test WETH", "tWETH", 18, address(this));
        IGroth16Verifier9 v = new AcceptAllVerifier();
        pool = new ShieldedPool(address(this), registry, v, v, 30, treasury);
        for (uint256 i = 0; i < 2; i++) {
            registry.admit(address(tokens[i]), tokens[i].symbol());
            pool.configureAsset(address(tokens[i]), true, 0);
        }
        address[3] memory actors = [makeAddr("a"), makeAddr("b"), makeAddr("c")];
        handler = new VaultHandler(pool, tokens, actors);
        for (uint256 i = 0; i < 2; i++) {
            tokens[i].grantRole(tokens[i].MINTER_ROLE(), address(handler));
        }
        targetContract(address(handler));
    }

    function invariant_backed() public view {
        for (uint256 i = 0; i < 2; i++) {
            address t = address(tokens[i]);
            assertEq(
                tokens[i].balanceOf(address(pool)),
                pool.shieldedBalance(t) + pool.protocolFeesAccrued(t) + handler.donated(t),
                "pool balance = shielded + fees + donations"
            );
        }
    }

    function invariant_nothingLeavesBeyondDeposits() public view {
        for (uint256 i = 0; i < 2; i++) {
            address t = address(tokens[i]);
            assertLe(handler.paidOut(t), handler.deposited(t), "paid out <= deposited");
            assertEq(handler.paidOut(t) + pool.shieldedBalance(t) + pool.protocolFeesAccrued(t), handler.deposited(t));
        }
    }

    function invariant_noDoubleSpend() public view {
        assertEq(handler.doubleSpendsAccepted(), 0, "a spent nullifier was accepted again");
    }
}
