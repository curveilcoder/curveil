// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PerpsBase, MockAggregator} from "./PerpsBase.sol";
import {OracleAdapter} from "../../src/perps/OracleAdapter.sol";
import {SignedReportVerifier} from "../../src/perps/oracle/SignedReportVerifier.sol";

contract OracleAdapterTest is PerpsBase {
    function test_AcceptsSignedReportAndRecordsNewest() public {
        bytes memory r = _fresh(ETH, PRICE);
        (uint256 price, uint256 ts) = oracle.priceFor(ETH, r, OracleAdapter.Use.Open);
        assertEq(price, PRICE);
        assertEq(ts, block.timestamp);
        (uint256 stored, uint256 at) = oracle.latestPrice(ETH);
        assertEq(stored, PRICE);
        assertEq(at, block.timestamp);
        // an older report is valid but does not replace the newest
        oracle.submit(_report(ETH, 1_000e18, block.timestamp - 1));
        (stored,) = oracle.latestPrice(ETH);
        assertEq(stored, PRICE);
    }

    function test_RejectsUnknownSigner() public {
        uint256 otherPk = 0xB0B;
        bytes32 digest = verifier.reportDigest(ETH, PRICE, uint64(block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherPk, digest);
        bytes memory report = abi.encode(ETH, PRICE, uint64(block.timestamp), abi.encodePacked(r, s, v));
        vm.expectRevert(abi.encodeWithSelector(SignedReportVerifier.UnknownSigner.selector, vm.addr(otherPk)));
        oracle.submit(report);
    }

    function test_RejectsTamperedReport() public {
        bytes memory r = _report(ETH, PRICE, block.timestamp);
        (bytes32 f,, uint64 ts, bytes memory sig) = abi.decode(r, (bytes32, uint256, uint64, bytes));
        vm.expectRevert();
        oracle.submit(abi.encode(f, PRICE * 2, ts, sig));
    }

    function test_RejectsWrongFeedOldFutureZero() public {
        bytes memory btc = _report(BTC, PRICE, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.WrongFeed.selector, ETH, BTC));
        oracle.priceFor(ETH, btc, OracleAdapter.Use.Reduce);

        bytes memory old = _report(ETH, PRICE, block.timestamp - 61);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.ReportTooOld.selector, block.timestamp - 61, 60));
        oracle.submit(old);

        bytes memory future = _report(ETH, PRICE, block.timestamp + 6);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.ReportInFuture.selector, block.timestamp + 6));
        oracle.submit(future);
        oracle.submit(_report(ETH, PRICE, block.timestamp + 5)); // small clock skew is fine

        bytes memory zero = _report(ETH, 0, block.timestamp);
        vm.expectRevert(OracleAdapter.BadPrice.selector);
        oracle.submit(zero);
    }

    function test_DisabledFeedRefused() public {
        vm.prank(admin);
        oracle.setFeed(ETH, false, 60, address(0), 0, 0);
        bytes memory r = _report(ETH, PRICE, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.UnknownFeed.selector, ETH));
        oracle.submit(r);
    }

    function test_ReferenceDeviationAndStaleness() public {
        MockAggregator ref = new MockAggregator(8);
        ref.set(2_000e8, block.timestamp, block.timestamp);
        vm.prank(admin);
        oracle.setFeed(ETH, true, 60, address(ref), 1 hours, 200);

        oracle.priceFor(ETH, _fresh(ETH, 2_030e18), OracleAdapter.Use.Open); // 1.5% off: fine
        bytes memory far = _fresh(ETH, 2_050e18); // 2.5% off
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.PriceDeviates.selector, 2_050e18, 2_000e18));
        oracle.priceFor(ETH, far, OracleAdapter.Use.Reduce);

        // a stale reference blocks new risk, not exits
        vm.warp(block.timestamp + 1 hours + 1);
        bytes memory r = _fresh(ETH, 2_500e18);
        vm.expectRevert(abi.encodeWithSelector(OracleAdapter.ReferenceStale.selector, ETH));
        oracle.priceFor(ETH, r, OracleAdapter.Use.Open);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Reduce);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Liquidate);
    }

    function test_SequencerDownAndGracePeriod() public {
        MockAggregator seq = new MockAggregator(0);
        seq.set(1, block.timestamp, block.timestamp); // down
        vm.prank(admin);
        oracle.setSequencerFeed(address(seq), 3600);
        bytes memory r = _fresh(ETH, PRICE);
        vm.expectRevert(OracleAdapter.SequencerDown.selector);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Open);
        vm.expectRevert(OracleAdapter.SequencerDown.selector);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Liquidate);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Reduce); // exits continue

        seq.set(0, block.timestamp, block.timestamp); // back up just now
        r = _fresh(ETH, PRICE);
        vm.expectRevert(OracleAdapter.GracePeriodNotOver.selector);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Open);
        assertFalse(oracle.sequencerReady());
        vm.warp(block.timestamp + 3600);
        r = _fresh(ETH, PRICE);
        oracle.priceFor(ETH, r, OracleAdapter.Use.Open);
        assertTrue(oracle.sequencerReady());
    }

    function test_AdminOnly() public {
        vm.expectRevert();
        oracle.setFeed(ETH, true, 60, address(0), 0, 0);
        vm.expectRevert();
        oracle.setVerifier(verifier);
        vm.prank(admin);
        vm.expectRevert(OracleAdapter.BadConfig.selector);
        oracle.setFeed(ETH, true, 2 hours, address(0), 0, 0);
    }

    function test_VerifierRefusesMainnet() public {
        vm.chainId(4663);
        vm.expectRevert(SignedReportVerifier.TestnetOnly.selector);
        new SignedReportVerifier(admin, signer);
    }

    function test_VerifierSignerRotation() public {
        vm.prank(admin);
        verifier.setSigner(signer, false);
        bytes memory r = _report(ETH, PRICE, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(SignedReportVerifier.UnknownSigner.selector, signer));
        oracle.submit(r);
    }
}
