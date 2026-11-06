// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchBase} from "../launch/LaunchBase.sol";
import {LaunchpadRegistry, ITemplateCount} from "../../src/factory/LaunchpadRegistry.sol";
import {FeeSplitter} from "../../src/factory/FeeSplitter.sol";

/// Input checks and permissions of the launchpad registry and its fee splitters.
contract RegistryChecksTest is LaunchBase {
    LaunchpadRegistry internal pads;
    address internal opAdmin = makeAddr("opAdmin");
    address internal stranger = makeAddr("stranger");
    address internal r1 = makeAddr("r1");
    address internal r2 = makeAddr("r2");

    function setUp() public override {
        super.setUp();
        pads = new LaunchpadRegistry(address(this), ITemplateCount(address(templates)), 5000);
    }

    function _one() internal view returns (address[] memory rs, uint16[] memory ws) {
        rs = new address[](1);
        rs[0] = r1;
        ws = new uint16[](1);
        ws[0] = 10_000;
    }

    function _reg(string memory slug) internal returns (address) {
        (address[] memory rs, uint16[] memory ws) = _one();
        vm.prank(opAdmin);
        return pads.register(slug, "", 1000, 1, rs, ws);
    }

    function test_constructorCapsTheShare() public {
        vm.expectRevert(LaunchpadRegistry.ShareTooHigh.selector);
        new LaunchpadRegistry(address(this), ITemplateCount(address(templates)), 10_001);
    }

    function test_slugRules() public {
        (address[] memory rs, uint16[] memory ws) = _one();
        string[6] memory bad = ["ab", "-pad", "pad-", "Pad", "pad_one", "a234567890123456789012345678901234"];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(LaunchpadRegistry.BadSlug.selector);
            pads.register(bad[i], "", 0, 1, rs, ws);
        }
        address op = _reg("pad-1");
        assertEq(pads.predictOperator("pad-1"), op);
        vm.expectRevert(LaunchpadRegistry.SlugTaken.selector);
        pads.register("pad-1", "", 0, 1, rs, ws);
        assertTrue(pads.isOperator(op));
        assertEq(pads.operatorCount(), 1);
        assertEq(pads.operatorAt(0), op);
    }

    function test_registerChecksTermsAndBrand() public {
        (address[] memory rs, uint16[] memory ws) = _one();
        vm.expectRevert(LaunchpadRegistry.ShareTooHigh.selector);
        pads.register("pad-a", "", 5001, 1, rs, ws);
        vm.expectRevert(LaunchpadRegistry.BadTemplates.selector);
        pads.register("pad-a", "", 0, 0, rs, ws);
        vm.expectRevert(LaunchpadRegistry.BadTemplates.selector);
        pads.register("pad-a", "", 0, 2, rs, ws); // only template 0 exists
        vm.expectRevert(LaunchpadRegistry.URITooLong.selector);
        pads.register("pad-a", string(new bytes(2049)), 0, 1, rs, ws);
    }

    function test_splitterRecipientRules() public {
        address[] memory rs = new address[](2);
        uint16[] memory ws = new uint16[](2);
        rs[0] = r1;
        rs[1] = r1;
        ws[0] = 5000;
        ws[1] = 5000;
        vm.expectRevert(FeeSplitter.BadRecipients.selector);
        pads.register("pad-b", "", 0, 1, rs, ws); // duplicate
        rs[1] = r2;
        ws[1] = 4000;
        vm.expectRevert(FeeSplitter.BadRecipients.selector);
        pads.register("pad-b", "", 0, 1, rs, ws); // weights do not add up
        ws[1] = 0;
        vm.expectRevert(FeeSplitter.BadRecipients.selector);
        pads.register("pad-b", "", 0, 1, rs, ws); // zero weight
        rs[1] = address(0);
        ws[1] = 5000;
        vm.expectRevert(FeeSplitter.BadRecipients.selector);
        pads.register("pad-b", "", 0, 1, rs, ws); // zero address
        address[] memory none = new address[](0);
        uint16[] memory noWeights = new uint16[](0);
        vm.expectRevert(FeeSplitter.BadRecipients.selector);
        pads.register("pad-b", "", 0, 1, none, noWeights);
    }

    function test_splitterOnlyTakesOrdersFromTheRegistry() public {
        address op = _reg("pad-c");
        (address[] memory rs, uint16[] memory ws) = _one();
        vm.expectRevert(FeeSplitter.AlreadyInitialised.selector);
        FeeSplitter(op).initialise(stranger, rs, ws);
        address[] memory tokens = new address[](0);
        vm.prank(opAdmin);
        vm.expectRevert(FeeSplitter.NotRegistry.selector);
        FeeSplitter(op).setRecipients(rs, ws, tokens);
    }

    function test_adminOnlySettersAndChecks() public {
        address op = _reg("pad-d");
        vm.startPrank(stranger);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setBrand(op, "x");
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setShare(op, 1);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setTemplates(op, 1);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setActive(op, false);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.transferAdmin(op, stranger);
        vm.expectRevert(LaunchpadRegistry.UnknownOperator.selector);
        pads.setBrand(stranger, "x");
        vm.stopPrank();

        vm.startPrank(opAdmin);
        vm.expectRevert(LaunchpadRegistry.URITooLong.selector);
        pads.setBrand(op, string(new bytes(2049)));
        vm.expectRevert(LaunchpadRegistry.ShareTooHigh.selector);
        pads.setShare(op, 5001);
        vm.expectRevert(LaunchpadRegistry.BadTemplates.selector);
        pads.setTemplates(op, 0);
        pads.setBrand(op, "data:application/json,{}");
        pads.setShare(op, 2500);
        pads.setTemplates(op, 1);
        pads.setActive(op, false);
        vm.stopPrank();
        LaunchpadRegistry.Operator memory o = pads.operatorInfo(op);
        assertEq(o.shareBps, 2500);
        assertFalse(o.active);
        (bool allowed,) = pads.operatorTerms(op, standardId);
        assertFalse(allowed, "inactive pads take no launches");
    }

    function test_twoStepAdminTransfer() public {
        address op = _reg("pad-e");
        vm.prank(opAdmin);
        pads.transferAdmin(op, r2);
        vm.prank(stranger);
        vm.expectRevert(LaunchpadRegistry.NotPendingAdmin.selector);
        pads.acceptAdmin(op);
        vm.expectRevert(LaunchpadRegistry.UnknownOperator.selector);
        pads.acceptAdmin(stranger);
        vm.prank(r2);
        pads.acceptAdmin(op);
        assertEq(pads.operatorInfo(op).admin, r2);
        vm.prank(opAdmin);
        vm.expectRevert(LaunchpadRegistry.NotAdmin.selector);
        pads.setShare(op, 1);
    }

    function test_capAppliesToTermsAndOnlyOwnerSetsIt() public {
        address op = _reg("pad-f");
        vm.prank(opAdmin);
        pads.setShare(op, 4000);
        pads.setMaxShare(3000);
        (, uint16 share) = pads.operatorTerms(op, standardId);
        assertEq(share, 3000);
        vm.expectRevert(LaunchpadRegistry.ShareTooHigh.selector);
        pads.setMaxShare(10_001);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        pads.setMaxShare(1);
        vm.expectRevert(LaunchpadRegistry.UnknownOperator.selector);
        pads.setSuspended(stranger, true);
        (bool allowed,) = pads.operatorTerms(op, 64);
        assertFalse(allowed, "template ids past the mask are refused");
    }
}
