// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {MarketsBase} from "../markets/MarketsBase.sol";
import {AdmissionController} from "../../src/launch/AdmissionController.sol";
import {LaunchTemplateRegistry} from "../../src/launch/LaunchTemplateRegistry.sol";
import {LaunchFactory} from "../../src/launch/LaunchFactory.sol";
import {GraduationMigrator} from "../../src/launch/GraduationMigrator.sol";
import {LpEscrow} from "../../src/launch/LpEscrow.sol";
import {BondingCurve} from "../../src/launch/BondingCurve.sol";
import {CurveilLaunchToken} from "../../src/launch/CurveilLaunchToken.sol";
import {ILaunchFactory} from "../../src/launch/interfaces/ILaunch.sol";

abstract contract LaunchBase is MarketsBase {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant CURVE = 800_000_000e18;
    uint256 internal constant MIGRATION = 200_000_000e18;
    uint256 internal constant THRESHOLD = 25_000e6;

    AdmissionController internal admission;
    LaunchTemplateRegistry internal templates;
    LaunchFactory internal launchFactory;
    GraduationMigrator internal migrator;
    LpEscrow internal escrow;

    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal creatorFees = makeAddr("creatorFees");
    uint256 internal standardId;

    function setUp() public virtual override {
        super.setUp();
        admission = new AdmissionController(address(this), registry);
        registry.transferOwnership(address(admission));
        admission.acceptRegistryOwnership();

        templates = new LaunchTemplateRegistry(address(this), registry, dammFactory);
        escrow = new LpEscrow(address(this));
        launchFactory = new LaunchFactory(address(this), templates);
        migrator =
            new GraduationMigrator(ILaunchFactory(address(launchFactory)), templates, dammFactory, admission, escrow);
        launchFactory.setMigrator(address(migrator));
        escrow.setLocker(address(migrator), true);
        admission.setLaunchModules(ILaunchFactory(address(launchFactory)), address(migrator));
        standardId = templates.addTemplate(standardInput(), true);

        usdg.mint(creator, 1e15);
        address[4] memory users = [alice, bob, carol, creator];
        for (uint256 i; i < users.length; ++i) {
            vm.prank(users[i]);
            usdg.approve(address(launchFactory), type(uint256).max);
        }
    }

    function standardInput() internal view returns (LaunchTemplateRegistry.TemplateInput memory) {
        return LaunchTemplateRegistry.TemplateInput({
            label: "Standard v1",
            quoteAsset: address(usdg),
            totalSupply: SUPPLY,
            curveSupply: CURVE,
            migrationSupply: MIGRATION,
            graduationThreshold: THRESHOLD,
            feeBps: 100,
            creatorFeeShareBps: 5000,
            dammTier: 0,
            priceToleranceBps: 200,
            creatorLpBps: 2000,
            creatorLockSeconds: 180 days,
            protocolLockSeconds: 365 days,
            protocolFeeRecipient: feeTo,
            protocolLpRecipient: treasury
        });
    }

    function _create(uint256 initialBuy) internal returns (CurveilLaunchToken token, BondingCurve curve) {
        vm.prank(creator);
        (address t, address c) = launchFactory.createLaunch(
            LaunchFactory.CreateParams({
                templateId: standardId,
                name: "Petal Coin",
                symbol: "PETAL",
                metadataURI: "https://api.curveil.test/v1/launches/metadata/abc",
                creatorRecipient: creatorFees,
                operator: address(0),
                initialBuy: initialBuy,
                minTokensOut: 0,
                deadline: block.timestamp
            })
        );
        token = CurveilLaunchToken(t);
        curve = BondingCurve(c);
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            vm.startPrank(users[i]);
            usdg.approve(c, type(uint256).max);
            token.approve(c, type(uint256).max);
            vm.stopPrank();
        }
    }

    function _buy(BondingCurve curve, address who, uint256 quoteIn) internal returns (uint256 out, uint256 used) {
        vm.prank(who);
        return curve.buy(quoteIn, 0, who, block.timestamp);
    }

    function _sell(BondingCurve curve, address who, uint256 tokensIn) internal returns (uint256 out) {
        vm.prank(who);
        return curve.sell(tokensIn, 0, who, block.timestamp);
    }
}
