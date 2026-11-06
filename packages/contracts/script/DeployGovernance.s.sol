// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveilTimelock} from "../src/governance/CurveilTimelock.sol";
import {ProtocolTreasury} from "../src/governance/ProtocolTreasury.sol";
import {BuybackBurner} from "../src/governance/BuybackBurner.sol";

/// @notice Phase 7 deployment, run FIRST on mainnet: the CurveilTimelock (owner of every admin
///         role), one ProtocolTreasury per fee source, and the BuybackBurner.
/// Usage: NETWORK=mainnet forge script script/DeployGovernance.s.sol --rpc-url robinhood_mainnet --broadcast
/// Reads config/<NETWORK>.json (.governance, .assets.usdg). Writes deployments/<NETWORK>.governance.json.
///
/// After this runs, put the timelock address in `.admin`, the treasury addresses in the fee
/// recipient fields and the Safe in the guardian fields of config/<NETWORK>.json, then run the
/// module deploy scripts. Each one hands ownership to `.admin` with Ownable2Step; the Safe then
/// schedules one `acceptOwnership` batch through the timelock (the manifest package's `handover` script builds it).
contract DeployGovernance is Script {
    using stdJson for string;

    uint256 internal constant MAINNET_CHAIN_ID = 4663;

    error WrongChain(uint256 expected, uint256 actual);
    error NotConfigured(string what);

    function run() external {
        string memory network = vm.envString("NETWORK");
        string memory cfg = vm.readFile(string.concat("config/", network, ".json"));
        uint256 chainId = cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);

        address safe = cfg.readAddress(".governance.safe");
        if (safe == address(0)) revert NotConfigured("governance.safe");
        if (block.chainid == MAINNET_CHAIN_ID && safe.code.length == 0) revert NotConfigured("governance.safe is not a contract");
        uint256 delay = cfg.readUint(".governance.timelockDelay");
        string[] memory sources = cfg.readStringArray(".governance.treasuries");
        if (sources.length == 0) revert NotConfigured("governance.treasuries");
        address usdg = cfg.readAddress(".assets.usdg");
        if (usdg == address(0)) {
            // Testnet assets come from the foundation deployment.
            string memory f = vm.readFile(string.concat("deployments/", network, ".foundation.json"));
            usdg = f.readAddress(".usdg");
        }
        bytes32 salt = keccak256(bytes(string.concat(cfg.readString(".salt"), ".governance")));

        address[] memory roles = new address[](1);
        roles[0] = safe;

        vm.startBroadcast();
        CurveilTimelock timelock = new CurveilTimelock{salt: salt}(delay, roles, roles);
        address[] memory treasuries = new address[](sources.length);
        for (uint256 i = 0; i < sources.length; i++) {
            bytes32 label = bytes32(bytes(sources[i]));
            treasuries[i] = address(new ProtocolTreasury{salt: keccak256(abi.encode(salt, label))}(label, address(timelock)));
        }
        BuybackBurner burner = new BuybackBurner{salt: salt}(IERC20(usdg), address(timelock), safe);
        vm.stopBroadcast();

        _write(network, safe, address(timelock), delay, address(burner), sources, treasuries);

        console2.log("CurveilTimelock", address(timelock), delay);
        for (uint256 i = 0; i < sources.length; i++) {
            console2.log(string.concat("ProtocolTreasury ", sources[i]), treasuries[i]);
        }
        console2.log("BuybackBurner", address(burner));
    }

    function _write(
        string memory network,
        address safe,
        address timelock,
        uint256 delay,
        address burner,
        string[] memory sources,
        address[] memory treasuries
    ) internal {
        string memory t = "treasuries";
        string memory tOut;
        for (uint256 i = 0; i < sources.length; i++) {
            tOut = t.serialize(sources[i], treasuries[i]);
        }
        string memory o = "governance";
        o.serialize("network", network);
        o.serialize("chainId", block.chainid);
        o.serialize("deployBlock", block.number);
        o.serialize("safe", safe);
        o.serialize("timelock", timelock);
        o.serialize("timelockDelay", delay);
        o.serialize("buybackBurner", burner);
        string memory out = o.serialize("treasuries", tOut);
        vm.writeJson(out, string.concat("deployments/", network, ".governance.json"));
    }
}
