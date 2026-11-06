// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {MockPyth} from "./MockPyth.sol";
import {OracleAdapter} from "../../src/perps/OracleAdapter.sol";
import {PerpEngine} from "../../src/perps/PerpEngine.sol";
import {PythReportVerifier} from "../../src/perps/oracle/PythReportVerifier.sol";
import {IPyth} from "../../src/perps/interfaces/IPyth.sol";

/// @notice Perps priced by Pyth: the verifier's checks, and the first-price rule for requests.
contract PythReportVerifierTest is PerpsBase {
    bytes32 constant PYTH_ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant PYTH_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    MockPyth pyth;
    PythReportVerifier pv;

    function setUp() public override {
        super.setUp();
        pyth = new MockPyth();
        pv = new PythReportVerifier(admin, IPyth(address(pyth)));
        vm.startPrank(admin);
        pv.setCaller(address(oracle));
        pv.setFeed(ETH, PYTH_ETH, 100);
        pv.setFeed(BTC, PYTH_BTC, 100);
        oracle.setVerifier(pv);
        vm.stopPrank();
    }

    /// @dev A Pyth report for ETH at `usd` dollars (8-decimal Pyth price), published at `t`.
    function _pyth(uint256 usd, uint64 t, uint64 prev) internal view returns (bytes memory) {
        return abi.encode(ETH, pyth.update(PYTH_ETH, int64(uint64(usd * 1e8)), uint64(usd * 1e5), -8, t, prev));
    }

    function test_ScalesPythPriceTo18Decimals() public {
        uint64 t = uint64(block.timestamp);
        (uint256 price, uint256 ts) = oracle.priceFor(ETH, _pyth(2_000, t, t - 1), OracleAdapter.Use.Open);
        assertEq(price, PRICE);
        assertEq(ts, t);
    }

    function test_OnlyTheOracleAdapterMayCall() public {
        bytes memory r = _pyth(2_000, uint64(block.timestamp), 0);
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.NotCaller.selector, address(this)));
        pv.verifyReport(r);
    }

    function test_RefusesUnknownFeedAndWrongPythId() public {
        uint64 t = uint64(block.timestamp);
        bytes32 sol = keccak256("SOL/USD");
        bytes memory unknown = abi.encode(sol, pyth.update(PYTH_ETH, 2_000e8, 1e8, -8, t, 0));
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.UnknownFeed.selector, sol));
        oracle.submit(unknown);
        // our ETH feed id wrapped around Pyth's BTC update: Pyth finds no ETH price in it
        bytes memory wrong = abi.encode(ETH, pyth.update(PYTH_BTC, 2_000e8, 1e8, -8, t, 0));
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        oracle.submit(wrong);
    }

    function test_RefusesWideConfidenceAndNegativePrice() public {
        uint64 t = uint64(block.timestamp);
        // 1% allowed; 1.5% refused
        oracle.submit(abi.encode(ETH, pyth.update(PYTH_ETH, 2_000e8, 20e8, -8, t, 0)));
        bytes memory wide = abi.encode(ETH, pyth.update(PYTH_ETH, 2_000e8, 30e8, -8, t, 0));
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.ConfidenceTooWide.selector, 30e18, PRICE, 100));
        oracle.submit(wide);
        bytes memory negative = abi.encode(ETH, pyth.update(PYTH_ETH, -1, 0, -8, t, 0));
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.BadPythPrice.selector, int64(-1), int32(-8)));
        oracle.submit(negative);
    }

    function test_PaysPythFeeFromBalanceWithinCap() public {
        pyth.setFee(10);
        bytes memory r = _pyth(2_000, uint64(block.timestamp), 0);
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.FeeTooHigh.selector, 10, 0));
        oracle.submit(r);
        vm.prank(admin);
        pv.setMaxFee(10);
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.FeeUnfunded.selector, 10, 0));
        oracle.submit(r);
        vm.deal(address(pv), 15);
        oracle.submit(r);
        assertEq(address(pv).balance, 5);
        assertEq(address(pyth).balance, 10);
        vm.prank(admin);
        pv.withdraw(payable(admin), 5);
        assertEq(admin.balance, 5);
    }

    function test_AdminOnlyAndConfig() public {
        vm.expectRevert();
        pv.setFeed(ETH, PYTH_ETH, 100);
        vm.expectRevert();
        pv.setCaller(address(1));
        vm.expectRevert();
        pv.setMaxFee(1);
        vm.startPrank(admin);
        vm.expectRevert(PythReportVerifier.BadConfig.selector);
        pv.setFeed(ETH, PYTH_ETH, 0);
        pv.setFeed(ETH, bytes32(0), 0); // disables it
        vm.stopPrank();
        bytes memory r = _pyth(2_000, uint64(block.timestamp), 0);
        vm.expectRevert(abi.encodeWithSelector(PythReportVerifier.UnknownFeed.selector, ETH));
        oracle.submit(r);
    }

    // ---------------------------------------------------------------- the first-price rule

    function test_RequestFillsAtTheFirstPriceAfterIt() public {
        (uint256 rid, uint256 pid) = _requestOpen(alice, M_ETH, true, 10_000 * USD, 2_100 * USD);
        uint64 created = uint64(block.timestamp);
        vm.warp(block.timestamp + 5);
        // later updates the executor might prefer are refused
        bytes memory later = _pyth(1_990, created + 3, created + 2);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        engine.executeRequest(rid, later);
        // so is the last update from before the request
        bytes memory before_ = _pyth(1_980, created, created - 1);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        engine.executeRequest(rid, before_);
        // the first update after it fills, whoever executes
        vm.prank(bob);
        engine.executeRequest(rid, _pyth(2_000, created + 1, created));
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Open));
        assertEq(engine.position(pid).entryPrice, PRICE);
        _checkSolvency();
    }

    function test_FirstPriceAfterAGapStillFills() public {
        // no Pyth update for a few seconds after the request: the next one is the first
        (uint256 rid, uint256 pid) = _requestOpen(alice, M_ETH, true, 10_000 * USD, 2_100 * USD);
        uint64 created = uint64(block.timestamp);
        vm.warp(block.timestamp + 10);
        vm.prank(keeper);
        engine.executeRequest(rid, _pyth(2_000, created + 7, created - 2));
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Open));
    }

    function test_FirstPriceAfterTimeoutRefused() public {
        (uint256 rid,) = _requestOpen(alice, M_ETH, true, 10_000 * USD, 2_100 * USD);
        uint64 created = uint64(block.timestamp);
        vm.warp(block.timestamp + 125);
        bytes memory r = _pyth(2_000, created + 121, created - 1);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        engine.executeRequest(rid, r);
    }

    function test_LiquidationsAndOrdersTakeAnyFreshUpdate() public {
        uint64 t = uint64(block.timestamp);
        // a fresh update that is not "first" is fine for submit (records, liquidations, orders)
        oracle.submit(_pyth(2_000, t, t));
        (uint256 stored,) = oracle.latestPrice(ETH);
        assertEq(stored, PRICE);
    }
}
