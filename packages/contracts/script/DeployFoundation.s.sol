// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AssetRegistry} from "../src/shared/AssetRegistry.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {TestFaucet} from "../src/testnet/TestFaucet.sol";

/// @notice Phase 0 deployment: asset registry, plus test assets and faucet on testnet.
/// Usage: NETWORK=testnet forge script script/DeployFoundation.s.sol --rpc-url robinhood_testnet --broadcast
/// All network-specific values come from config/<NETWORK>.json. Contracts deploy through
/// the deterministic CREATE2 deployer, so addresses are reproducible.
contract DeployFoundation is Script {
    using stdJson for string;

    uint256 internal constant MAINNET_CHAIN_ID = 4663;

    error WrongChain(uint256 expected, uint256 actual);
    error AdminNotSet();
    error TestAssetsOnMainnet();

    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory cfg = vm.readFile(string.concat("config/", network, ".json"));

        uint256 chainId = cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        address admin = cfg.readAddress(".admin");
        if (admin == address(0)) revert AdminNotSet();
        bool testAssets = cfg.readBool(".deployTestAssets");
        if (testAssets && block.chainid == MAINNET_CHAIN_ID) revert TestAssetsOnMainnet();
        bytes32 salt = keccak256(bytes(cfg.readString(".salt")));

        vm.startBroadcast();
        address deployer = msg.sender;

        // Registry is owned by the deployer during setup, then handed to `admin`.
        AssetRegistry registry = new AssetRegistry{salt: salt}(deployer);

        address usdg = cfg.readAddress(".assets.usdg");
        address weth = cfg.readAddress(".assets.weth");
        address faucet;

        if (testAssets) (usdg, weth, faucet) = _deployTestAssets(cfg, salt, deployer, admin);

        registry.admit(usdg, "USDG");
        registry.admit(weth, "WETH");
        if (admin != deployer) registry.transferOwnership(admin);
        vm.stopBroadcast();

        string memory o = "deployment";
        o.serialize("network", network);
        o.serialize("chainId", block.chainid);
        o.serialize("deployBlock", block.number);
        o.serialize("assetRegistry", address(registry));
        o.serialize("usdg", usdg);
        o.serialize("weth", weth);
        string memory out = o.serialize("testFaucet", faucet);
        vm.writeJson(out, string.concat("deployments/", network, ".foundation.json"));

        console2.log("AssetRegistry", address(registry));
        console2.log("USDG", usdg);
        console2.log("WETH", weth);
        console2.log("TestFaucet", faucet);
    }

    function _deployTestAssets(string memory cfg, bytes32 salt, address deployer, address admin)
        internal
        returns (address usdg, address weth, address faucet)
    {
        TestToken tUsdg = new TestToken{salt: salt}("Curveil Test USDG", "tUSDG", 6, deployer);
        TestToken tWeth = new TestToken{salt: salt}("Curveil Test WETH", "tWETH", 18, deployer);
        TestFaucet f = new TestFaucet{salt: salt}(deployer, cfg.readUint(".faucet.cooldownSeconds"));
        tUsdg.grantRole(tUsdg.MINTER_ROLE(), address(f));
        tWeth.grantRole(tWeth.MINTER_ROLE(), address(f));
        f.configure(address(tUsdg), cfg.readUint(".faucet.usdgAmount"), true);
        f.configure(address(tWeth), cfg.readUint(".faucet.wethAmount"), true);
        if (admin != deployer) {
            tUsdg.grantRole(tUsdg.DEFAULT_ADMIN_ROLE(), admin);
            tWeth.grantRole(tWeth.DEFAULT_ADMIN_ROLE(), admin);
            f.transferOwnership(admin);
        }
        return (address(tUsdg), address(tWeth), address(f));
    }
}
