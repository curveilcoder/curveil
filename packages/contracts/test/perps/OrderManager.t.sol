// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {PerpEngine} from "../../src/perps/PerpEngine.sol";
import {OrderManager} from "../../src/perps/OrderManager.sol";

contract OrderManagerTest is PerpsBase {
    uint256 id;

    function setUp() public override {
        super.setUp();
        id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
    }

    function _place(OrderManager.Kind kind, uint256 trigger, uint256 size) internal returns (uint256) {
        vm.prank(alice);
        return orders.place(id, kind, trigger, uint128(size), 0, EXEC_FEE, 0);
    }

    function test_TakeProfitFillsAtReportedPrice() public {
        uint256 oid = _place(OrderManager.Kind.TakeProfit, 2_200e18, 0);
        bytes memory below = _fresh(ETH, 2_150e18);
        vm.expectRevert(abi.encodeWithSelector(OrderManager.NotTriggered.selector, 2_150e18, 2_200e18));
        orders.execute(oid, below);

        uint256 before = usdg.balanceOf(alice);
        bytes memory r = _fresh(ETH, 2_210e18);
        vm.prank(keeper);
        orders.execute(oid, r);
        assertEq(uint8(orders.order(oid).status), uint8(OrderManager.Status.Filled));
        assertEq(uint8(engine.position(id).status), uint8(PerpEngine.Status.Closed));
        // 2,092 + 1,050 - 8 - 0.2
        assertApproxEqAbs(usdg.balanceOf(alice) - before, 3_133_800_000, 1_000);
        assertEq(orders.activeOrders(id), 0);
        _checkSolvency();
    }

    function test_StopLossPartial() public {
        uint256 oid = _place(OrderManager.Kind.StopLoss, 1_900e18, 5_000 * USD);
        bytes memory r = _fresh(ETH, 1_890e18);
        orders.execute(oid, r);
        assertEq(engine.position(id).size, 5_000 * USD);
        _checkSolvency();
    }

    function test_RefusesReportFromBeforeTheOrder() public {
        bytes memory early = _fresh(ETH, 2_300e18);
        uint256 oid = _place(OrderManager.Kind.TakeProfit, 2_200e18, 0);
        vm.expectRevert();
        orders.execute(oid, early);
    }

    function test_AcceptablePriceGuards() public {
        vm.prank(alice);
        uint256 oid = orders.place(id, OrderManager.Kind.StopLoss, 1_900e18, 0, 1_880e18, EXEC_FEE, 0);
        bytes memory gap = _fresh(ETH, 1_850e18);
        vm.expectRevert(abi.encodeWithSelector(OrderManager.PriceNotAcceptable.selector, 1_850e18, 1_880e18));
        orders.execute(oid, gap);
    }

    function test_OrdersFollowThePosition() public {
        uint256 tp = _place(OrderManager.Kind.TakeProfit, 2_500e18, 0);
        uint256 sl = _place(OrderManager.Kind.StopLoss, 1_800e18, 0);
        vm.expectRevert(OrderManager.StillValid.selector);
        orders.expire(tp);
        _close(alice, id, 10_000 * USD, PRICE);
        bytes memory r = _fresh(ETH, 2_600e18);
        vm.expectRevert(OrderManager.NotOpen.selector);
        orders.execute(tp, r);
        orders.expire(tp);
        orders.expire(sl);
        assertEq(orders.activeCount(), 0);
        assertEq(uint8(orders.order(sl).status), uint8(OrderManager.Status.Cancelled));
    }

    function test_ExpiryAndCancel() public {
        vm.prank(alice);
        uint256 oid =
            orders.place(id, OrderManager.Kind.TakeProfit, 2_200e18, 0, 0, EXEC_FEE, uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 11);
        bytes memory r = _report(ETH, 2_300e18, block.timestamp);
        vm.expectRevert(OrderManager.Expired.selector);
        orders.execute(oid, r);
        orders.expire(oid);

        uint256 other = _place(OrderManager.Kind.StopLoss, 1_800e18, 0);
        vm.prank(bob);
        vm.expectRevert(OrderManager.NotOwner.selector);
        orders.cancel(other);
        vm.prank(alice);
        orders.cancel(other);
        assertEq(orders.activeOrders(id), 0);
    }

    function test_PlaceRules() public {
        vm.prank(bob);
        vm.expectRevert(OrderManager.NotOwner.selector);
        orders.place(id, OrderManager.Kind.TakeProfit, 2_200e18, 0, 0, EXEC_FEE, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OrderManager.FeeTooLow.selector, EXEC_FEE));
        orders.place(id, OrderManager.Kind.TakeProfit, 2_200e18, 0, 0, EXEC_FEE - 1, 0);
        for (uint256 i = 0; i < 4; i++) {
            _place(OrderManager.Kind.TakeProfit, 2_200e18 + i, 0);
        }
        vm.prank(alice);
        vm.expectRevert(OrderManager.TooManyOrders.selector);
        orders.place(id, OrderManager.Kind.TakeProfit, 2_300e18, 0, 0, EXEC_FEE, 0);
    }

    function test_StopLossOnLiquidatablePositionLeavesItToLiquidation() public {
        uint256 oid = _place(OrderManager.Kind.StopLoss, 1_900e18, 0);
        bytes memory r = _fresh(ETH, 1_600e18);
        vm.expectRevert(PerpEngine.Liquidatable.selector);
        orders.execute(oid, r);
        engine.liquidate(id, r);
        orders.expire(oid);
    }

    function test_TriggerTable() public view {
        assertTrue(orders.triggered(OrderManager.Kind.TakeProfit, true, 2_000e18, 2_000e18));
        assertFalse(orders.triggered(OrderManager.Kind.TakeProfit, true, 1_999e18, 2_000e18));
        assertTrue(orders.triggered(OrderManager.Kind.TakeProfit, false, 1_999e18, 2_000e18));
        assertTrue(orders.triggered(OrderManager.Kind.StopLoss, true, 1_999e18, 2_000e18));
        assertFalse(orders.triggered(OrderManager.Kind.StopLoss, false, 1_999e18, 2_000e18));
        assertTrue(orders.triggered(OrderManager.Kind.StopLoss, false, 2_001e18, 2_000e18));
    }
}
