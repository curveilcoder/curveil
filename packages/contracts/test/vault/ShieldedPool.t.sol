// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, stdJson} from "forge-std/Test.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT5} from "poseidon-solidity/PoseidonT5.sol";
import {AssetRegistry} from "../../src/shared/AssetRegistry.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {ShieldedPool} from "../../src/vault/ShieldedPool.sol";
import {IGroth16Verifier9} from "../../src/vault/interfaces/IGroth16Verifier9.sol";
import {TransferVerifier} from "../../src/vault/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../../src/vault/verifiers/WithdrawVerifier.sol";

/// @notice ShieldedPool against real Groth16 proofs from test/fixtures/vault.json
///         (packages/vault-core/scripts/gen-pool-fixture.ts).
contract ShieldedPoolTest is Test {
    using stdJson for string;

    uint256 constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    string json;
    AssetRegistry registry;
    TestToken token;
    ShieldedPool pool;
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address depositor = makeAddr("depositor");
    address broadcaster;
    address recipient;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/vault.json"));
        broadcaster = json.readAddress(".broadcaster");
        recipient = json.readAddress(".recipient");

        registry = new AssetRegistry(address(this));
        vm.prank(json.readAddress(".tokenDeployer"));
        token = new TestToken("Test USDG", "tUSDG", 6, address(this));
        assertEq(address(token), json.readAddress(".token"), "token address drifted from fixture");

        IGroth16Verifier9 tv = IGroth16Verifier9(address(new TransferVerifier()));
        IGroth16Verifier9 wv = IGroth16Verifier9(address(new WithdrawVerifier()));
        vm.prank(json.readAddress(".poolDeployer"));
        pool = new ShieldedPool(address(this), registry, tv, wv, uint16(json.readUint(".withdrawFeeBps")), treasury);
        assertEq(address(pool), json.readAddress(".pool"), "pool address drifted from fixture");

        registry.admit(address(token), "USDG");
        pool.configureAsset(address(token), true, 0);
        pool.setGuardian(guardian);

        token.mint(depositor, 10_000e6);
        vm.prank(depositor);
        token.approve(address(pool), type(uint256).max);
    }

    // ------------------------------------------------------------ fixture readers

    function _proof(string memory k) internal view returns (ShieldedPool.Proof memory p) {
        p.a = [json.readUint(string.concat(k, ".proof.a[0]")), json.readUint(string.concat(k, ".proof.a[1]"))];
        p.b = [
            [json.readUint(string.concat(k, ".proof.b[0][0]")), json.readUint(string.concat(k, ".proof.b[0][1]"))],
            [json.readUint(string.concat(k, ".proof.b[1][0]")), json.readUint(string.concat(k, ".proof.b[1][1]"))]
        ];
        p.c = [json.readUint(string.concat(k, ".proof.c[0]")), json.readUint(string.concat(k, ".proof.c[1]"))];
    }

    function _transferArgs() internal view returns (ShieldedPool.TransferArgs memory a) {
        a.root = json.readUint(".transfer.root");
        a.nullifiers = [json.readUint(".transfer.nullifiers[0]"), json.readUint(".transfer.nullifiers[1]")];
        a.commitments = [json.readUint(".transfer.commitments[0]"), json.readUint(".transfer.commitments[1]")];
        a.fee = json.readUint(".transfer.fee");
        a.feeResource = json.readUint(".transfer.feeResource");
        a.feeRecipient = json.readAddress(".transfer.feeRecipient");
        a.deadline = json.readUint(".transfer.deadline");
        a.encryptedNote0 = json.readBytes(".transfer.encryptedNote0");
        a.encryptedNote1 = json.readBytes(".transfer.encryptedNote1");
    }

    function _withdrawArgs(string memory k) internal view returns (ShieldedPool.WithdrawArgs memory a) {
        a.root = json.readUint(string.concat(k, ".root"));
        a.nullifiers =
            [json.readUint(string.concat(k, ".nullifiers[0]")), json.readUint(string.concat(k, ".nullifiers[1]"))];
        a.commitment = json.readUint(string.concat(k, ".commitment"));
        a.token = json.readAddress(string.concat(k, ".token"));
        a.amount = json.readUint(string.concat(k, ".amount"));
        a.fee = json.readUint(string.concat(k, ".fee"));
        a.recipient = json.readAddress(string.concat(k, ".recipient"));
        a.feeRecipient = json.readAddress(string.concat(k, ".feeRecipient"));
        a.deadline = json.readUint(string.concat(k, ".deadline"));
        a.encryptedChange = json.readBytes(string.concat(k, ".encryptedChange"));
    }

    function _shieldBoth() internal {
        for (uint256 i = 0; i < 2; i++) {
            string memory k = string.concat(".shields[", vm.toString(i), "]");
            vm.prank(depositor);
            uint32 leaf = pool.shield(
                address(token),
                json.readUint(string.concat(k, ".amount")),
                json.readUint(string.concat(k, ".ownerHash")),
                json.readBytes(string.concat(k, ".encryptedNote"))
            );
            assertEq(leaf, i);
        }
    }

    function _transfer() internal {
        pool.transfer(_proof(".transfer"), _transferArgs());
    }

    function _assertSolvent() internal view {
        assertGe(
            token.balanceOf(address(pool)),
            pool.shieldedBalance(address(token)) + pool.protocolFeesAccrued(address(token)),
            "pool under-backed"
        );
    }

    // ------------------------------------------------------------ hashing

    function test_PoseidonMatchesCircomlibAndZeros() public pure {
        assertEq(
            PoseidonT3.hash([uint256(1), 2]),
            7853200120776062878684798364095072458815029376092732009249414926327459813530
        );
        assertEq(
            PoseidonT5.hash([uint256(1), 2, 3, 4]),
            18821383157269793795438455681495246036402687001665670618754263018637548127333
        );
    }

    function test_ZerosChain() public view {
        assertEq(pool.zeros(0), uint256(keccak256("curveil.vault.zero")) % P);
        for (uint256 i = 0; i < 24; i++) {
            assertEq(pool.zeros(i + 1), PoseidonT3.hash([pool.zeros(i), pool.zeros(i)]));
        }
        assertEq(pool.getLastRoot(), pool.zeros(24));
    }

    function test_DomainAndResourceMatchClient() public view {
        assertEq(pool.noteDomain(), json.readUint(".domain"));
        assertEq(pool.resourceOf(address(token)), json.readUint(".resource"));
        assertEq(pool.assetConfig(address(token)).resource, json.readUint(".resource"));
    }

    // ------------------------------------------------------------ full cycle

    function test_FullCycle() public {
        _shieldBoth();
        assertEq(pool.nextLeafIndex(), 2);
        assertEq(pool.shieldedBalance(address(token)), 1_500e6);

        _transfer();
        assertEq(token.balanceOf(broadcaster), 1e6, "transfer fee");
        assertEq(pool.nextLeafIndex(), 4);
        assertEq(pool.shieldedBalance(address(token)), 1_499e6);

        pool.withdraw(_proof(".withdraw"), _withdrawArgs(".withdraw"));
        uint256 protocolFee = json.readUint(".withdraw.protocolFee");
        assertEq(protocolFee, 700_000);
        assertEq(token.balanceOf(recipient), 700e6 - protocolFee);
        assertEq(token.balanceOf(broadcaster), 1e6 + 500_000);
        assertEq(pool.protocolFeesAccrued(address(token)), protocolFee);

        pool.withdraw(_proof(".withdraw2"), _withdrawArgs(".withdraw2"));
        assertEq(pool.nextLeafIndex(), 6);
        assertEq(pool.getLastRoot(), json.readUint(".finalRoot"), "root differs from the client tree");
        // Bob's 499.5 change is all that remains shielded.
        assertEq(pool.shieldedBalance(address(token)), 499_500_000);
        _assertSolvent();

        uint256 accrued = pool.protocolFeesAccrued(address(token));
        pool.claimProtocolFees(address(token));
        assertEq(token.balanceOf(treasury), accrued);
        assertEq(token.balanceOf(address(pool)), 499_500_000);
        _assertSolvent();
    }

    function test_EventsCarryCommitmentAndCiphertext() public {
        string memory k = ".shields[0]";
        bytes memory enc = json.readBytes(string.concat(k, ".encryptedNote"));
        vm.expectEmit(address(pool));
        emit ShieldedPool.NoteCommitted(0, json.readUint(string.concat(k, ".commitment")), enc);
        vm.prank(depositor);
        pool.shield(
            address(token),
            json.readUint(string.concat(k, ".amount")),
            json.readUint(string.concat(k, ".ownerHash")),
            enc
        );
    }

    // ------------------------------------------------------------ double spend and binding

    function test_ReplayRejected() public {
        _shieldBoth();
        _transfer();
        ShieldedPool.TransferArgs memory a = _transferArgs();
        ShieldedPool.Proof memory p = _proof(".transfer");
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.NullifierAlreadySpent.selector, a.nullifiers[0]));
        pool.transfer(p, a);
    }

    function test_TransferBindings() public {
        _shieldBoth();
        ShieldedPool.Proof memory p = _proof(".transfer");

        ShieldedPool.TransferArgs memory a = _transferArgs();
        a.feeRecipient = makeAddr("thief");
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(p, a);

        a = _transferArgs();
        a.encryptedNote0[40] = bytes1(uint8(a.encryptedNote0[40]) ^ 1);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(p, a);

        a = _transferArgs();
        a.fee = a.fee + 1;
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(p, a);

        a = _transferArgs();
        (a.commitments[0], a.commitments[1]) = (a.commitments[1], a.commitments[0]);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(p, a);

        a = _transferArgs();
        a.deadline = a.deadline + 1;
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(p, a);

        // A corrupted proof point.
        a = _transferArgs();
        ShieldedPool.Proof memory bad = _proof(".transfer");
        bad.a[0] = bad.a[0] ^ 1;
        vm.expectRevert();
        pool.transfer(bad, a);

        // The untouched proof still works.
        pool.transfer(p, _transferArgs());
    }

    function test_WithdrawBindings() public {
        _shieldBoth();
        _transfer();
        ShieldedPool.Proof memory p = _proof(".withdraw");

        ShieldedPool.WithdrawArgs memory a = _withdrawArgs(".withdraw");
        a.recipient = makeAddr("thief");
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(p, a);

        a = _withdrawArgs(".withdraw");
        a.amount = a.amount + 1;
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(p, a);

        a = _withdrawArgs(".withdraw");
        a.feeRecipient = makeAddr("thief");
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(p, a);

        // A fee-rate change invalidates proofs made under the old rate.
        pool.setWithdrawFeeBps(20);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(p, _withdrawArgs(".withdraw"));
        pool.setWithdrawFeeBps(10);
        pool.withdraw(p, _withdrawArgs(".withdraw"));
    }

    function test_ChainBinding() public {
        _shieldBoth();
        vm.chainId(4663);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.transfer(_proof(".transfer"), _transferArgs());
    }

    function test_DeadlineAndRoot() public {
        _shieldBoth();
        ShieldedPool.TransferArgs memory a = _transferArgs();
        vm.warp(a.deadline + 1);
        vm.expectRevert(ShieldedPool.Expired.selector);
        pool.transfer(_proof(".transfer"), a);

        vm.warp(1);
        a.root = 12345;
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.transfer(_proof(".transfer"), a);
    }

    function test_FeeTermsMustBeCanonical() public {
        _shieldBoth();
        _transfer();
        pool.withdraw(_proof(".withdraw"), _withdrawArgs(".withdraw"));
        ShieldedPool.WithdrawArgs memory a = _withdrawArgs(".withdraw2");
        a.feeRecipient = broadcaster; // fee is zero
        vm.expectRevert(ShieldedPool.BadFeeTerms.selector);
        pool.withdraw(_proof(".withdraw2"), a);
    }

    // ------------------------------------------------------------ shielding rules

    function test_ShieldRules() public {
        bytes memory enc = json.readBytes(".shields[0].encryptedNote");
        vm.startPrank(depositor);
        vm.expectRevert(ShieldedPool.BadAmount.selector);
        pool.shield(address(token), 0, 1, enc);
        vm.expectRevert(ShieldedPool.NotAFieldElement.selector);
        pool.shield(address(token), 1, P, enc);
        vm.expectRevert(ShieldedPool.BadCiphertext.selector);
        pool.shield(address(token), 1, 1, hex"01");
        TestToken other = new TestToken("Other", "OTH", 18, depositor);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.AssetNotShieldable.selector, address(other)));
        pool.shield(address(other), 1, 1, enc);
        vm.stopPrank();

        pool.configureAsset(address(token), true, 100e6);
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.DepositAboveCap.selector, 100e6));
        pool.shield(address(token), 101e6, 1, enc);
    }

    function test_SuspendedAssetStillExits() public {
        _shieldBoth();
        _transfer();
        registry.suspend(address(token));
        pool.configureAsset(address(token), false, 0);
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.AssetNotShieldable.selector, address(token)));
        pool.shield(address(token), 1e6, 1, json.readBytes(".shields[0].encryptedNote"));
        pool.withdraw(_proof(".withdraw"), _withdrawArgs(".withdraw"));
        assertGt(token.balanceOf(recipient), 0);
    }

    // ------------------------------------------------------------ admin

    function test_PauseControls() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ShieldedPool.NotGuardian.selector);
        pool.pause(true, true);

        vm.prank(guardian);
        pool.pause(true, true);
        vm.prank(guardian);
        vm.expectRevert();
        pool.unpause(true, true);

        vm.prank(depositor);
        vm.expectRevert(ShieldedPool.ShieldingPaused.selector);
        pool.shield(address(token), 1e6, 1, json.readBytes(".shields[0].encryptedNote"));
        vm.expectRevert(ShieldedPool.SpendingPaused.selector);
        pool.transfer(_proof(".transfer"), _transferArgs());

        pool.unpause(true, true);
        _shieldBoth();
        _transfer();
    }

    /// A spending pause also stops exits, so it must end on its own and cannot be chained.
    function test_SpendPauseExpiresAndCannotBeChained() public {
        _shieldBoth();
        vm.prank(guardian);
        pool.pause(false, true);
        assertTrue(pool.spendPaused());
        uint256 until = pool.spendPausedUntil();
        assertEq(until, block.timestamp + 72 hours);

        // Calling again does not extend it.
        vm.warp(block.timestamp + 70 hours);
        vm.prank(guardian);
        pool.pause(false, true);
        assertEq(pool.spendPausedUntil(), until);

        // It ends by itself and exits work again.
        vm.warp(until);
        assertFalse(pool.spendPaused());
        _transfer();

        // No new spending pause until 24 hours after the last one ended.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.PauseGap.selector, until + 24 hours));
        pool.pause(false, true);
        // A shielding pause is still allowed in the gap.
        vm.prank(guardian);
        pool.pause(true, false);
        assertTrue(pool.shieldPaused());

        vm.warp(until + 24 hours);
        vm.prank(guardian);
        pool.pause(false, true);
        assertTrue(pool.spendPaused());
    }

    /// Ending a pause early starts the gap too, so the owner and guardian cannot chain pauses.
    function test_EarlyUnpauseStartsTheGap() public {
        vm.prank(guardian);
        pool.pause(false, true);
        vm.warp(block.timestamp + 1 hours);
        pool.unpause(false, true);
        assertFalse(pool.spendPaused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPool.PauseGap.selector, block.timestamp + 24 hours));
        pool.pause(false, true);
    }

    function test_FeeCapAndOwnership() public {
        vm.expectRevert(ShieldedPool.FeeTooHigh.selector);
        pool.setWithdrawFeeBps(101);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        pool.setWithdrawFeeBps(5);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        pool.configureAsset(address(token), true, 0);
    }

    function test_ClaimNeedsAccruedFees() public {
        vm.expectRevert(ShieldedPool.NothingToClaim.selector);
        pool.claimProtocolFees(address(token));
    }
}
