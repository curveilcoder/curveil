// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchBase} from "../launch/LaunchBase.sol";
import {LaunchFactory, ILaunchpadRegistry} from "../../src/launch/LaunchFactory.sol";
import {LaunchpadRegistry, ITemplateCount} from "../../src/factory/LaunchpadRegistry.sol";
import {Guarded} from "../../src/shared/Guarded.sol";
import {BondingCurve} from "../../src/launch/BondingCurve.sol";
import {CurveilLaunchToken} from "../../src/launch/CurveilLaunchToken.sol";

/// The guardian (the Safe) can switch new risk off at once; only the owner (the timelock) can
/// switch it back on, and the guardian can never touch a live launch or block an exit.
contract GuardianTest is LaunchBase {
    LaunchpadRegistry internal pads;
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    address internal opAdmin = makeAddr("opAdmin");

    function setUp() public override {
        super.setUp();
        pads = new LaunchpadRegistry(address(this), ITemplateCount(address(templates)), 5000);
        launchFactory.setLaunchpads(ILaunchpadRegistry(address(pads)));
        launchFactory.setGuardian(guardian);
        admission.setGuardian(guardian);
        pads.setGuardian(guardian);
    }

    function test_onlyOwnerSetsTheGuardian() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        launchFactory.setGuardian(stranger);
    }

    function test_guardianPausesLaunchesButCannotResume() public {
        vm.prank(stranger);
        vm.expectRevert(Guarded.NotGuardian.selector);
        launchFactory.setCreationPaused(true);

        vm.prank(guardian);
        launchFactory.setCreationPaused(true);
        assertTrue(launchFactory.creationPaused());

        vm.prank(guardian);
        vm.expectRevert(Guarded.NotGuardian.selector);
        launchFactory.setCreationPaused(false);

        launchFactory.setCreationPaused(false); // owner
        assertFalse(launchFactory.creationPaused());
    }

    function test_pauseLeavesLiveLaunchesTrading() public {
        (CurveilLaunchToken token, BondingCurve curve) = _create(0);
        vm.prank(guardian);
        launchFactory.setCreationPaused(true);

        vm.prank(alice);
        usdg.approve(address(curve), type(uint256).max);
        vm.prank(alice);
        (uint256 got,) = curve.buy(1_000e6, 0, alice, block.timestamp);
        assertGt(got, 0);
        vm.prank(alice);
        token.approve(address(curve), type(uint256).max);
        vm.prank(alice);
        uint256 back = curve.sell(got / 2, 0, alice, block.timestamp);
        assertGt(back, 0, "exits stay open");
    }

    function test_guardianSuspendsAnAssetButCannotReinstate() public {
        vm.prank(stranger);
        vm.expectRevert(Guarded.NotGuardian.selector);
        admission.suspend(address(weth));

        vm.prank(guardian);
        admission.suspend(address(weth));
        assertFalse(registry.isAdmitted(address(weth)));

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        admission.reinstate(address(weth));
        admission.reinstate(address(weth));
        assertTrue(registry.isAdmitted(address(weth)));
    }

    function test_guardianSuspendsALaunchpadButCannotLiftIt() public {
        address[] memory rs = new address[](1);
        rs[0] = opAdmin;
        uint16[] memory ws = new uint16[](1);
        ws[0] = 10_000;
        vm.prank(opAdmin);
        address op = pads.register("petal-pad", "", 2000, uint64(1 << standardId), rs, ws);

        vm.prank(stranger);
        vm.expectRevert(Guarded.NotGuardian.selector);
        pads.setSuspended(op, true);

        vm.prank(guardian);
        pads.setSuspended(op, true);
        (bool allowed,) = pads.operatorTerms(op, standardId);
        assertFalse(allowed);

        vm.prank(guardian);
        vm.expectRevert(Guarded.NotGuardian.selector);
        pads.setSuspended(op, false);
        pads.setSuspended(op, false);
        (allowed,) = pads.operatorTerms(op, standardId);
        assertTrue(allowed);
    }

    function test_noGuardianMeansOwnerOnly() public {
        launchFactory.setGuardian(address(0));
        vm.prank(address(0));
        vm.expectRevert(Guarded.NotGuardian.selector);
        launchFactory.setCreationPaused(true);
    }
}
