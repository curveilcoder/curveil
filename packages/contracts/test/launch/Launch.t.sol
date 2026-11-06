// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LaunchBase} from "./LaunchBase.sol";
import {LaunchTemplateRegistry} from "../../src/launch/LaunchTemplateRegistry.sol";
import {LaunchFactory} from "../../src/launch/LaunchFactory.sol";
import {BondingCurve} from "../../src/launch/BondingCurve.sol";
import {CurveilLaunchToken} from "../../src/launch/CurveilLaunchToken.sol";
import {LpEscrow} from "../../src/launch/LpEscrow.sol";
import {GraduationMigrator} from "../../src/launch/GraduationMigrator.sol";
import {AdmissionController} from "../../src/launch/AdmissionController.sol";
import {DammFactory} from "../../src/markets/DammFactory.sol";
import {DammPool} from "../../src/markets/DammPool.sol";

contract TemplateTest is LaunchBase {
    function test_DerivesVirtualReservesFromInventoryAndThreshold() public view {
        LaunchTemplateRegistry.Template memory t = templates.get(standardId);
        // Yv0 = M*T/(C-M) = 200m * 25,000 / 600m = 8,333.333333 USDG
        assertEq(t.virtualQuote, 8_333_333_333);
        assertApproxEqRel(t.virtualBase, 1_066_666_666e18, 1e12);
        assertEq(t.dammBaseFeeBps, 30);
        assertEq(t.dammMaxFeeBps, 100);
        (uint256 sold, uint256 dust, uint256 pTerm, uint256 pMig) = templates.simulate(standardId);
        assertLe(sold, CURVE);
        assertLe(dust, CURVE / 1e6);
        assertApproxEqRel(pTerm, pMig, 1e14); // within 0.01%
        // Opens at 125,000 USDG fully diluted: 25,000 USDG against 200m tokens.
        assertApproxEqRel(pMig, Math.mulDiv(THRESHOLD, 1e36, MIGRATION), 1e12);
    }

    function test_RejectsInvalidTemplates() public {
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        t.migrationSupply = MIGRATION + 1;
        vm.expectRevert(abi.encodeWithSelector(LaunchTemplateRegistry.InvalidTemplate.selector, "supply split"));
        templates.addTemplate(t, true);

        t = standardInput();
        t.quoteAsset = makeAddr("unlisted");
        vm.expectRevert(
            abi.encodeWithSelector(LaunchTemplateRegistry.InvalidTemplate.selector, "quote asset not admitted")
        );
        templates.addTemplate(t, true);

        t = standardInput();
        t.dammTier = 7;
        vm.expectRevert(abi.encodeWithSelector(LaunchTemplateRegistry.InvalidTemplate.selector, "DAMM tier disabled"));
        templates.addTemplate(t, true);

        t = standardInput();
        t.feeBps = 501;
        vm.expectRevert(abi.encodeWithSelector(LaunchTemplateRegistry.InvalidTemplate.selector, "curve fee"));
        templates.addTemplate(t, true);
    }

    function test_OnlyOwnerManagesTemplates() public {
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        vm.prank(alice);
        vm.expectRevert();
        templates.addTemplate(t, true);
        vm.prank(alice);
        vm.expectRevert();
        templates.setEnabled(standardId, false);
    }

    function test_DisablingTemplateLeavesLiveLaunchUntouched() public {
        (, BondingCurve curve) = _create(0);
        templates.setEnabled(standardId, false);
        _buy(curve, alice, 1000e6);
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.Trading));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.TemplateDisabled.selector, standardId));
        launchFactory.createLaunch(_params("X", "X"));
    }

    function _params(string memory name, string memory symbol)
        internal
        view
        returns (LaunchFactory.CreateParams memory)
    {
        return LaunchFactory.CreateParams({
            templateId: standardId,
            name: name,
            symbol: symbol,
            metadataURI: "",
            creatorRecipient: creatorFees,
            operator: address(0),
            initialBuy: 0,
            minTokensOut: 0,
            deadline: block.timestamp
        });
    }
}

contract LaunchCreationTest is LaunchBase {
    function test_CreatesFixedSupplyTokenHeldByCurve() public {
        (CurveilLaunchToken token, BondingCurve curve) = _create(0);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(address(curve)), SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.name(), "Petal Coin");
        assertEq(token.symbol(), "PETAL");
        assertEq(token.launchFactory(), address(launchFactory));
        assertEq(launchFactory.curveOf(address(token)), address(curve));
        assertTrue(launchFactory.isCurve(address(curve)));
        assertTrue(launchFactory.isLaunchToken(address(token)));
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.Created));
        assertEq(curve.creator(), creator);
        assertEq(curve.creatorRecipient(), creatorFees);
        assertEq(curve.inventory(), CURVE);
        assertEq(curve.progressBps(), 0);
        assertEq(launchFactory.launchCount(), 1);
    }

    function test_RejectsBadNamesAndSymbols() public {
        LaunchFactory.CreateParams memory p = LaunchFactory.CreateParams({
            templateId: standardId,
            name: "",
            symbol: "OK",
            metadataURI: "",
            creatorRecipient: creatorFees,
            operator: address(0),
            initialBuy: 0,
            minTokensOut: 0,
            deadline: block.timestamp
        });
        vm.expectRevert(LaunchFactory.InvalidName.selector);
        launchFactory.createLaunch(p);
        p.name = "Fine";
        p.symbol = "lower";
        vm.expectRevert(LaunchFactory.InvalidSymbol.selector);
        launchFactory.createLaunch(p);
        p.symbol = "WAYTOOLONGSYM";
        vm.expectRevert(LaunchFactory.InvalidSymbol.selector);
        launchFactory.createLaunch(p);
        p.symbol = "OK";
        p.operator = alice;
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.OperatorNotAllowed.selector, alice));
        launchFactory.createLaunch(p);
    }

    function test_InitialBuyGoesToCreator() public {
        uint256 before = usdg.balanceOf(creator);
        (CurveilLaunchToken token, BondingCurve curve) = _create(500e6);
        assertGt(token.balanceOf(creator), 0);
        assertEq(before - usdg.balanceOf(creator), 500e6);
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.Trading));
        assertEq(usdg.balanceOf(address(launchFactory)), 0);
    }

    function test_InitialBuyAboveThresholdRefundsTheRest() public {
        uint256 before = usdg.balanceOf(creator);
        (CurveilLaunchToken token, BondingCurve curve) = _create(40_000e6);
        uint256 spent = before - usdg.balanceOf(creator);
        assertLt(spent, 26_000e6);
        assertEq(curve.reserve(), THRESHOLD);
        assertEq(token.balanceOf(creator), CURVE);
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.GraduationReady));
        assertEq(usdg.balanceOf(address(launchFactory)), 0);
    }

    function test_PauseBlocksOnlyNewLaunches() public {
        (, BondingCurve curve) = _create(0);
        launchFactory.setCreationPaused(true);
        vm.prank(creator);
        vm.expectRevert(LaunchFactory.Paused.selector);
        launchFactory.createLaunch(
            LaunchFactory.CreateParams(standardId, "A", "A", "", creatorFees, address(0), 0, 0, block.timestamp)
        );
        _buy(curve, alice, 100e6);
    }

    function test_MigratorCanBeSetOnlyOnce() public {
        vm.expectRevert(LaunchFactory.MigratorAlreadySet.selector);
        launchFactory.setMigrator(alice);
    }
}

contract CurveTradingTest is LaunchBase {
    CurveilLaunchToken internal token;
    BondingCurve internal curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _create(0);
    }

    function test_BuyChargesOnePercentAndSplitsFees() public {
        (uint256 q, uint256 fee, uint256 used) = curve.quoteBuy(1000e6);
        assertEq(fee, 10e6);
        assertEq(used, 1000e6);
        (uint256 out, uint256 used2) = _buy(curve, alice, 1000e6);
        assertEq(out, q);
        assertEq(used2, 1000e6);
        assertEq(token.balanceOf(alice), out);
        assertEq(curve.reserve(), 990e6);
        assertEq(curve.creatorFees(), 5e6);
        assertEq(curve.protocolFees(), 5e6);
        assertEq(curve.operatorFees(), 0);
        assertEq(usdg.balanceOf(address(curve)), 1000e6);
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.Trading));
        assertEq(curve.progressBps(), 396); // 990 / 25,000
    }

    function test_FirstBuyPriceMatchesVirtualReserves() public {
        (uint256 out,) = _buy(curve, alice, 1e6);
        // 0.99 USDG net at about 7.8125e-6 USDG per token buys about 126,720 tokens.
        assertApproxEqRel(out, 126_720e18, 1e15);
    }

    function test_SellReturnsQuoteAndReducesProgress() public {
        (uint256 out,) = _buy(curve, alice, 5000e6);
        uint256 progress = curve.progressBps();
        (uint256 quoted, uint256 fee) = curve.quoteSell(out / 2);
        uint256 got = _sell(curve, alice, out / 2);
        assertEq(got, quoted);
        assertGt(fee, 0);
        assertLt(curve.progressBps(), progress);
        assertEq(usdg.balanceOf(address(curve)), curve.reserve() + curve.creatorFees() + curve.protocolFees());
    }

    function test_RoundTripNeverProfits() public {
        uint256 start = usdg.balanceOf(alice);
        (uint256 out,) = _buy(curve, alice, 3000e6);
        _sell(curve, alice, out);
        assertLt(usdg.balanceOf(alice), start);
        assertEq(curve.circulating(), 0);
        assertEq(curve.reserve(), 0);
    }

    function test_SlippageAndDeadlineAreEnforced() public {
        (uint256 q,,) = curve.quoteBuy(100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.InsufficientOutput.selector, q, q + 1));
        curve.buy(100e6, q + 1, alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(BondingCurve.Expired.selector);
        curve.buy(100e6, 0, alice, block.timestamp - 1);
    }

    function test_CannotSellMoreThanCirculating() public {
        _buy(curve, alice, 100e6);
        deal(address(token), bob, 1e30);
        vm.prank(bob);
        token.approve(address(curve), type(uint256).max);
        uint256 c = curve.circulating();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.ExceedsCirculating.selector, c + 1, c));
        curve.sell(c + 1, 0, bob, block.timestamp);
    }

    function test_ThresholdBuyIsPartiallyFilledAndStopsTrading() public {
        _buy(curve, alice, 10_000e6);
        uint256 before = usdg.balanceOf(bob);
        (uint256 out, uint256 used) = _buy(curve, bob, 50_000e6);
        assertEq(before - usdg.balanceOf(bob), used);
        assertLt(used, 50_000e6);
        assertEq(curve.reserve(), THRESHOLD);
        assertEq(curve.inventory(), 0);
        assertEq(token.balanceOf(alice) + out, CURVE);
        assertEq(curve.progressBps(), 10_000);
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.GraduationReady));

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.NotTrading.selector, BondingCurve.State.GraduationReady));
        curve.buy(1e6, 0, carol, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.NotTrading.selector, BondingCurve.State.GraduationReady));
        curve.sell(1e18, 0, alice, block.timestamp);
    }

    function test_FeeBucketsPayFixedRecipients() public {
        _buy(curve, alice, 2000e6);
        vm.prank(bob);
        curve.claimFees(BondingCurve.Bucket.Creator);
        curve.claimFees(BondingCurve.Bucket.Protocol);
        assertEq(usdg.balanceOf(creatorFees), 10e6);
        assertEq(usdg.balanceOf(feeTo), 10e6);
        assertEq(curve.creatorFees(), 0);
        assertEq(usdg.balanceOf(address(curve)), curve.reserve());
    }

    function test_OnlyCreatorRecipientCanHandOver() public {
        vm.prank(creator);
        vm.expectRevert(BondingCurve.NotCreatorRecipient.selector);
        curve.setCreatorRecipient(creator);
        vm.prank(creatorFees);
        curve.setCreatorRecipient(creator);
        assertEq(curve.creatorRecipient(), creator);
    }

    function test_CannotGraduateBeforeThreshold() public {
        _buy(curve, alice, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.NotGraduationReady.selector, BondingCurve.State.Trading));
        curve.graduate();
    }

    function test_NoPoolCanBeCreatedBeforeGraduation() public {
        _buy(curve, alice, 1000e6);
        vm.expectRevert(abi.encodeWithSelector(DammFactory.AssetNotAdmitted.selector, address(token)));
        dammFactory.createPool(address(token), address(usdg), 0);
        vm.expectRevert(
            abi.encodeWithSelector(AdmissionController.LaunchTokenOnlyAtGraduation.selector, address(token))
        );
        admission.admit(address(token), "early");
        vm.expectRevert(AdmissionController.NotMigrator.selector);
        admission.admitLaunchToken(address(token));
    }

    function test_OnlyCurvesCanMigrate() public {
        vm.expectRevert(GraduationMigrator.NotCurve.selector);
        migrator.migrate(1, 1);
    }

    function testFuzz_QuoteMatchesExecution(uint256 a, uint256 b) public {
        a = bound(a, 1, 30_000e6);
        b = bound(b, 1, 30_000e6);
        (uint256 q,, uint256 u) = curve.quoteBuy(a);
        if (q == 0) return;
        (uint256 out, uint256 used) = _buy(curve, alice, a);
        assertEq(out, q);
        assertEq(used, u);
        if (curve.state() != BondingCurve.State.Trading) return;
        uint256 sellAmt = bound(b, 1, token.balanceOf(alice));
        (uint256 qs,) = curve.quoteSell(sellAmt);
        if (qs == 0) return;
        assertEq(_sell(curve, alice, sellAmt), qs);
        (uint256 vb, uint256 vq) = curve.virtualReserves();
        assertGe(vb * vq, curve.k());
    }
}

contract GraduationTest is LaunchBase {
    CurveilLaunchToken internal token;
    BondingCurve internal curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _create(0);
        _buy(curve, alice, 12_000e6);
        _buy(curve, bob, 20_000e6);
    }

    function _graduate() internal returns (DammPool pool, uint256 liquidity) {
        vm.prank(carol);
        (address p, uint256 l) = curve.graduate();
        return (DammPool(p), l);
    }

    function test_AnyoneGraduatesIntoCommittedPool() public {
        uint256 reserve = curve.reserve();
        uint256 tokensLeft = token.balanceOf(address(curve));
        (DammPool pool, uint256 liquidity) = _graduate();
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.Graduated));
        assertEq(curve.pool(), address(pool));
        assertEq(dammFactory.getPool(address(token), address(usdg)), address(pool));
        assertTrue(registry.isAdmitted(address(token)));
        (uint128 r0, uint128 r1) = pool.getReserves();
        (uint256 rt, uint256 rq) = pool.token0() == address(token) ? (r0, r1) : (r1, r0);
        assertEq(rt, tokensLeft);
        assertEq(rq, reserve);
        assertGe(tokensLeft, MIGRATION);
        assertEq(pool.balanceOf(address(escrow)), liquidity);
        // fees stay in the curve for their recipients
        assertEq(usdg.balanceOf(address(curve)), curve.creatorFees() + curve.protocolFees());
        assertEq(token.balanceOf(address(curve)), 0);
        assertEq(token.balanceOf(address(migrator)), 0);
        assertEq(usdg.balanceOf(address(migrator)), 0);
    }

    function test_PoolOpensAtTheCurvePrice() public {
        (uint256 vb, uint256 vq) = curve.virtualReserves();
        (DammPool pool,) = _graduate();
        (uint128 r0, uint128 r1) = pool.getReserves();
        (uint256 rt, uint256 rq) = pool.token0() == address(token) ? (r0, r1) : (r1, r0);
        assertApproxEqRel(Math.mulDiv(rq, 1e36, rt), Math.mulDiv(vq, 1e36, vb), 1e14);
    }

    function test_LocksSplitTwentyEightyWithCommittedUnlocks() public {
        (DammPool pool, uint256 liquidity) = _graduate();
        LpEscrow.Lock memory c = escrow.getLock(0);
        LpEscrow.Lock memory p = escrow.getLock(1);
        assertEq(c.lpToken, address(pool));
        assertEq(c.beneficiary, creatorFees);
        assertEq(p.beneficiary, treasury);
        assertEq(c.amount, liquidity * 2000 / 10_000);
        assertEq(c.amount + p.amount, liquidity);
        assertEq(c.unlockAt, block.timestamp + 180 days);
        assertEq(p.unlockAt, block.timestamp + 365 days);
    }

    function test_GraduationHappensOnce() public {
        _graduate();
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.NotGraduationReady.selector, BondingCurve.State.Graduated));
        curve.graduate();
    }

    function test_FeeConfigChangeBlocksMigrationAndKeepsReserves() public {
        DammPool.FeeParams memory fp = defaultTier();
        fp.baseFeeBps = 25;
        dammFactory.setTier(0, fp, true);
        uint256 reserve = curve.reserve();
        vm.expectRevert(GraduationMigrator.FeeConfigMismatch.selector);
        curve.graduate();
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.GraduationReady));
        assertEq(usdg.balanceOf(address(curve)), reserve + curve.creatorFees() + curve.protocolFees());
        // Restoring the committed configuration lets migration proceed.
        dammFactory.setTier(0, defaultTier(), true);
        curve.graduate();
    }

    function test_EscrowRejectsEarlyAndUnauthorisedClaims() public {
        _graduate();
        vm.prank(alice);
        vm.expectRevert(LpEscrow.NotBeneficiary.selector);
        escrow.claim(0, alice);
        LpEscrow.Lock memory c = escrow.getLock(0);
        vm.prank(creatorFees);
        vm.expectRevert(abi.encodeWithSelector(LpEscrow.StillLocked.selector, c.unlockAt));
        escrow.claim(0, creatorFees);
        vm.warp(c.unlockAt);
        vm.prank(creatorFees);
        escrow.claim(0, creatorFees);
        assertEq(DammPool(c.lpToken).balanceOf(creatorFees), c.amount);
        vm.prank(creatorFees);
        vm.expectRevert(LpEscrow.AlreadyClaimed.selector);
        escrow.claim(0, creatorFees);
        uint64 protocolUnlock = escrow.getLock(1).unlockAt;
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(LpEscrow.StillLocked.selector, protocolUnlock));
        escrow.claim(1, treasury);
    }

    function test_LockedSharesEarnTradingFees() public {
        (DammPool pool,) = _graduate();
        usdg.mint(alice, 1e12);
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
        _swap(alice, address(pool), address(usdg), address(token), 5_000e6);
        _swap(alice, address(pool), address(token), address(usdg), 10_000_000e18);

        (uint256 c0, uint256 c1) = escrow.pendingFees(0);
        (uint256 p0, uint256 p1) = escrow.pendingFees(1);
        assertGt(c0 + c1, 0);
        // 20/80 split of the fees, give or take rounding
        assertApproxEqRel(p0, c0 * 4, 1e12);
        assertApproxEqRel(p1, c1 * 4, 1e12);

        vm.prank(creatorFees);
        (uint256 g0, uint256 g1) = escrow.claimFees(0, creatorFees);
        assertEq(g0, c0);
        assertEq(g1, c1);
        (uint256 again0, uint256 again1) = escrow.pendingFees(0);
        assertEq(again0 + again1, 0);
    }

    function _predictedPool() internal view returns (address) {
        (address t0, address t1) =
            address(token) < address(usdg) ? (address(token), address(usdg)) : (address(usdg), address(token));
        bytes32 initHash = keccak256(abi.encodePacked(type(DammPool).creationCode, abi.encode(t0, t1, defaultTier())));
        return vm.computeCreate2Address(keccak256(abi.encode(t0, t1)), initHash, address(dammFactory));
    }

    function _poolPrice(DammPool pool) internal view returns (uint256) {
        (uint128 r0, uint128 r1) = pool.getReserves();
        (uint256 rt, uint256 rq) = pool.token0() == address(token) ? (r0, r1) : (r1, r0);
        return Math.mulDiv(rq, 1e36, rt);
    }

    function test_TokensSentToCurveAreBurnedAndPriceHolds() public {
        (uint256 vb, uint256 vq) = curve.virtualReserves();
        vm.prank(alice);
        token.transfer(address(curve), 5_000_000e18);
        (DammPool pool,) = _graduate();
        assertEq(token.balanceOf(address(0xdEaD)), 5_000_000e18);
        assertApproxEqRel(_poolPrice(pool), Math.mulDiv(vq, 1e36, vb), 1e14);
    }

    function test_GiftsToPoolAddressAreAbsorbed() public {
        (uint256 vb, uint256 vq) = curve.virtualReserves();
        address predicted = _predictedPool();
        vm.prank(alice);
        token.transfer(predicted, 10_000_000e18);
        vm.prank(bob);
        usdg.transfer(predicted, 1_000e6);
        uint256 feeToBefore = usdg.balanceOf(feeTo);
        (DammPool pool,) = _graduate();
        assertEq(address(pool), predicted);
        assertApproxEqRel(_poolPrice(pool), Math.mulDiv(vq, 1e36, vb), 1e14);
        assertEq(token.balanceOf(address(0xdEaD)), 10_000_000e18);
        assertEq(usdg.balanceOf(feeTo) - feeToBefore, 1_000e6);
    }

    function test_OversizedGiftCannotBlockGraduation() public {
        address predicted = _predictedPool();
        uint256 gift = token.balanceOf(alice);
        assertGt(gift, MIGRATION + token.balanceOf(address(curve)) - MIGRATION);
        vm.prank(alice);
        token.transfer(predicted, gift);
        vm.expectEmit(true, false, false, false, address(migrator));
        emit GraduationMigrator.GiftsExceededMigration(predicted, 0, 0);
        (DammPool pool, uint256 liquidity) = _graduate();
        assertGt(liquidity, 0);
        assertEq(uint8(curve.state()), uint8(BondingCurve.State.Graduated));
        assertEq(pool.balanceOf(address(escrow)), liquidity);
    }

    function test_BeneficiaryCanHandOverLock() public {
        _graduate();
        vm.prank(creatorFees);
        escrow.transferBeneficiary(0, creator);
        assertEq(escrow.getLock(0).beneficiary, creator);
        vm.warp(block.timestamp + 180 days);
        vm.prank(creatorFees);
        vm.expectRevert(LpEscrow.NotBeneficiary.selector);
        escrow.claim(0, creatorFees);
        vm.prank(creator);
        escrow.claim(0, creator);
    }

    function test_OnlyLockersCreateLocksAndOnlyWithBacking() public {
        (DammPool pool,) = _graduate();
        address[] memory who = new address[](1);
        uint256[] memory amt = new uint256[](1);
        uint64[] memory at = new uint64[](1);
        who[0] = alice;
        amt[0] = 1;
        vm.prank(alice);
        vm.expectRevert(LpEscrow.NotLocker.selector);
        escrow.createLocks(address(pool), who, amt, at);
        escrow.setLocker(address(this), true);
        uint256 held = pool.balanceOf(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(LpEscrow.Unbacked.selector, held + 1, held));
        escrow.createLocks(address(pool), who, amt, at);
    }
}
