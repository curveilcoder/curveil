// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {SignedReportVerifier} from "../../src/perps/oracle/SignedReportVerifier.sol";
import {PerpEngine} from "../../src/perps/PerpEngine.sol";
import {PerpLens} from "../../src/perps/PerpLens.sol";

contract PerpEngineTest is PerpsBase {
    // ---------------------------------------------------------------- open and close

    function test_OpenAndCloseLongWithProfit() public {
        uint256 aliceBefore = usdg.balanceOf(alice);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        PerpEngine.Position memory p = engine.position(id);
        assertEq(p.size, 10_000 * USD);
        assertEq(p.collateral, 2_092 * USD, "open fee 8 USDG out of collateral");
        assertEq(p.reserve, 10_000 * USD);
        assertEq(p.entryPrice, PRICE);
        assertEq(p.version, 1);
        assertEq(engine.totalReserved(), 10_000 * USD);
        assertEq(usdg.balanceOf(keeper), EXEC_FEE, "keeper paid on open");
        // 20% of the open fee to the protocol, the rest to the vault
        assertEq(usdg.balanceOf(treasury), 1_600_000);
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, 6_400_000);
        _checkSolvency();

        _close(alice, id, 10_000 * USD, 2_200e18); // +10%
        p = engine.position(id);
        assertEq(uint8(p.status), uint8(PerpEngine.Status.Closed));
        assertEq(p.version, 2);
        // payout = 2,092 + 1,000 - 8 close fee - 0.2 execution fee - a few units of funding
        uint256 received = usdg.balanceOf(alice) - (aliceBefore - 2_100 * USD - EXEC_FEE);
        assertApproxEqAbs(received, 3_083_800_000, 1_000, "payout");
        assertEq(engine.paidOut(id), received);
        assertEq(engine.totalReserved(), 0);
        assertEq(engine.totalCollateral(), 0);
        _checkSolvency();
    }

    function test_CloseLongWithLoss() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 before = usdg.balanceOf(alice);
        _close(alice, id, 10_000 * USD, 1_900e18); // -5% => -500
        assertApproxEqAbs(usdg.balanceOf(alice) - before, 1_583_800_000, 1_000, "2092 - 500 - 8 - 0.2");
        // vault: +500 loss, +80% of the 8 USDG close fee
        assertApproxEqAbs(usdg.balanceOf(address(vault)) - vaultBefore, 506_400_000, 1_000);
        _checkSolvency();
    }

    function test_ShortWithProfit() public {
        uint256 id = _open(bob, M_ETH, false, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 before = usdg.balanceOf(bob);
        _close(bob, id, 10_000 * USD, 1_800e18); // -10% => short +1,000
        assertApproxEqAbs(usdg.balanceOf(bob) - before, 3_083_800_000, 1_000);
        _checkSolvency();
    }

    function test_PartialClose() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 before = usdg.balanceOf(alice);
        _close(alice, id, 4_000 * USD, 2_100e18); // close 40% at +5%
        PerpEngine.Position memory p = engine.position(id);
        assertEq(uint8(p.status), uint8(PerpEngine.Status.Open));
        assertEq(p.size, 6_000 * USD);
        assertEq(p.collateral, 1_255_200_000, "60% of 2,092");
        assertEq(p.reserve, 6_000 * USD);
        assertEq(p.version, 2);
        // 40% of collateral 836.8 + 200 gain - 3.2 fee - 0.2
        assertApproxEqAbs(usdg.balanceOf(alice) - before, 1_033_400_000, 1_000);
        assertEq(engine.position(id).pendingClose, 0);
        _checkSolvency();
        _close(alice, id, type(uint128).max, 2_000e18);
        assertEq(uint8(engine.position(id).status), uint8(PerpEngine.Status.Closed));
        _checkSolvency();
    }

    function test_PartialCloseBelowMinCollateralClosesAll() public {
        uint256 id = _open(alice, M_ETH, true, 500 * USD, 105 * USD, PRICE);
        _close(alice, id, 460 * USD, PRICE); // would leave 8.37 USDG, under the 10 USDG minimum
        assertEq(uint8(engine.position(id).status), uint8(PerpEngine.Status.Closed));
    }

    function test_GainCappedAtReserve() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 before = usdg.balanceOf(alice);
        _close(alice, id, 10_000 * USD, 6_000e18); // +200% => capped at +100% of size
        assertEq(usdg.balanceOf(alice) - before, 2_092 * USD + 10_000 * USD - 8 * USD - EXEC_FEE);
        _checkSolvency();
    }

    function test_AddCollateral() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        vm.prank(alice);
        engine.addCollateral(id, uint128(500 * USD));
        assertEq(engine.position(id).collateral, 2_592 * USD);
        assertEq(engine.position(id).version, 2);
        vm.prank(bob);
        vm.expectRevert(PerpEngine.NotOwner.selector);
        engine.addCollateral(id, 1);
        _checkSolvency();
    }

    // ---------------------------------------------------------------- two-step rules

    function test_RequestNeedsPriceAfterIt() public {
        (uint256 rid,) = _requestOpen(alice, M_ETH, true, 10_000 * USD, 2_100 * USD);
        bytes memory same = _report(ETH, PRICE, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignedReportVerifier.OutsideRange.selector, block.timestamp, block.timestamp + 1, block.timestamp + 120
            )
        );
        engine.executeRequest(rid, same);
    }

    /// @dev A newer price recorded after the request (by anyone) must not block its fill: the
    ///      fill uses the first price after the request, not the newest.
    function test_NewerRecordedPriceDoesNotBlockFill() public {
        (uint256 rid, uint256 pid) = _requestOpen(alice, M_ETH, true, 10_000 * USD, 2_100 * USD);
        bytes memory first = _fresh(ETH, PRICE);
        _submit(ETH, PRICE + 1e18);
        vm.prank(keeper);
        engine.executeRequest(rid, first);
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Open));
        assertEq(engine.position(pid).entryPrice, PRICE);
        (uint256 stored,) = oracle.latestPrice(ETH);
        assertEq(stored, PRICE + 1e18, "newest stays recorded");
    }

    function test_RequestTimesOutAndRefundsInFull() public {
        uint256 before = usdg.balanceOf(alice);
        (uint256 rid, uint256 pid) = _requestOpen(alice, M_ETH, true, 10_000 * USD, 2_100 * USD);
        vm.expectRevert();
        engine.cancelRequest(rid);
        vm.warp(block.timestamp + 121);
        bytes memory late = _report(ETH, PRICE, block.timestamp);
        vm.expectRevert();
        engine.executeRequest(rid, late);
        vm.prank(bob); // anyone may cancel a timed-out request
        engine.cancelRequest(rid);
        assertEq(usdg.balanceOf(alice), before);
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Cancelled));
        assertEq(engine.paidOut(pid), 2_100 * USD + EXEC_FEE);
        _checkSolvency();
    }

    function test_PriceBeyondLimitCancelsAndRefunds() public {
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        (uint256 rid, uint256 pid) =
            engine.requestOpen(M_ETH, true, uint128(10_000 * USD), uint128(2_100 * USD), 1_990e18, EXEC_FEE);
        bytes memory r = _fresh(ETH, PRICE);
        vm.prank(keeper);
        engine.executeRequest(rid, r);
        assertEq(uint8(engine.request(rid).status), uint8(PerpEngine.RequestStatus.Cancelled));
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Cancelled));
        assertEq(usdg.balanceOf(alice), before - EXEC_FEE, "collateral back, fee to keeper");
        assertEq(usdg.balanceOf(keeper), EXEC_FEE);
        _checkSolvency();
    }

    function test_LeverageAfterFeeCancels() public {
        vm.prank(alice);
        (uint256 rid,) =
            engine.requestOpen(M_ETH, true, uint128(10_000 * USD), uint128(2_000 * USD), type(uint256).max, EXEC_FEE);
        bytes memory r = _fresh(ETH, PRICE);
        vm.expectEmit(true, true, false, false);
        emit PerpEngine.RequestCancelled(rid, 1, PerpEngine.Reason.Leverage, PRICE, EXEC_FEE, keeper);
        vm.prank(keeper);
        engine.executeRequest(rid, r);
    }

    function test_RequestRejectsLeverageUpFront() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.LeverageTooHigh.selector);
        engine.requestOpen(M_ETH, true, uint128(10_001 * USD), uint128(2_000 * USD), type(uint256).max, EXEC_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpEngine.FeeTooLow.selector, EXEC_FEE));
        engine.requestOpen(M_ETH, true, uint128(1_000 * USD), uint128(2_000 * USD), type(uint256).max, EXEC_FEE - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpEngine.BelowMinCollateral.selector, 10 * USD));
        engine.requestOpen(M_ETH, true, uint128(10 * USD), uint128(9 * USD), type(uint256).max, EXEC_FEE);
    }

    function test_VaultCapacityCancels() public {
        // capacity = 80% of ~500k; a 450k position reserves 450k.
        (uint256 rid,) = _requestOpen(alice, M_ETH, true, 450_000 * USD, 95_000 * USD);
        bytes memory r = _fresh(ETH, PRICE);
        vm.expectEmit(true, true, false, false);
        emit PerpEngine.RequestCancelled(rid, 1, PerpEngine.Reason.Capacity, PRICE, EXEC_FEE, keeper);
        vm.prank(keeper);
        engine.executeRequest(rid, r);
    }

    function test_OpenInterestCapCancels() public {
        PerpEngine.MarketConfig memory c = _config(ETH);
        c.maxOpenInterestShort = uint128(5_000 * USD);
        vm.prank(admin);
        engine.setMarket(M_ETH, c);
        (uint256 rid,) = _requestOpen(bob, M_ETH, false, 6_000 * USD, 2_000 * USD);
        bytes memory r = _fresh(ETH, PRICE);
        vm.expectEmit(true, true, false, false);
        emit PerpEngine.RequestCancelled(rid, 1, PerpEngine.Reason.OpenInterest, PRICE, EXEC_FEE, keeper);
        vm.prank(keeper);
        engine.executeRequest(rid, r);
    }

    function test_GuardianPausesNewRiskButNotExits() public {
        address guardian = makeAddr("guardian");
        vm.prank(admin);
        engine.setGuardian(guardian);
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        (uint256 rid,) = _requestOpen(bob, M_ETH, true, 1_000 * USD, 300 * USD);

        vm.prank(guardian);
        engine.setMarketEnabled(M_ETH, false);
        vm.prank(guardian);
        vm.expectRevert(PerpEngine.NotGuardian.selector);
        engine.setMarketEnabled(M_ETH, true);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PerpEngine.MarketClosed.selector, M_ETH));
        engine.requestOpen(M_ETH, true, uint128(1_000 * USD), uint128(300 * USD), type(uint256).max, EXEC_FEE);
        vm.prank(keeper);
        engine.executeRequest(rid, ""); // cancelled without a price
        assertEq(uint8(engine.request(rid).status), uint8(PerpEngine.RequestStatus.Cancelled));

        _close(alice, id, 10_000 * USD, PRICE);
        assertEq(uint8(engine.position(id).status), uint8(PerpEngine.Status.Closed));
        _checkSolvency();
    }

    function test_OnlyOwnerCloses() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        vm.prank(bob);
        vm.expectRevert(PerpEngine.NotOwner.selector);
        engine.requestClose(id, 1, 0, EXEC_FEE);
        vm.prank(alice);
        engine.requestClose(id, 1, 0, EXEC_FEE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerpEngine.RequestPending.selector, 2));
        engine.requestClose(id, 1, 0, EXEC_FEE);
    }

    function test_CloseBeyondLimitChargesAtMostMinFee() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        vm.prank(alice);
        uint256 rid = engine.requestClose(id, uint128(10_000 * USD), 2_500e18, uint128(50 * USD));
        bytes memory r = _fresh(ETH, PRICE);
        vm.prank(keeper);
        engine.executeRequest(rid, r);
        assertEq(uint8(engine.request(rid).status), uint8(PerpEngine.RequestStatus.Cancelled));
        assertEq(engine.position(id).collateral, 2_092 * USD - EXEC_FEE);
        assertEq(engine.position(id).pendingClose, 0);
        _checkSolvency();
    }

    // ---------------------------------------------------------------- liquidation

    function test_LiquidationPriceAndLiquidation() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        PerpLens.Valuation memory v = lens.valuation(id, PRICE);
        // need = 10,000 + 20.8 buffer... -> 8,116 / 10,000 * 2,000 = 1,623.2
        assertApproxEqRel(v.liquidationPrice, 1_623.2e18, 1e14);
        assertFalse(v.liquidatable);

        bytes memory notYet = _fresh(ETH, 1_630e18);
        vm.expectRevert(PerpEngine.NotLiquidatable.selector);
        engine.liquidate(id, notYet);

        uint256 vaultBefore = usdg.balanceOf(address(vault));
        bytes memory r = _fresh(ETH, 1_620e18);
        assertTrue(lens.valuation(id, 1_620e18).liquidatable);
        vm.prank(bob);
        engine.liquidate(id, r);
        PerpEngine.Position memory p = engine.position(id);
        assertEq(uint8(p.status), uint8(PerpEngine.Status.Liquidated));
        assertEq(usdg.balanceOf(bob), 100_000 * USD + 50 * USD, "0.5% of size to the liquidator");
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, 2_042 * USD);
        assertEq(engine.paidOut(id), 0, "a liquidated position pays its owner nothing");
        assertEq(engine.totalReserved(), 0);
        _checkSolvency();
    }

    function test_LiquidationRefusesOlderPrice() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        bytes memory dip = _fresh(ETH, 1_600e18);
        _submit(ETH, PRICE);
        vm.expectRevert();
        engine.liquidate(id, dip);
    }

    function test_CloseOfLiquidatablePositionIsCancelledThenLiquidated() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        vm.prank(alice);
        uint256 rid = engine.requestClose(id, uint128(10_000 * USD), 0, EXEC_FEE);
        bytes memory r = _fresh(ETH, 1_600e18);
        vm.prank(keeper);
        engine.executeRequest(rid, r);
        assertEq(uint8(engine.request(rid).status), uint8(PerpEngine.RequestStatus.Cancelled));
        assertEq(engine.position(id).collateral, 2_092 * USD, "nothing charged");
        vm.prank(keeper);
        engine.liquidate(id, r);
        assertEq(uint8(engine.position(id).status), uint8(PerpEngine.Status.Liquidated));
        _checkSolvency();
    }

    function test_LiquidationDropsPendingClose() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        vm.prank(alice);
        uint256 rid = engine.requestClose(id, uint128(10_000 * USD), 1_990e18, EXEC_FEE);
        bytes memory r = _fresh(ETH, 1_600e18);
        engine.liquidate(id, r);
        assertEq(uint8(engine.request(rid).status), uint8(PerpEngine.RequestStatus.Cancelled));
        (uint256 pending,) = engine.counts();
        assertEq(pending, 0);
    }

    // ---------------------------------------------------------------- funding

    function test_FundingLongsPayWhenSkewedLong() public {
        uint256 a = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 b = _open(bob, M_ETH, false, 5_000 * USD, 1_100 * USD, PRICE);
        PerpEngine.MarketState memory s = engine.marketState(M_ETH);
        // skew = 1/3 of 0.01% per hour, per second
        assertEq(s.fundingRate, int128(int256(uint256(1e14) / 3600) / 3));
        vm.warp(block.timestamp + 10 hours);
        engine.updateFunding(M_ETH);

        PerpLens.Valuation memory va = lens.valuation(a, PRICE);
        PerpLens.Valuation memory vb = lens.valuation(b, PRICE);
        assertApproxEqAbs(va.funding, 3_333_333, 1_000, "alice pays 10,000 * 0.01%/3 * 10h");
        assertApproxEqAbs(vb.funding, -1_666_666, 1_000, "bob receives at the same rate");

        uint256 vaultBefore = usdg.balanceOf(address(vault));
        _close(alice, a, 10_000 * USD, PRICE);
        _close(bob, b, 5_000 * USD, PRICE);
        // vault: +3.33 - 1.67 funding, +80% of both close fees (8 + 4)
        assertApproxEqAbs(usdg.balanceOf(address(vault)) - vaultBefore, 1_666_667 + 9_600_000, 2_000);
        _checkSolvency();
    }

    function test_FundingRateFollowsSkew() public {
        _open(bob, M_ETH, false, 8_000 * USD, 2_000 * USD, PRICE);
        assertEq(engine.marketState(M_ETH).fundingRate, -int128(int256(uint256(1e14) / 3600)), "shorts pay");
        _open(alice, M_ETH, true, 8_000 * USD, 2_000 * USD, PRICE);
        assertEq(engine.marketState(M_ETH).fundingRate, 0, "balanced");
    }

    // ---------------------------------------------------------------- admin

    function test_MarketConfigValidation() public {
        PerpEngine.MarketConfig memory c = _config(ETH);
        c.maxLeverageBps = 600_000;
        vm.prank(admin);
        vm.expectRevert(PerpEngine.BadConfig.selector);
        engine.setMarket(3, c);
        c = _config(BTC);
        vm.prank(admin);
        vm.expectRevert(PerpEngine.BadConfig.selector);
        engine.setMarket(M_ETH, c); // feed is fixed once set
        c = _config(ETH);
        c.maintenanceMarginBps = 2_000; // 20% maintenance at 5x is the whole initial margin
        vm.prank(admin);
        vm.expectRevert(PerpEngine.BadConfig.selector);
        engine.setMarket(M_ETH, c);
        vm.prank(alice);
        vm.expectRevert();
        engine.setMarket(M_ETH, _config(ETH));
    }

    function test_OrderManagerSetOnce() public {
        vm.prank(admin);
        vm.expectRevert(PerpEngine.AlreadySet.selector);
        engine.setOrderManager(address(1));
        vm.expectRevert(PerpEngine.OnlyOrderManager.selector);
        engine.closeFromOrder(1, 0, PRICE, keeper, 0);
    }

    function test_PagesOpenPositionsAndRequests() public {
        _open(alice, M_ETH, true, 1_000 * USD, 300 * USD, PRICE);
        _open(bob, M_BTC, false, 1_000 * USD, 300 * USD, 60_000e18);
        _requestOpen(alice, M_ETH, false, 1_000 * USD, 300 * USD);
        assertEq(engine.openPositions(0, 10).length, 2);
        assertEq(engine.openPositions(1, 10).length, 1);
        assertEq(engine.pendingRequests(0, 10).length, 1);
        assertEq(engine.marketIds().length, 2);
    }
}
