// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeeRecipients} from "./FeeRecipients.sol";
import {AssetRegistry} from "../src/shared/AssetRegistry.sol";
import {CurveilRouter} from "../src/markets/CurveilRouter.sol";
import {ShieldedPool} from "../src/vault/ShieldedPool.sol";
import {IGroth16Verifier9} from "../src/vault/interfaces/IGroth16Verifier9.sol";
import {ShieldedSwapAdapter} from "../src/vault/adapters/ShieldedSwapAdapter.sol";
import {ShieldedLiquidityAdapter} from "../src/vault/adapters/ShieldedLiquidityAdapter.sol";

/// @notice Phase 4 deployment: ShieldedPool v2 (shielded execution) with the swap and liquidity
///         adapters. The circuits are unchanged, so the pool reuses the deployed verifiers from
///         deployments/<NETWORK>.vault.json. The v1 pool stays deployed and keeps honouring
///         withdrawals; its address is recorded as `legacyPool`.
/// Usage: NETWORK=testnet forge script script/DeployExecution.s.sol --rpc-url robinhood_testnet --broadcast \
///          --libraries <PoseidonT3 and PoseidonT5 from the vault deployment, to reuse them>
/// Reads config/<NETWORK>.json (.vault), deployments/<NETWORK>.foundation.json, .markets.json and
/// .vault.json. Writes deployments/<NETWORK>.execution.json.
contract DeployExecution is Script {
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
        CurveilRouter router;
        IGroth16Verifier9 transferVerifier;
        IGroth16Verifier9 withdrawVerifier;
        address legacyPool;
    }

    function run() external {
        Ctx memory c = _context();
        vm.startBroadcast();
        address deployer = msg.sender;
        ShieldedPool pool = new ShieldedPool(
            deployer,
            c.registry,
            c.transferVerifier,
            c.withdrawVerifier,
            uint16(c.cfg.readUint(".vault.withdrawFeeBps")),
            c.feeRecipient
        );
        ShieldedSwapAdapter swap = new ShieldedSwapAdapter(address(pool), c.router);
        ShieldedLiquidityAdapter liquidity = new ShieldedLiquidityAdapter(address(pool), c.router);
        pool.configureAsset(c.usdg, true, uint128(c.cfg.readUint(".vault.maxDepositUsdg")));
        pool.configureAsset(c.weth, true, uint128(c.cfg.readUint(".vault.maxDepositWeth")));
        pool.setAdapter(address(swap), ShieldedPool.AdapterStatus.Active);
        pool.setAdapter(address(liquidity), ShieldedPool.AdapterStatus.Active);
        if (c.guardian != address(0)) pool.setGuardian(c.guardian);
        if (c.admin != deployer) pool.transferOwnership(c.admin);
        vm.stopBroadcast();

        _write(c, address(pool), address(swap), address(liquidity), liquidity.holderImplementation());
        console2.log("ShieldedPool v2", address(pool));
        console2.log("ShieldedSwapAdapter", address(swap));
        console2.log("ShieldedLiquidityAdapter", address(liquidity));
        console2.log("PositionHolder implementation", liquidity.holderImplementation());
        console2.log("noteDomain", pool.noteDomain());
        if (c.admin != deployer) console2.log("Admin must call acceptOwnership() on the pool:", c.admin);
    }

    function _context() internal view returns (Ctx memory c) {
        c.network = vm.envString("NETWORK");
        c.cfg = vm.readFile(string.concat("config/", c.network, ".json"));
        string memory foundation = vm.readFile(string.concat("deployments/", c.network, ".foundation.json"));
        string memory markets = vm.readFile(string.concat("deployments/", c.network, ".markets.json"));
        string memory vault = vm.readFile(string.concat("deployments/", c.network, ".vault.json"));
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
        c.router = CurveilRouter(markets.readAddress(".router"));
        c.transferVerifier = IGroth16Verifier9(vault.readAddress(".transferVerifier"));
        c.withdrawVerifier = IGroth16Verifier9(vault.readAddress(".withdrawVerifier"));
        c.legacyPool = vault.readAddress(".shieldedPool");
        if (address(c.transferVerifier).code.length == 0) revert NotConfigured("transferVerifier");
        if (address(c.withdrawVerifier).code.length == 0) revert NotConfigured("withdrawVerifier");
    }

    function _write(Ctx memory c, address pool, address swap, address liquidity, address holderImpl) internal {
        string memory out = "execution";
        out.serialize("legacyPool", c.legacyPool);
        out.serialize("swapAdapter", swap);
        out.serialize("liquidityAdapter", liquidity);
        out.serialize("positionHolderImplementation", holderImpl);
        out.serialize("deployBlock", block.number);
        out = out.serialize("shieldedPool", pool);
        vm.writeJson(out, string.concat("deployments/", c.network, ".execution.json"));
    }
}
