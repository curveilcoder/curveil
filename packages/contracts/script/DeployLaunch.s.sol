// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeeRecipients} from "./FeeRecipients.sol";
import {AssetRegistry} from "../src/shared/AssetRegistry.sol";
import {DammFactory} from "../src/markets/DammFactory.sol";
import {AdmissionController} from "../src/launch/AdmissionController.sol";
import {LaunchTemplateRegistry} from "../src/launch/LaunchTemplateRegistry.sol";
import {LaunchFactory} from "../src/launch/LaunchFactory.sol";
import {GraduationMigrator} from "../src/launch/GraduationMigrator.sol";
import {LpEscrow} from "../src/launch/LpEscrow.sol";
import {ILaunchFactory} from "../src/launch/interfaces/ILaunch.sol";

/// @notice Phase 2 deployment: launch templates, factory, graduation migrator, LP escrow and the
///         admission controller that takes ownership of the AssetRegistry.
/// Usage: NETWORK=testnet forge script script/DeployLaunch.s.sol --rpc-url robinhood_testnet --broadcast
/// Reads config/<NETWORK>.json (.launch) and deployments/<NETWORK>.{foundation,markets}.json.
/// If the deployer does not own the AssetRegistry (mainnet: the admin Safe does), the script
/// prints the two calls the owner must make to hand it to the AdmissionController.
contract DeployLaunch is Script {
    using stdJson for string;

    struct Ctx {
        string network;
        string cfg;
        address admin;
        address guardian;
        address quote;
        address feeRecipient;
        address lpRecipient;
        AssetRegistry registry;
        DammFactory damm;
    }

    struct Deployed {
        AdmissionController admission;
        LaunchTemplateRegistry templates;
        LpEscrow escrow;
        LaunchFactory factory;
        GraduationMigrator migrator;
    }

    error WrongChain(uint256 expected, uint256 actual);
    error NotConfigured(string what);

    function run() external {
        Ctx memory c = _context();
        vm.startBroadcast();
        Deployed memory d = _deploy(c);
        _templates(c, d.templates);
        _handOver(c, d);
        vm.stopBroadcast();
        _write(c.network, d);
        console2.log("AdmissionController", address(d.admission));
        console2.log("LaunchTemplateRegistry", address(d.templates));
        console2.log("LpEscrow", address(d.escrow));
        console2.log("LaunchFactory", address(d.factory));
        console2.log("GraduationMigrator", address(d.migrator));
    }

    function _context() internal view returns (Ctx memory c) {
        c.network = vm.envString("NETWORK");
        c.cfg = vm.readFile(string.concat("config/", c.network, ".json"));
        string memory foundation = vm.readFile(string.concat("deployments/", c.network, ".foundation.json"));
        string memory markets = vm.readFile(string.concat("deployments/", c.network, ".markets.json"));
        uint256 chainId = c.cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        c.admin = c.cfg.readAddress(".admin");
        // The Safe is every module's guardian: it can pause new launches and suspend assets at once.
        c.guardian = c.cfg.readAddress(".governance.safe");
        c.feeRecipient = FeeRecipients.treasury(c.cfg, c.network, ".launch.protocolFeeRecipient", "launch");
        c.lpRecipient = FeeRecipients.timelock(c.cfg, c.network, ".launch.protocolLpRecipient");
        if (c.admin == address(0)) revert NotConfigured("admin");
        if (c.feeRecipient == address(0)) revert NotConfigured("launch.protocolFeeRecipient");
        if (c.lpRecipient == address(0)) revert NotConfigured("launch.protocolLpRecipient");
        c.registry = AssetRegistry(foundation.readAddress(".assetRegistry"));
        c.damm = DammFactory(markets.readAddress(".dammFactory"));
        c.quote =
            c.cfg.readBool(".deployTestAssets") ? foundation.readAddress(".usdg") : c.cfg.readAddress(".assets.usdg");
    }

    function _deploy(Ctx memory c) internal returns (Deployed memory d) {
        d.admission = new AdmissionController(msg.sender, c.registry);
        d.templates = new LaunchTemplateRegistry(msg.sender, c.registry, c.damm);
        d.escrow = new LpEscrow(msg.sender);
        d.factory = new LaunchFactory(msg.sender, d.templates);
        d.migrator =
            new GraduationMigrator(ILaunchFactory(address(d.factory)), d.templates, c.damm, d.admission, d.escrow);
        d.factory.setMigrator(address(d.migrator));
        d.escrow.setLocker(address(d.migrator), true);
        d.admission.setLaunchModules(ILaunchFactory(address(d.factory)), address(d.migrator));
        if (c.guardian != address(0)) {
            d.factory.setGuardian(c.guardian);
            d.admission.setGuardian(c.guardian);
        }
    }

    function _templates(Ctx memory c, LaunchTemplateRegistry templates) internal {
        for (uint256 i;; ++i) {
            string memory k = string.concat(".launch.templates[", vm.toString(i), "]");
            if (!vm.keyExistsJson(c.cfg, k)) break;
            LaunchTemplateRegistry.TemplateInput memory t = _input(c, k);
            uint256 id = templates.addTemplate(t, c.cfg.readBool(string.concat(k, ".enabled")));
            console2.log("template", id, t.label);
        }
    }

    function _input(Ctx memory c, string memory k)
        internal
        view
        returns (LaunchTemplateRegistry.TemplateInput memory t)
    {
        t.label = c.cfg.readString(string.concat(k, ".label"));
        t.quoteAsset = c.quote;
        t.totalSupply = vm.parseUint(c.cfg.readString(string.concat(k, ".totalSupply")));
        t.curveSupply = vm.parseUint(c.cfg.readString(string.concat(k, ".curveSupply")));
        t.migrationSupply = vm.parseUint(c.cfg.readString(string.concat(k, ".migrationSupply")));
        t.graduationThreshold = vm.parseUint(c.cfg.readString(string.concat(k, ".graduationThreshold")));
        t.feeBps = uint16(c.cfg.readUint(string.concat(k, ".feeBps")));
        t.creatorFeeShareBps = uint16(c.cfg.readUint(string.concat(k, ".creatorFeeShareBps")));
        t.dammTier = uint8(c.cfg.readUint(string.concat(k, ".dammTier")));
        t.priceToleranceBps = uint16(c.cfg.readUint(string.concat(k, ".priceToleranceBps")));
        t.creatorLpBps = uint16(c.cfg.readUint(string.concat(k, ".creatorLpBps")));
        t.creatorLockSeconds = uint32(c.cfg.readUint(string.concat(k, ".creatorLockSeconds")));
        t.protocolLockSeconds = uint32(c.cfg.readUint(string.concat(k, ".protocolLockSeconds")));
        t.protocolFeeRecipient = c.feeRecipient;
        t.protocolLpRecipient = c.lpRecipient;
    }

    function _handOver(Ctx memory c, Deployed memory d) internal {
        if (c.registry.owner() == msg.sender) {
            c.registry.transferOwnership(address(d.admission));
            d.admission.acceptRegistryOwnership();
        } else {
            console2.log("ACTION: registry owner must call AssetRegistry.transferOwnership(admission)");
            console2.log("        then admin calls AdmissionController.acceptRegistryOwnership()");
        }
        if (c.admin != msg.sender) {
            d.admission.transferOwnership(c.admin);
            d.templates.transferOwnership(c.admin);
            d.escrow.transferOwnership(c.admin);
            d.factory.transferOwnership(c.admin);
        }
    }

    function _write(string memory network, Deployed memory d) internal {
        string memory o = "launch";
        o.serialize("network", network);
        o.serialize("chainId", block.chainid);
        o.serialize("deployBlock", block.number);
        o.serialize("admissionController", address(d.admission));
        o.serialize("launchTemplateRegistry", address(d.templates));
        o.serialize("lpEscrow", address(d.escrow));
        o.serialize("launchFactory", address(d.factory));
        string memory out = o.serialize("graduationMigrator", address(d.migrator));
        vm.writeJson(out, string.concat("deployments/", network, ".launch.json"));
    }
}
