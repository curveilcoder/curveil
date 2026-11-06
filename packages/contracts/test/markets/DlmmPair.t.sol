// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {MarketsBase} from "./MarketsBase.sol";
import {LiquidityShapes} from "../../src/markets/libraries/LiquidityShapes.sol";
import {DlmmPair} from "../../src/markets/DlmmPair.sol";
import {DlmmFactory} from "../../src/markets/DlmmFactory.sol";
import {CurveilRouter} from "../../src/markets/CurveilRouter.sol";
import {BinMath} from "../../src/markets/libraries/BinMath.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

contract DlmmPairTest is MarketsBase {
    DlmmPair internal pair;
    uint24 internal start;
    uint256 internal constant K = 10;

    function setUp() public override {
        super.setUp();
        pair = _dlmmWethUsdg(10, K);
        start = pair.activeId();
    }

    function _x() internal view returns (TestToken) {
        return TestToken(pair.tokenX());
    }

    function _y() internal view returns (TestToken) {
        return TestToken(pair.tokenY());
    }

    function test_activeIdMatchesInitialPrice() public view {
        // Price of WETH in USDG is 2000; in raw Y per raw X it is either 2e-9 or its inverse.
        uint256 p = pair.getPrice(start);
        uint256 expected = pair.tokenX() == address(weth) ? _rawPrice(2000e6, 18, 6) : _rawPrice(500, 6, 18);
        assertLe(p, expected * 1001 / 1000 + 1);
        assertGe(p, expected * 999 / 1000);
    }

    function test_balancedShapeRespectsComposition() public view {
        for (uint24 id = start - uint24(K); id <= start + uint24(K); ++id) {
            DlmmPair.Bin memory b = pair.getBin(id);
            if (id < start) {
                assertEq(b.x, 0, "below active holds Y only");
                assertGt(b.y, 0);
            } else if (id > start) {
                assertEq(b.y, 0, "above active holds X only");
                assertGt(b.x, 0);
            } else {
                assertGt(b.x, 0);
                assertGt(b.y, 0);
            }
        }
        _assertAccounting();
    }

    function test_shapesAllocateAsDescribed() public {
        DlmmPair p2 = _newPair(25);
        (uint256 ax, uint256 ay) = _amounts(p2, 50e18, 100_000e6);
        _addDlmm(bob, p2, ax, ay, LiquidityShapes.Shape.Concentrated, 5);
        uint24 a = p2.activeId();
        assertGt(p2.getBin(a - 1).y, p2.getBin(a - 5).y, "concentrated: more near the active bin");
        assertGt(p2.getBin(a + 1).x, p2.getBin(a + 5).x);

        DlmmPair p3 = _newPair(100);
        (ax, ay) = _amounts(p3, 50e18, 100_000e6);
        _addDlmm(bob, p3, ax, ay, LiquidityShapes.Shape.EdgeWeighted, 5);
        uint24 a3 = p3.activeId();
        assertGt(p3.getBin(a3 - 5).y, p3.getBin(a3 - 1).y, "edge-weighted: more at the range edge");
        assertGt(p3.getBin(a3 + 5).x, p3.getBin(a3 + 1).x);
    }

    function _newPair(uint16 step) internal returns (DlmmPair) {
        uint24 id = _idForPrice(_rawPrice(2000e6, 18, 6), step);
        return DlmmPair(dlmmFactory.createPair(address(weth), address(usdg), step, id));
    }

    /// Orders a (WETH, USDG) amount pair as (X, Y) for `p`.
    function _amounts(DlmmPair p, uint256 wethAmt, uint256 usdgAmt) internal view returns (uint256, uint256) {
        return p.tokenX() == address(weth) ? (wethAmt, usdgAmt) : (usdgAmt, wethAmt);
    }

    function test_swapCrossesBinsAndQuoteMatches() public {
        // Sell enough X to walk down several bins.
        uint256 amountIn = pair.tokenX() == address(weth) ? 30e18 : 60_000e6;
        (uint256 quoted, uint256 fee) = pair.quote(pair.tokenX(), amountIn);
        uint256 out = _swap(bob, address(pair), pair.tokenX(), pair.tokenY(), amountIn);
        assertEq(out, quoted, "quote equals swap");
        assertGt(fee, 0);
        assertLt(pair.activeId(), start, "selling X moves the active bin down");
        // Bins passed through now hold X only.
        DlmmPair.Bin memory passed = pair.getBin(start - 1);
        assertEq(passed.y, 0);
        assertGt(passed.x, 0);
        _assertAccounting();
    }

    function testFuzz_quoteEqualsSwap(uint256 amountIn, bool sellX) public {
        (address tin, address tout) = sellX ? (pair.tokenX(), pair.tokenY()) : (pair.tokenY(), pair.tokenX());
        bool tinIsWeth = tin == address(weth);
        amountIn = bound(amountIn, tinIsWeth ? 1e12 : 1e3, tinIsWeth ? 45e18 : 90_000e6);
        (uint256 quoted,) = pair.quote(tin, amountIn);
        vm.assume(quoted > 0);
        uint256 out = _swap(bob, address(pair), tin, tout, amountIn);
        assertEq(out, quoted);
        _assertAccounting();
    }

    function test_feesAccrueOnlyInTradedBins() public {
        // Carol provides Y far below the market; Bob's small trade stays in the active bin.
        uint24 farId = start - 50;
        _addSingle(carol, farId, 0, pair.tokenY() == address(usdg) ? 10_000e6 : 5e18);
        uint256 small = pair.tokenX() == address(weth) ? 0.1e18 : 200e6;
        _swap(bob, address(pair), pair.tokenX(), pair.tokenY(), small);
        uint24[] memory far = new uint24[](1);
        far[0] = farId;
        (uint256 fx, uint256 fy) = pair.pendingFees(carol, far);
        assertEq(fx + fy, 0, "idle bins earn nothing");

        uint24[] memory act = new uint24[](1);
        act[0] = start;
        (uint256 ax,) = pair.pendingFees(alice, act);
        assertGt(ax, 0, "the active bin's LPs earn the fee");
    }

    function test_protocolShareIsTwentyPercent() public {
        uint256 small = pair.tokenX() == address(weth) ? 1e18 : 2_000e6;
        vm.recordLogs();
        _swap(bob, address(pair), pair.tokenX(), pair.tokenY(), small);
        uint256 total = pair.lpFeesX() + pair.protocolFeesX();
        assertApproxEqAbs(pair.protocolFeesX(), total / 5, 1);
        pair.collectProtocolFees();
        assertEq(_x().balanceOf(feeTo), total / 5 + (pair.protocolFeesX()));
    }

    function test_claimAndWithdrawEverything() public {
        uint256 amt = pair.tokenX() == address(weth) ? 5e18 : 10_000e6;
        _swap(bob, address(pair), pair.tokenX(), pair.tokenY(), amt);
        _swap(bob, address(pair), pair.tokenY(), pair.tokenX(), pair.tokenY() == address(usdg) ? 10_000e6 : 5e18);

        (uint24[] memory ids, uint256[] memory shares) = _alicePosition();
        vm.startPrank(alice);
        pair.claimFees(alice, ids);
        pair.removeLiquidity(alice, ids, shares, 0, 0, block.timestamp);
        vm.stopPrank();

        assertEq(pair.reserveX(), 0);
        assertEq(pair.reserveY(), 0);
        assertEq(pair.lpFeesX(), _x().balanceOf(address(pair)) - pair.protocolFeesX(), "only dust of rounding stays");
        (bool found,) = pair.nextNonEmptyBin(true, type(uint24).max);
        assertFalse(found, "bitmap is empty");
    }

    function test_activeBinDepositIsMatchedToItsProportion() public {
        DlmmPair.Bin memory b = pair.getBin(start);
        uint256 xIn = pair.tokenX() == address(weth) ? 1e18 : 2_000e6;
        uint256 yIn = 1; // effectively X only
        uint256 xBefore = _x().balanceOf(bob);
        _addSingle(bob, start, xIn, yIn);
        uint256 spentX = xBefore - _x().balanceOf(bob);
        // The bin takes X only in proportion to the Y offered; the rest is refunded.
        assertLe(spentX, (yIn * b.x) / b.y + 1);
    }

    function test_noFreeSwapThroughActiveBin() public {
        uint256 xIn = pair.tokenX() == address(weth) ? 10e18 : 20_000e6;
        uint256 yIn = pair.tokenY() == address(usdg) ? 20_000e6 : 10e18;
        uint256 x0 = _x().balanceOf(bob);
        uint256 y0 = _y().balanceOf(bob);
        uint256[] memory minted = _addSingle(bob, start, xIn, yIn);
        uint24[] memory ids = new uint24[](1);
        ids[0] = start;
        vm.prank(bob);
        pair.removeLiquidity(bob, ids, minted, 0, 0, block.timestamp);
        assertLe(_x().balanceOf(bob), x0, "no X gained");
        assertLe(_y().balanceOf(bob), y0, "no Y gained");
    }

    function test_revertWhen_compositionViolated() public {
        // X placed below the active bin.
        int256[] memory d = new int256[](1);
        d[0] = -1;
        uint256[] memory dx = new uint256[](1);
        dx[0] = 1e18;
        uint256[] memory dy = new uint256[](1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DlmmPair.CompositionViolation.selector, start - 1));
        router.addLiquidityDlmm(_deposit(bob, 1e9, 0, d, dx, dy, start, 0));
    }

    function test_revertWhen_activeIdMoved() public {
        _swap(bob, address(pair), pair.tokenX(), pair.tokenY(), pair.tokenX() == address(weth) ? 30e18 : 60_000e6);
        (int256[] memory d, uint256[] memory dx, uint256[] memory dy) = _shape(LiquidityShapes.Shape.Balanced, 2);
        uint24 moved = pair.activeId();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DlmmPair.ActiveIdSlippage.selector, start, moved));
        router.addLiquidityDlmm(_deposit(bob, 1e9, 1e9, d, dx, dy, start, 0));
    }

    function test_revertWhen_liquidityRunsOut() public {
        uint256 huge = pair.tokenX() == address(weth) ? 10_000e18 : 100_000_000e6;
        address tx_ = pair.tokenX();
        vm.expectRevert(DlmmPair.InsufficientLiquidity.selector);
        pair.quote(tx_, huge);
    }

    function test_transferSharesMovesFutureFees() public {
        (uint24[] memory ids, uint256[] memory shares) = _alicePosition();
        vm.prank(alice);
        pair.transferShares(carol, ids, shares);
        assertEq(pair.getPosition(start, alice).shares, 0);
        assertEq(pair.getPosition(start, carol).shares, shares[K]);
        _swap(bob, address(pair), pair.tokenX(), pair.tokenY(), pair.tokenX() == address(weth) ? 1e18 : 2_000e6);
        (uint256 cx,) = pair.pendingFees(carol, ids);
        assertGt(cx, 0);
    }

    function test_factoryRules() public {
        vm.expectRevert(abi.encodeWithSelector(DlmmFactory.PairExists.selector, address(pair)));
        dlmmFactory.createPair(address(usdg), address(weth), 10, start);
        vm.expectRevert(abi.encodeWithSelector(DlmmFactory.PresetDisabled.selector, uint16(7)));
        dlmmFactory.createPair(address(usdg), address(weth), 7, start);
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.setPreset(10, 2000, true);
    }

    function test_createPairInvertsPriceWhenSortFlips() public {
        uint24 id = _idForPrice(_rawPrice(2000e6, 18, 6), 25);
        DlmmPair a = DlmmPair(dlmmFactory.createPair(address(weth), address(usdg), 25, id));
        // Both orientations describe the same market price.
        uint256 p = a.getPrice(a.activeId());
        if (a.tokenX() == address(weth)) assertEq(a.activeId(), id);
        else assertEq(uint256(a.activeId()), 2 * uint256(BinMath.CENTER) - id);
        assertGt(p, 0);
    }

    // ------------------------------------------------------------------ helpers

    function _deposit(
        address to,
        uint256 ax,
        uint256 ay,
        int256[] memory d,
        uint256[] memory dx,
        uint256[] memory dy,
        uint24 expected,
        uint24 slip
    ) internal view returns (CurveilRouter.DlmmDeposit memory) {
        return CurveilRouter.DlmmDeposit({
            pair: address(pair),
            amountX: ax,
            amountY: ay,
            activeIdExpected: expected,
            idSlippage: slip,
            deltaIds: d,
            distributionX: dx,
            distributionY: dy,
            to: to,
            deadline: block.timestamp
        });
    }

    function _addSingle(address who, uint24 id, uint256 ax, uint256 ay) internal returns (uint256[] memory minted) {
        int256[] memory d = new int256[](1);
        d[0] = int256(uint256(id)) - int256(uint256(pair.activeId()));
        uint256[] memory dx = new uint256[](1);
        uint256[] memory dy = new uint256[](1);
        dx[0] = ax > 0 ? 1e18 : 0;
        dy[0] = ay > 0 ? 1e18 : 0;
        CurveilRouter.DlmmDeposit memory dep = _deposit(who, ax, ay, d, dx, dy, pair.activeId(), 0);
        vm.prank(who);
        (,,, minted) = router.addLiquidityDlmm(dep);
    }

    function _alicePosition() internal view returns (uint24[] memory ids, uint256[] memory shares) {
        ids = new uint24[](2 * K + 1);
        shares = new uint256[](2 * K + 1);
        for (uint256 i; i < ids.length; ++i) {
            ids[i] = start - uint24(K) + uint24(i);
            shares[i] = pair.getPosition(ids[i], alice).shares;
        }
    }

    function _assertAccounting() internal view {
        (uint256 sx, uint256 sy) = _sumBins(pair, start - 60, start + 60);
        assertEq(sx, pair.reserveX(), "bins sum to reserveX");
        assertEq(sy, pair.reserveY(), "bins sum to reserveY");
        assertGe(_x().balanceOf(address(pair)), sx + pair.lpFeesX() + pair.protocolFeesX(), "X solvent");
        assertGe(_y().balanceOf(address(pair)), sy + pair.lpFeesY() + pair.protocolFeesY(), "Y solvent");
    }
}
