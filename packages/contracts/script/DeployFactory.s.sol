// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {LaunchFactory, ILaunchpadRegistry} from "../src/launch/LaunchFactory.sol";
import {LaunchpadRegistry, ITemplateCount} from "../src/factory/LaunchpadRegistry.sol";

/// @notice Phase 6 deployment: the LaunchpadRegistry (which deploys the FeeSplitter
///         implementation) and LaunchFactory pointed at it.
/// Usage: NETWORK=testnet forge script script/DeployFactory.s.sol --rpc-url robinhood_testnet --broadcast
/// Reads config/<NETWORK>.json (.factory) and deployments/<NETWORK>.launch.json.
/// Writes deployments/<NETWORK>.factory.json.
///
/// LaunchFactory.setLaunchpads is called here only when the deployer still owns LaunchFactory.
/// Otherwise the script prints the call for the owner (the multisig on mainnet) to make.
contract DeployFactory is Script {
    using stdJson for string;

    error WrongChain(uint256 expected, uint256 actual);
    error NotConfigured(string what);

    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory cfg = vm.readFile(string.concat("config/", network, ".json"));
        string memory launch = vm.readFile(string.concat("deployments/", network, ".launch.json"));
        uint256 chainId = cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        address admin = cfg.readAddress(".admin");
        if (admin == address(0)) revert NotConfigured("admin");
        LaunchFactory factory = LaunchFactory(launch.readAddress(".launchFactory"));
        address templates = launch.readAddress(".launchTemplateRegistry");
        if (address(factory).code.length == 0 || templates.code.length == 0) revert NotConfigured("launch deployment");
        uint16 maxShare = uint16(cfg.readUint(".factory.maxShareBps"));

        vm.startBroadcast();
        address deployer = msg.sender;
        LaunchpadRegistry registry = new LaunchpadRegistry(deployer, ITemplateCount(templates), maxShare);
        bool wired = factory.owner() == deployer;
        if (wired) factory.setLaunchpads(ILaunchpadRegistry(address(registry)));
        address guardian = cfg.readAddress(".governance.safe");
        if (guardian != address(0)) registry.setGuardian(guardian);
        if (admin != deployer) registry.transferOwnership(admin);
        vm.stopBroadcast();

        string memory out = "factory";
        out.serialize("network", network);
        out.serialize("chainId", block.chainid);
        out.serialize("launchpadRegistry", address(registry));
        out.serialize("feeSplitterImplementation", registry.splitterImplementation());
        out.serialize("maxShareBps", uint256(maxShare));
        out = out.serialize("deployBlock", block.number);
        vm.writeJson(out, string.concat("deployments/", network, ".factory.json"));

        console2.log("LaunchpadRegistry", address(registry));
        console2.log("FeeSplitter implementation", registry.splitterImplementation());
        if (!wired) console2.log("LaunchFactory owner must call setLaunchpads with", address(registry));
        if (admin != deployer) console2.log("Admin must call acceptOwnership() on LaunchpadRegistry:", admin);
    }
}
