// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {MarketsBase} from "./MarketsBase.sol";
import {LiquidityShapes} from "../../src/markets/libraries/LiquidityShapes.sol";
import {CurveilRouter} from "../../src/markets/CurveilRouter.sol";
import {DammPool} from "../../src/markets/DammPool.sol";
import {DlmmPair} from "../../src/markets/DlmmPair.sol";

/// A contract that looks like a pool but would keep the input.
contract FakePool {
    address public a;
    address public b;

    constructor(address a_, address b_) {
        (a, b) = (a_, b_);
    }

    function tokens() external view returns (address, address) {
        return (a, b);
    }

    function swap(address, address) external pure returns (uint256) {
        return 1e30;
    }

    function quote(address, uint256) external pure returns (uint256, uint256) {
        return (1e30, 0);
    }
}

contract CurveilRouterTest is MarketsBase {
    DammPool internal usdgWeth;
    DlmmPair internal wethWbtc;

    function setUp() public override {
        super.setUp();
        usdgWeth = _dammPool(address(usdg), address(weth), 1_000_000e6, 500e18);
        // 1 WBTC = 30 WETH, so 1 WETH = 0.033333 WBTC.
        uint24 id = _idForPrice(_rawPrice(33_333, 18, 8), 25);
        wethWbtc = DlmmPair(dlmmFactory.createPair(address(weth), address(wbtc), 25, id));
        (uint256 ax, uint256 ay) =
            wethWbtc.tokenX() == address(weth) ? (uint256(300e18), uint256(10e8)) : (uint256(10e8), uint256(300e18));
        _addDlmm(alice, wethWbtc, ax, ay, LiquidityShapes.Shape.Balanced, 15);
    }

    function _path() internal view returns (CurveilRouter.Hop[] memory h) {
        h = new CurveilRouter.Hop[](2);
        h[0] = CurveilRouter.Hop(address(usdgWeth), address(usdg), address(weth));
        h[1] = CurveilRouter.Hop(address(wethWbtc), address(weth), address(wbtc));
    }

    function test_twoHopAcrossDammAndDlmm() public {
        CurveilRouter.Hop[] memory h = _path();
        (uint256 quoted, uint256[] memory fees) = router.quoteExactIn(h, 10_000e6);
        assertEq(fees.length, 2);
        assertEq(fees[0], 30e6, "0.30% DAMM fee on the first hop");
        assertGt(fees[1], 0);

        uint256 before = wbtc.balanceOf(bob);
        vm.prank(bob);
        uint256 out = router.swapExactIn(h, 10_000e6, quoted, bob, block.timestamp);
        assertEq(out, quoted, "quote equals swap");
        assertEq(wbtc.balanceOf(bob) - before, out);
        // About 5 WETH worth of WBTC: 10,000 USDG at 2,000 then 30 WETH per WBTC.
        assertApproxEqRel(out, 0.1666e8, 0.02e18);

        assertEq(usdg.balanceOf(address(router)), 0, "router keeps nothing");
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(wbtc.balanceOf(address(router)), 0);
    }

    function test_revertWhen_minOutNotMet() public {
        CurveilRouter.Hop[] memory h = _path();
        (uint256 quoted,) = router.quoteExactIn(h, 10_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveilRouter.InsufficientOutput.selector, quoted, quoted + 1));
        router.swapExactIn(h, 10_000e6, quoted + 1, bob, block.timestamp);
    }

    function test_revertWhen_expired() public {
        CurveilRouter.Hop[] memory h = _path();
        vm.warp(1000);
        vm.prank(bob);
        vm.expectRevert(CurveilRouter.Expired.selector);
        router.swapExactIn(h, 1e6, 0, bob, 999);
    }

    function test_revertWhen_fakePool() public {
        FakePool fake = new FakePool(address(usdg), address(weth));
        CurveilRouter.Hop[] memory h = _hop(address(fake), address(usdg), address(weth));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CurveilRouter.UnknownPool.selector, address(fake)));
        router.swapExactIn(h, 1e6, 0, bob, block.timestamp);
    }

    function test_revertWhen_pathBroken() public {
        CurveilRouter.Hop[] memory h = _path();
        h[1].tokenIn = address(usdg); // does not follow the first hop's output
        vm.expectRevert(CurveilRouter.InvalidPath.selector);
        router.quoteExactIn(h, 1e6);

        CurveilRouter.Hop[] memory wrong = _hop(address(usdgWeth), address(usdg), address(wbtc));
        vm.expectRevert(CurveilRouter.InvalidPath.selector);
        router.quoteExactIn(wrong, 1e6);

        CurveilRouter.Hop[] memory none = new CurveilRouter.Hop[](0);
        vm.expectRevert(CurveilRouter.InvalidPath.selector);
        router.quoteExactIn(none, 1e6);
    }

    function test_reverseDirection() public {
        CurveilRouter.Hop[] memory h = new CurveilRouter.Hop[](2);
        h[0] = CurveilRouter.Hop(address(wethWbtc), address(wbtc), address(weth));
        h[1] = CurveilRouter.Hop(address(usdgWeth), address(weth), address(usdg));
        (uint256 quoted,) = router.quoteExactIn(h, 0.1e8);
        vm.prank(bob);
        uint256 out = router.swapExactIn(h, 0.1e8, quoted, bob, block.timestamp);
        assertEq(out, quoted);
        assertApproxEqRel(out, 6_000e6, 0.03e18);
    }

    function test_dlmmDepositRefundsUnusedInput() public {
        // Offer far more Y than the active bin's proportion needs; the rest comes back.
        int256[] memory d = new int256[](1);
        uint256[] memory dx = new uint256[](1);
        uint256[] memory dy = new uint256[](1);
        dx[0] = 1e18;
        dy[0] = 1e18;
        (uint256 ax, uint256 ay) =
            wethWbtc.tokenX() == address(weth) ? (uint256(1e18), uint256(10e8)) : (uint256(0.01e8), uint256(10e18));
        uint256 xb = _bal(wethWbtc.tokenX(), bob);
        uint256 yb = _bal(wethWbtc.tokenY(), bob);
        CurveilRouter.DlmmDeposit memory dep = CurveilRouter.DlmmDeposit({
            pair: address(wethWbtc),
            amountX: ax,
            amountY: ay,
            activeIdExpected: wethWbtc.activeId(),
            idSlippage: 0,
            deltaIds: d,
            distributionX: dx,
            distributionY: dy,
            to: bob,
            deadline: block.timestamp
        });
        vm.prank(bob);
        (uint256 usedX, uint256 usedY,,) = router.addLiquidityDlmm(dep);
        assertEq(xb - _bal(wethWbtc.tokenX(), bob), usedX, "only used X leaves the wallet");
        assertEq(yb - _bal(wethWbtc.tokenY(), bob), usedY, "only used Y leaves the wallet");
        assertTrue(usedX < ax || usedY < ay, "something was refunded");
    }

    function test_revertWhen_dlmmPairUnknown() public {
        CurveilRouter.DlmmDeposit memory dep;
        dep.pair = address(usdgWeth);
        dep.deadline = block.timestamp;
        vm.expectRevert(abi.encodeWithSelector(CurveilRouter.UnknownPool.selector, address(usdgWeth)));
        router.addLiquidityDlmm(dep);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return DammPool(token).balanceOf(who);
    }
}
