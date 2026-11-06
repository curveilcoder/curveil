// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeeRecipients} from "./FeeRecipients.sol";
import {AssetRegistry} from "../src/shared/AssetRegistry.sol";
import {ShieldedPool} from "../src/vault/ShieldedPool.sol";
import {IGroth16Verifier9} from "../src/vault/interfaces/IGroth16Verifier9.sol";
import {TransferVerifier} from "../src/vault/verifiers/TransferVerifier.sol";
import {WithdrawVerifier} from "../src/vault/verifiers/WithdrawVerifier.sol";

/// @notice Phase 3 deployment: the two generated Groth16 verifiers and the ShieldedPool, then
///         asset configuration. Poseidon libraries are deployed and linked by Forge.
/// Usage: NETWORK=testnet forge script script/DeployVault.s.sol --rpc-url robinhood_testnet --broadcast
/// Reads config/<NETWORK>.json (.vault) and deployments/<NETWORK>.foundation.json. The
/// deployer configures the pool and, when the admin is someone else (mainnet: the timelock),
/// starts a two-step ownership transfer that the admin must accept.
contract DeployVault is Script {
    using stdJson for string;

    error WrongChain(uint256 expected, uint256 actual);
    error NotConfigured(string what);

    struct Ctx {
        string network;
        string cfg;
        address admin;
        address feeRecipient;
        address guardian;
        address usdg;
        address weth;
        AssetRegistry registry;
    }

    function run() external {
        Ctx memory c = _context();
        vm.startBroadcast();
        address deployer = msg.sender;
        IGroth16Verifier9 tv = IGroth16Verifier9(address(new TransferVerifier()));
        IGroth16Verifier9 wv = IGroth16Verifier9(address(new WithdrawVerifier()));
        ShieldedPool pool = new ShieldedPool(
            deployer, c.registry, tv, wv, uint16(c.cfg.readUint(".vault.withdrawFeeBps")), c.feeRecipient
        );
        pool.configureAsset(c.usdg, true, uint128(c.cfg.readUint(".vault.maxDepositUsdg")));
        pool.configureAsset(c.weth, true, uint128(c.cfg.readUint(".vault.maxDepositWeth")));
        if (c.guardian != address(0)) pool.setGuardian(c.guardian);
        if (c.admin != deployer) pool.transferOwnership(c.admin);
        vm.stopBroadcast();
        _write(c.network, address(tv), address(wv), address(pool));
        console2.log("TransferVerifier", address(tv));
        console2.log("WithdrawVerifier", address(wv));
        console2.log("ShieldedPool", address(pool));
        console2.log("noteDomain", pool.noteDomain());
        if (c.admin != deployer) console2.log("Admin must call acceptOwnership() on the pool:", c.admin);
    }

    function _context() internal view returns (Ctx memory c) {
        c.network = vm.envString("NETWORK");
        c.cfg = vm.readFile(string.concat("config/", c.network, ".json"));
        string memory foundation = vm.readFile(string.concat("deployments/", c.network, ".foundation.json"));
        uint256 chainId = c.cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        c.admin = c.cfg.readAddress(".admin");
        c.feeRecipient = FeeRecipients.treasury(c.cfg, c.network, ".vault.protocolFeeRecipient", "vault");
        c.guardian = c.cfg.readAddress(".vault.guardian");
        if (c.admin == address(0)) revert NotConfigured("admin");
        if (c.feeRecipient == address(0)) revert NotConfigured("vault.protocolFeeRecipient");
        bool testAssets = c.cfg.readBool(".deployTestAssets");
        c.usdg = testAssets ? foundation.readAddress(".usdg") : c.cfg.readAddress(".assets.usdg");
        c.weth = testAssets ? foundation.readAddress(".weth") : c.cfg.readAddress(".assets.weth");
        c.registry = AssetRegistry(foundation.readAddress(".assetRegistry"));
    }

    function _write(string memory network, address tv, address wv, address pool) internal {
        string memory out = "vault";
        out.serialize("transferVerifier", tv);
        out.serialize("withdrawVerifier", wv);
        out = out.serialize("shieldedPool", pool);
        vm.writeJson(out, string.concat("deployments/", network, ".vault.json"));
    }
}
