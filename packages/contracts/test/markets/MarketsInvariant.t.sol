// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketsBase} from "./MarketsBase.sol";
import {CurveilRouter} from "../../src/markets/CurveilRouter.sol";
import {DammPool} from "../../src/markets/DammPool.sol";
import {DlmmPair} from "../../src/markets/DlmmPair.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

/// Drives random swaps, deposits, withdrawals, claims and time jumps against one DAMM pool and one DLMM pair.
contract MarketsHandler is Test {
    CurveilRouter internal router;
    DammPool public damm;
    DlmmPair public dlmm;
    address[3] internal actors;
    uint24 public lo;
    uint24 public hi;
    uint256 public dlmmAdds;
    uint256 public dlmmAddFailures;

    constructor(CurveilRouter router_, DammPool damm_, DlmmPair dlmm_, address[3] memory actors_) {
        router = router_;
        damm = damm_;
        dlmm = dlmm_;
        actors = actors_;
        lo = dlmm_.activeId() - 30;
        hi = dlmm_.activeId() + 30;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function swapDamm(uint256 seed, uint256 amount, bool zeroForOne) external {
        (address tin, address tout) = zeroForOne ? (damm.token0(), damm.token1()) : (damm.token1(), damm.token0());
        (uint128 r0, uint128 r1) = damm.getReserves();
        uint256 rIn = zeroForOne ? r0 : r1;
        amount = bound(amount, rIn / 1e6 + 1, rIn / 4 + 1);
        CurveilRouter.Hop[] memory h = new CurveilRouter.Hop[](1);
        h[0] = CurveilRouter.Hop(address(damm), tin, tout);
        try router.quoteExactIn(h, amount) returns (uint256 q, uint256[] memory) {
            if (q == 0) return;
        } catch {
            return;
        }
        address who = _actor(seed);
        vm.prank(who);
        router.swapExactIn(h, amount, 0, who, block.timestamp);
    }

    function addDamm(uint256 seed, uint256 amount) external {
        (uint128 r0, uint128 r1) = damm.getReserves();
        amount = bound(amount, 1, 1000);
        address who = _actor(seed);
        CurveilRouter.DammDeposit memory dep = CurveilRouter.DammDeposit(
            damm.token0(), damm.token1(), (r0 * amount) / 1000 + 1, (r1 * amount) / 1000 + 1, 0, 0, who, block.timestamp
        );
        vm.prank(who);
        router.addLiquidityDamm(dep);
    }

    function removeDamm(uint256 seed, uint256 fraction) external {
        address who = _actor(seed);
        uint256 lp = (damm.balanceOf(who) * bound(fraction, 1, 100)) / 100;
        if (lp == 0) return;
        (uint128 r0, uint128 r1) = damm.getReserves();
        if ((lp * r0) / damm.totalSupply() == 0 || (lp * r1) / damm.totalSupply() == 0) return;
        vm.startPrank(who);
        damm.approve(address(router), lp);
        router.removeLiquidityDamm(damm.token0(), damm.token1(), lp, 0, 0, who, block.timestamp);
        vm.stopPrank();
    }

    function claimDamm(uint256 seed) external {
        address who = _actor(seed);
        vm.prank(who);
        damm.claimFees(who);
    }

    function swapDlmm(uint256 seed, uint256 amount, bool sellX) external {
        (address tin, address tout) = sellX ? (dlmm.tokenX(), dlmm.tokenY()) : (dlmm.tokenY(), dlmm.tokenX());
        uint256 reserveIn = sellX ? dlmm.reserveY() : dlmm.reserveX();
        if (reserveIn == 0) return;
        amount = bound(amount, 1e3, TestToken(tin).balanceOf(_actor(seed)) / 1000);
        CurveilRouter.Hop[] memory h = new CurveilRouter.Hop[](1);
        h[0] = CurveilRouter.Hop(address(dlmm), tin, tout);
        try router.quoteExactIn(h, amount) returns (uint256 q, uint256[] memory) {
            if (q == 0) return;
        } catch {
            return;
        }
        address who = _actor(seed);
        vm.prank(who);
        router.swapExactIn(h, amount, 0, who, block.timestamp);
        _track(dlmm.activeId());
    }

    function addDlmm(uint256 seed, uint256 width, uint256 size) external {
        width = bound(width, 0, 8);
        size = bound(size, 1, 100);
        uint256 n = 2 * width + 1;
        int256[] memory d = new int256[](n);
        uint256[] memory dx = new uint256[](n);
        uint256[] memory dy = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            d[i] = int256(i) - int256(width);
            if (d[i] >= 0) dx[i] = 1e18 / (width + 1);
            if (d[i] <= 0) dy[i] = 1e18 / (width + 1);
        }
        uint24 active = dlmm.activeId();
        address who = _actor(seed);
        CurveilRouter.DlmmDeposit memory dep = CurveilRouter.DlmmDeposit(
            address(dlmm),
            TestToken(dlmm.tokenX()).balanceOf(who) / 10_000 * size / 100,
            TestToken(dlmm.tokenY()).balanceOf(who) / 10_000 * size / 100,
            active,
            0,
            d,
            dx,
            dy,
            who,
            block.timestamp
        );
        vm.prank(who);
        try router.addLiquidityDlmm(dep) {
            ++dlmmAdds;
            _track(active - uint24(width));
            _track(active + uint24(width));
        } catch {
            ++dlmmAddFailures;
        }
    }

    function removeDlmm(uint256 seed, uint256 fraction) external {
        address who = _actor(seed);
        fraction = bound(fraction, 1, 100);
        uint256 count;
        for (uint24 id = lo; id <= hi; ++id) {
            if (dlmm.getPosition(id, who).shares > 0) ++count;
        }
        if (count == 0) return;
        uint24[] memory ids = new uint24[](count);
        uint256[] memory shares = new uint256[](count);
        uint256 j;
        for (uint24 id = lo; id <= hi; ++id) {
            uint256 s = dlmm.getPosition(id, who).shares;
            if (s > 0) {
                ids[j] = id;
                shares[j] = fraction == 100 ? s : (s * fraction) / 100;
                if (shares[j] == 0) shares[j] = s;
                ++j;
            }
        }
        vm.prank(who);
        dlmm.removeLiquidity(who, ids, shares, 0, 0, block.timestamp);
    }

    function claimDlmm(uint256 seed) external {
        address who = _actor(seed);
        uint24[] memory ids = new uint24[](hi - lo + 1);
        for (uint24 id = lo; id <= hi; ++id) {
            ids[id - lo] = id;
        }
        vm.prank(who);
        dlmm.claimFees(who, ids);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 1200));
    }

    function _track(uint24 id) internal {
        if (id < lo + 10) lo = id - 10;
        if (id + 10 > hi) hi = id + 10;
    }
}

contract MarketsInvariantTest is MarketsBase {
    MarketsHandler internal handler;
    DammPool internal damm;
    DlmmPair internal dlmm;

    function setUp() public override {
        super.setUp();
        damm = _dammPool(address(usdg), address(weth), 1_000_000e6, 500e18);
        dlmm = _dlmmWethUsdg(10, 10);
        handler = new MarketsHandler(router, damm, dlmm, [alice, bob, carol]);
        // The handler pranks as the actors; actors already approved the router.
        targetContract(address(handler));
    }

    function invariant_dammSolvent() public view {
        (uint128 r0, uint128 r1) = damm.getReserves();
        assertGe(TestToken(damm.token0()).balanceOf(address(damm)), uint256(r0) + damm.lpFees0() + damm.protocolFees0());
        assertGe(TestToken(damm.token1()).balanceOf(address(damm)), uint256(r1) + damm.lpFees1() + damm.protocolFees1());
    }

    function invariant_dammClaimsCovered() public view {
        uint256 s0;
        uint256 s1;
        for (uint256 i; i < 3; ++i) {
            (uint256 a, uint256 b) = damm.pendingFees(handler.actorAt(i));
            s0 += a;
            s1 += b;
        }
        assertLe(s0, damm.lpFees0(), "LP claims never exceed LP fees held (token0)");
        assertLe(s1, damm.lpFees1(), "LP claims never exceed LP fees held (token1)");
    }

    function invariant_dammFeeBounded() public view {
        assertLe(damm.currentFeeBps(), damm.feeParams().maxFeeBps);
        assertGe(damm.currentFeeBps(), damm.feeParams().baseFeeBps);
    }

    function invariant_dlmmBinsMatchReserves() public view {
        (uint256 sx, uint256 sy) = _sumBins(dlmm, handler.lo(), handler.hi());
        assertEq(sx, dlmm.reserveX());
        assertEq(sy, dlmm.reserveY());
    }

    function invariant_dlmmSolventAndClaimsCovered() public view {
        TestToken x = TestToken(dlmm.tokenX());
        TestToken y = TestToken(dlmm.tokenY());
        assertGe(x.balanceOf(address(dlmm)), uint256(dlmm.reserveX()) + dlmm.lpFeesX() + dlmm.protocolFeesX());
        assertGe(y.balanceOf(address(dlmm)), uint256(dlmm.reserveY()) + dlmm.lpFeesY() + dlmm.protocolFeesY());

        uint24 lo = handler.lo();
        uint24 hi = handler.hi();
        uint24[] memory ids = new uint24[](hi - lo + 1);
        for (uint24 id = lo; id <= hi; ++id) {
            ids[id - lo] = id;
        }
        uint256 px;
        uint256 py;
        for (uint256 i; i < 3; ++i) {
            (uint256 a, uint256 b) = dlmm.pendingFees(handler.actorAt(i), ids);
            px += a;
            py += b;
        }
        assertLe(px, dlmm.lpFeesX());
        assertLe(py, dlmm.lpFeesY());
    }

    function afterInvariant() external view {
        // Most deposits must land; a failure here means the handler is not exercising deposits.
        assertGe(handler.dlmmAdds(), handler.dlmmAddFailures());
    }

    function invariant_dlmmCompositionAroundActive() public view {
        uint24 a = dlmm.activeId();
        for (uint24 id = handler.lo(); id <= handler.hi(); ++id) {
            DlmmPair.Bin memory b = dlmm.getBin(id);
            if (id < a) assertEq(b.x, 0, "below active: Y only");
            if (id > a) assertEq(b.y, 0, "above active: X only");
        }
    }
}
