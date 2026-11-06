// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeeRecipients} from "./FeeRecipients.sol";
import {AssetRegistry} from "../src/shared/AssetRegistry.sol";
import {DammFactory} from "../src/markets/DammFactory.sol";
import {DammPool} from "../src/markets/DammPool.sol";
import {DlmmFactory} from "../src/markets/DlmmFactory.sol";
import {CurveilRouter} from "../src/markets/CurveilRouter.sol";

/// @notice Phase 1 deployment: DAMM and DLMM factories with their fee tiers and bin-step presets, and the router.
/// Usage: NETWORK=testnet forge script script/DeployMarkets.s.sol --rpc-url robinhood_testnet --broadcast
/// Reads config/<NETWORK>.json and deployments/<NETWORK>.foundation.json. Factories are handed to
/// `admin` with Ownable2Step, so on mainnet the admin Safe must call acceptOwnership.
contract DeployMarkets is Script {
    using stdJson for string;

    error WrongChain(uint256 expected, uint256 actual);
    error AdminNotSet();
    error FeeToNotSet();

    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory cfg = vm.readFile(string.concat("config/", network, ".json"));
        string memory foundation = vm.readFile(string.concat("deployments/", network, ".foundation.json"));

        uint256 chainId = cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        address admin = cfg.readAddress(".admin");
        if (admin == address(0)) revert AdminNotSet();
        address feeTo = FeeRecipients.treasury(cfg, network, ".markets.feeTo", "markets");
        if (feeTo == address(0)) revert FeeToNotSet();
        bytes32 salt = keccak256(bytes(cfg.readString(".salt")));
        AssetRegistry registry = AssetRegistry(foundation.readAddress(".assetRegistry"));

        (address damm, address dlmm, address router) = _deploy(cfg, registry, admin, feeTo, salt);
        _write(network, damm, dlmm, router);
        console2.log("DammFactory", damm);
        console2.log("DlmmFactory", dlmm);
        console2.log("CurveilRouter", router);
    }

    function _deploy(string memory cfg, AssetRegistry registry, address admin, address feeTo, bytes32 salt)
        internal
        returns (address damm, address dlmm, address router)
    {
        uint16 dlmmShare = uint16(cfg.readUint(".markets.dlmmProtocolShareBps"));
        vm.startBroadcast();
        damm = address(new DammFactory{salt: salt}(msg.sender, registry, feeTo));
        _configureDamm(cfg, DammFactory(damm));
        dlmm = address(new DlmmFactory{salt: salt}(msg.sender, registry, feeTo, dlmmShare));
        _configureDlmm(cfg, DlmmFactory(dlmm));
        router = address(new CurveilRouter{salt: salt}(DammFactory(damm), DlmmFactory(dlmm)));
        if (admin != msg.sender) {
            DammFactory(damm).transferOwnership(admin);
            DlmmFactory(dlmm).transferOwnership(admin);
        }
        vm.stopBroadcast();
    }

    function _write(string memory network, address damm, address dlmm, address router) internal {
        string memory o = "markets";
        o.serialize("network", network);
        o.serialize("chainId", block.chainid);
        o.serialize("deployBlock", block.number);
        o.serialize("dammFactory", damm);
        o.serialize("dlmmFactory", dlmm);
        string memory out = o.serialize("router", router);
        vm.writeJson(out, string.concat("deployments/", network, ".markets.json"));
    }

    function _configureDamm(string memory cfg, DammFactory damm) internal {
        for (uint256 i;; ++i) {
            string memory k = string.concat(".markets.dammTiers[", vm.toString(i), "]");
            if (!vm.keyExistsJson(cfg, k)) break;
            DammPool.FeeParams memory p = DammPool.FeeParams({
                baseFeeBps: uint16(cfg.readUint(string.concat(k, ".baseFeeBps"))),
                maxFeeBps: uint16(cfg.readUint(string.concat(k, ".maxFeeBps"))),
                protocolShareBps: uint16(cfg.readUint(string.concat(k, ".protocolShareBps"))),
                variableFeeControl: uint16(cfg.readUint(string.concat(k, ".variableFeeControl"))),
                filterPeriod: uint32(cfg.readUint(string.concat(k, ".filterPeriod"))),
                decayPeriod: uint32(cfg.readUint(string.concat(k, ".decayPeriod"))),
                reductionBps: uint16(cfg.readUint(string.concat(k, ".reductionBps"))),
                maxVolatilityBps: uint32(cfg.readUint(string.concat(k, ".maxVolatilityBps")))
            });
            damm.setTier(uint8(cfg.readUint(string.concat(k, ".id"))), p, true);
        }
    }

    function _configureDlmm(string memory cfg, DlmmFactory dlmm) internal {
        for (uint256 i;; ++i) {
            string memory k = string.concat(".markets.dlmmPresets[", vm.toString(i), "]");
            if (!vm.keyExistsJson(cfg, k)) break;
            dlmm.setPreset(
                uint16(cfg.readUint(string.concat(k, ".binStep"))),
                uint16(cfg.readUint(string.concat(k, ".baseFeeBps"))),
                true
            );
        }
    }
}
