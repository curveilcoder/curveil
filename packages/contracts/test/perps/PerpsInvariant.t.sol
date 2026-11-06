// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PerpsBase} from "./PerpsBase.sol";
import {PerpEngine} from "../../src/perps/PerpEngine.sol";
import {PerpLiquidityVault} from "../../src/perps/PerpLiquidityVault.sol";
import {SignedReportVerifier} from "../../src/perps/oracle/SignedReportVerifier.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

/// @notice Drives random trading against the engine: opens, closes, price moves, funding over
///         time, liquidations, timed-out requests and provider flows.
contract PerpsHandler is Test {
    PerpEngine engine;
    PerpLiquidityVault vault;
    SignedReportVerifier verifier;
    TestToken usdg;
    uint256 signerPk;
    bytes32 feed;
    uint32 market;
    address[] traders;
    address keeper = address(0xBEEF);
    uint256 public price = 2_000e18;
    uint256[] public positions;
    uint256 public opened;
    uint256 public liquidations;

    constructor(
        PerpEngine e,
        SignedReportVerifier v,
        TestToken t,
        uint256 pk,
        bytes32 f,
        uint32 m,
        address[] memory ts
    ) {
        engine = e;
        vault = e.vault();
        verifier = v;
        usdg = t;
        signerPk = pk;
        feed = f;
        market = m;
        traders = ts;
    }

    function _report() internal returns (bytes memory) {
        vm.warp(block.timestamp + 1);
        bytes32 digest = verifier.reportDigest(feed, price, uint64(block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encode(feed, price, uint64(block.timestamp), abi.encodePacked(r, s, v));
    }

    function open(uint256 who, bool isLong, uint256 size, uint256 leverageBps) external {
        address t = traders[who % traders.length];
        size = bound(size, 20e6, 50_000e6);
        leverageBps = bound(leverageBps, 10_000, 48_000);
        uint256 collateral = (size * 10_000) / leverageBps + 1e6;
        if (usdg.balanceOf(t) < collateral + 1e6) return;
        vm.prank(t);
        (uint256 rid, uint256 pid) = engine.requestOpen(
            market, isLong, uint128(size), uint128(collateral), isLong ? type(uint256).max : 0, 200_000
        );
        bytes memory r = _report();
        vm.prank(keeper);
        engine.executeRequest(rid, r);
        if (engine.position(pid).status == PerpEngine.Status.Open) {
            positions.push(pid);
            opened++;
        }
    }

    function leavePending(uint256 who, uint256 size) external {
        address t = traders[who % traders.length];
        size = bound(size, 20e6, 5_000e6);
        if (usdg.balanceOf(t) < size) return;
        vm.prank(t);
        engine.requestOpen(market, true, uint128(size), uint128(size), type(uint256).max, 200_000);
    }

    function cancelStale(uint256 i) external {
        uint256[] memory ids = engine.pendingRequests(0, 50);
        if (ids.length == 0) return;
        vm.warp(block.timestamp + 121);
        engine.cancelRequest(ids[i % ids.length]);
    }

    function close(uint256 i, uint256 fraction) external {
        if (positions.length == 0) return;
        uint256 pid = positions[i % positions.length];
        PerpEngine.Position memory p = engine.position(pid);
        if (p.status != PerpEngine.Status.Open || p.pendingClose != 0) return;
        fraction = bound(fraction, 1, 10_000);
        vm.prank(p.owner);
        uint256 rid = engine.requestClose(
            pid, uint128((uint256(p.size) * fraction) / 10_000) + 1, p.isLong ? 0 : type(uint256).max, 200_000
        );
        bytes memory r = _report();
        vm.prank(keeper);
        engine.executeRequest(rid, r);
    }

    function addCollateral(uint256 i, uint256 amount) external {
        if (positions.length == 0) return;
        uint256 pid = positions[i % positions.length];
        PerpEngine.Position memory p = engine.position(pid);
        if (p.status != PerpEngine.Status.Open) return;
        amount = bound(amount, 1, 1_000e6);
        if (usdg.balanceOf(p.owner) < amount) return;
        vm.prank(p.owner);
        engine.addCollateral(pid, uint128(amount));
    }

    function movePrice(uint256 bps, bool up) external {
        bps = bound(bps, 1, 1_500);
        price = up ? (price * (10_000 + bps)) / 10_000 : (price * (10_000 - bps)) / 10_000;
        if (price < 100e18) price = 100e18;
    }

    function passTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
        engine.updateFunding(market);
    }

    function liquidateAll() external {
        bytes memory r = _report();
        uint256[] memory ids = engine.openPositions(0, 200);
        for (uint256 i = 0; i < ids.length; i++) {
            try engine.liquidate(ids[i], r) {
                liquidations++;
            } catch {}
        }
    }

    function provide(uint256 amount, bool withdraw) external {
        address lp = traders[0];
        bytes memory r = _report();
        engine.oracle().submit(r);
        if (withdraw) {
            uint256 shares = bound(amount, 1, vault.balanceOf(lp) + 1);
            if (shares > vault.balanceOf(lp)) return;
            if (block.timestamp < vault.unlockAt(lp)) vm.warp(vault.unlockAt(lp));
            engine.oracle().submit(_report());
            if (vault.previewRedeem(shares) > vault.freeLiquidity() || vault.previewRedeem(shares) == 0) return;
            vm.prank(lp);
            vault.redeem(shares, 0, lp);
        } else {
            amount = bound(amount, 1e6, 10_000e6);
            if (usdg.balanceOf(lp) < amount) return;
            vm.prank(lp);
            vault.deposit(amount, 0);
        }
    }

    function positionCount() external view returns (uint256) {
        return positions.length;
    }
}

contract PerpsInvariantTest is PerpsBase {
    PerpsHandler handler;

    function setUp() public override {
        super.setUp();
        address[] memory ts = new address[](3);
        ts[0] = lp;
        ts[1] = alice;
        ts[2] = bob;
        handler = new PerpsHandler(engine, verifier, usdg, signerPk, ETH, M_ETH, ts);
        targetContract(address(handler));
    }

    /// @dev Every USDG the engine holds is someone's collateral or escrow: no more, no less.
    function invariant_EngineHoldsExactlyCollateral() public view {
        assertEq(usdg.balanceOf(address(engine)), engine.totalCollateral());
    }

    /// @dev Payouts never exceed vault capacity: what is reserved is always there.
    function invariant_VaultCoversReserves() public view {
        assertGe(usdg.balanceOf(address(vault)), engine.totalReserved());
    }

    /// @dev Aggregates match the positions they summarise.
    function invariant_AggregatesMatchPositions() public view {
        uint256 longs;
        uint256 shorts;
        uint256 reserved;
        uint256 collateral;
        uint256[] memory ids = engine.openPositions(0, 1_000);
        for (uint256 i = 0; i < ids.length; i++) {
            PerpEngine.Position memory p = engine.position(ids[i]);
            if (p.isLong) longs += p.size;
            else shorts += p.size;
            reserved += p.reserve;
            collateral += p.collateral;
        }
        uint256[] memory pending = engine.pendingRequests(0, 1_000);
        for (uint256 i = 0; i < pending.length; i++) {
            PerpEngine.Request memory r = engine.request(pending[i]);
            if (r.kind == PerpEngine.Kind.Open) collateral += uint256(r.collateral) + r.executionFee;
        }
        PerpEngine.MarketState memory s = engine.marketState(M_ETH);
        assertEq(s.oiLong, longs, "long open interest");
        assertEq(s.oiShort, shorts, "short open interest");
        assertEq(engine.totalReserved(), reserved, "reserves");
        assertEq(s.reservedLong + s.reservedShort, reserved, "per-side reserves");
        assertEq(engine.totalCollateral(), collateral, "collateral and escrow");
    }

    /// @dev Positions that are no longer live never come back.
    function invariant_RetiredPositionsStayRetired() public view {
        uint256 n = handler.positionCount();
        for (uint256 i = 0; i < n; i++) {
            PerpEngine.Position memory p = engine.position(handler.positions(i));
            if (p.status != PerpEngine.Status.Open) {
                assertEq(p.size, 0);
                assertEq(p.collateral, 0);
                assertEq(p.reserve, 0);
            }
        }
    }
}
