// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LaunchBase} from "./LaunchBase.sol";
import {LaunchTemplateRegistry} from "../../src/launch/LaunchTemplateRegistry.sol";
import {LaunchFactory} from "../../src/launch/LaunchFactory.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

/// Every bound a template must meet, and what the owner can and cannot do with one.
contract TemplatesTest is LaunchBase {
    function _expect(LaunchTemplateRegistry.TemplateInput memory t, string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(LaunchTemplateRegistry.InvalidTemplate.selector, reason));
        templates.addTemplate(t, true);
    }

    function test_labelBounds() public {
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        t.label = "";
        _expect(t, "label");
        t.label = "0123456789012345678901234567890123456789012345678"; // 49 bytes
        _expect(t, "label");
    }

    function test_quoteAssetMustBeAdmitted() public {
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        t.quoteAsset = address(new TestToken("Other", "OTH", 6, address(this)));
        _expect(t, "quote asset not admitted");
    }

    function test_supplyBounds() public {
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        t.curveSupply += 1;
        _expect(t, "supply split");
        t = standardInput();
        t.migrationSupply = 0;
        t.curveSupply = t.totalSupply;
        _expect(t, "inventory");
        t = standardInput();
        t.migrationSupply = t.totalSupply / 2;
        t.curveSupply = t.totalSupply / 2;
        _expect(t, "inventory");
        t = standardInput();
        t.totalSupply = 2e36;
        t.curveSupply = 16e35;
        t.migrationSupply = 4e35;
        _expect(t, "supply too large");
    }

    function test_economicBounds() public {
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        t.graduationThreshold = 0;
        _expect(t, "threshold");
        t = standardInput();
        t.graduationThreshold = 1e30 + 1;
        _expect(t, "threshold");
        t = standardInput();
        t.feeBps = 0;
        _expect(t, "curve fee");
        t = standardInput();
        t.feeBps = 501;
        _expect(t, "curve fee");
        t = standardInput();
        t.creatorFeeShareBps = 10_001;
        _expect(t, "creator fee share");
        t = standardInput();
        t.priceToleranceBps = 0;
        _expect(t, "tolerance");
        t = standardInput();
        t.priceToleranceBps = 1001;
        _expect(t, "tolerance");
        t = standardInput();
        t.creatorLpBps = 10_001;
        _expect(t, "creator LP share");
        t = standardInput();
        t.creatorLockSeconds = 4 * 365 days + 1;
        _expect(t, "lock");
        t = standardInput();
        t.protocolLockSeconds = 4 * 365 days + 1;
        _expect(t, "lock");
        t = standardInput();
        t.protocolFeeRecipient = address(0);
        _expect(t, "recipient");
        t = standardInput();
        t.protocolLpRecipient = address(0);
        _expect(t, "recipient");
        t = standardInput();
        t.dammTier = 7;
        _expect(t, "DAMM tier disabled");
    }

    function test_onlyOwnerAddsOrToggles() public {
        address stranger = makeAddr("stranger");
        LaunchTemplateRegistry.TemplateInput memory t = standardInput();
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        templates.addTemplate(t, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        templates.setEnabled(standardId, false);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(LaunchTemplateRegistry.UnknownTemplate.selector, 99));
        templates.setEnabled(99, true);
        vm.expectRevert(abi.encodeWithSelector(LaunchTemplateRegistry.UnknownTemplate.selector, 99));
        templates.get(99);
    }

    function test_disablingStopsNewLaunchesOnly() public {
        _create(0);
        templates.setEnabled(standardId, false);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.TemplateDisabled.selector, standardId));
        launchFactory.createLaunch(
            LaunchFactory.CreateParams({
                templateId: standardId,
                name: "Second",
                symbol: "TWO",
                metadataURI: "",
                creatorRecipient: creatorFees,
                operator: address(0),
                initialBuy: 0,
                minTokensOut: 0,
                deadline: block.timestamp
            })
        );
    }
}
