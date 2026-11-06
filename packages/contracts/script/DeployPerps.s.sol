// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FeeRecipients} from "./FeeRecipients.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {ShieldedPool} from "../src/vault/ShieldedPool.sol";
import {ShieldedPerpsAdapter} from "../src/vault/adapters/ShieldedPerpsAdapter.sol";
import {IReportVerifier} from "../src/perps/interfaces/IReportVerifier.sol";
import {SignedReportVerifier} from "../src/perps/oracle/SignedReportVerifier.sol";
import {PythReportVerifier} from "../src/perps/oracle/PythReportVerifier.sol";
import {IPyth} from "../src/perps/interfaces/IPyth.sol";
import {OracleAdapter} from "../src/perps/OracleAdapter.sol";
import {PerpLiquidityVault} from "../src/perps/PerpLiquidityVault.sol";
import {PerpEngine} from "../src/perps/PerpEngine.sol";
import {OrderManager} from "../src/perps/OrderManager.sol";
import {PerpLens} from "../src/perps/PerpLens.sol";

/// @notice Phase 5 deployment: perps. Price source, OracleAdapter, PerpLiquidityVault, PerpEngine,
///         OrderManager, PerpLens and the ShieldedPerpsAdapter (enabled on ShieldedPool v2).
/// Usage: NETWORK=testnet forge script script/DeployPerps.s.sol --rpc-url robinhood_testnet --broadcast
/// Reads config/<NETWORK>.json (.perps), deployments/<NETWORK>.foundation.json and .execution.json.
/// Writes deployments/<NETWORK>.perps.json. On testnet it seeds the vault with test USDG.
///
/// Price source:
/// - "pyth" deploys PythReportVerifier over Pyth's contract (`perps.pyth.address`), with each
///   market's `pythId` and `maxConfBps`, and lets only the new OracleAdapter call it.
/// - "curveil-test-signer" deploys SignedReportVerifier (testnet only, refuses mainnet).
/// - Any other value needs `reportVerifier`: an existing verifier contract.
contract DeployPerps is Script {
    using stdJson for string;

    error WrongChain(uint256 expected, uint256 actual);
    error NotConfigured(string what);

    struct Ctx {
        string network;
        string cfg;
        address admin;
        address usdg;
        address pool;
        address feeRecipient;
        bool testAssets;
    }

    struct Out {
        address verifier;
        address oracle;
        address vault;
        address engine;
        address orders;
        address lens;
        address adapter;
    }

    function run() external {
        Ctx memory c = _context();
        vm.startBroadcast();
        address deployer = msg.sender;
        Out memory o;
        o.verifier = _verifier(c, deployer);
        OracleAdapter oracle = new OracleAdapter(deployer, IReportVerifier(o.verifier));
        o.oracle = address(oracle);
        if (_isPyth(c)) PythReportVerifier(payable(o.verifier)).setCaller(address(oracle));
        PerpLiquidityVault vault = new PerpLiquidityVault(
            IERC20(c.usdg),
            deployer,
            uint16(c.cfg.readUint(".perps.vault.maxUtilizationBps")),
            uint32(c.cfg.readUint(".perps.vault.lockSeconds")),
            c.cfg.readUint(".perps.vault.depositCap")
        );
        o.vault = address(vault);
        PerpEngine engine = new PerpEngine(
            IERC20(c.usdg),
            oracle,
            vault,
            deployer,
            c.feeRecipient,
            uint16(c.cfg.readUint(".perps.protocolShareBps")),
            uint128(c.cfg.readUint(".perps.minExecutionFee")),
            uint32(c.cfg.readUint(".perps.requestTimeout")),
            uint32(c.cfg.readUint(".perps.navMaxAge"))
        );
        o.engine = address(engine);
        vault.setEngine(engine);
        OrderManager orders = new OrderManager(engine);
        o.orders = address(orders);
        engine.setOrderManager(address(orders));
        o.lens = address(new PerpLens(engine));
        ShieldedPerpsAdapter adapter = new ShieldedPerpsAdapter(c.pool, engine, orders);
        o.adapter = address(adapter);
        ShieldedPool(c.pool).setAdapter(address(adapter), ShieldedPool.AdapterStatus.Active);

        _markets(c, oracle, engine);
        address sequencer = c.cfg.readAddress(".perps.sequencerFeed");
        if (sequencer != address(0)) {
            oracle.setSequencerFeed(sequencer, uint32(c.cfg.readUint(".perps.sequencerGracePeriod")));
        }
        address guardian = c.cfg.readAddress(".perps.guardian");
        if (guardian != address(0)) engine.setGuardian(guardian);

        uint256 seed = c.cfg.readUint(".perps.seedLiquidity");
        if (seed != 0) {
            if (!c.testAssets) revert NotConfigured("seedLiquidity is for test assets only");
            TestToken(c.usdg).mint(deployer, seed);
            IERC20(c.usdg).approve(address(vault), seed);
            vault.deposit(seed, 0);
        }

        if (c.admin != deployer) {
            oracle.transferOwnership(c.admin);
            vault.transferOwnership(c.admin);
            engine.transferOwnership(c.admin);
            if (o.verifier.code.length != 0 && _isTestSigner(c)) {
                SignedReportVerifier(o.verifier).transferOwnership(c.admin);
            }
            if (_isPyth(c)) PythReportVerifier(payable(o.verifier)).transferOwnership(c.admin);
        }
        vm.stopBroadcast();

        _write(c, o);
        console2.log("ReportVerifier", o.verifier);
        console2.log("OracleAdapter", o.oracle);
        console2.log("PerpLiquidityVault", o.vault);
        console2.log("PerpEngine", o.engine);
        console2.log("OrderManager", o.orders);
        console2.log("PerpLens", o.lens);
        console2.log("ShieldedPerpsAdapter", o.adapter);
        if (c.admin != deployer) console2.log("Admin must call acceptOwnership() on each:", c.admin);
    }

    function _isTestSigner(Ctx memory c) internal pure returns (bool) {
        return keccak256(bytes(c.cfg.readString(".perps.priceSource"))) == keccak256("curveil-test-signer");
    }

    function _isPyth(Ctx memory c) internal pure returns (bool) {
        return keccak256(bytes(c.cfg.readString(".perps.priceSource"))) == keccak256("pyth");
    }

    function _verifier(Ctx memory c, address deployer) internal returns (address) {
        if (_isPyth(c)) {
            address pyth = c.cfg.readAddress(".perps.pyth.address");
            if (pyth.code.length == 0) revert NotConfigured("perps.pyth.address");
            PythReportVerifier v = new PythReportVerifier(deployer, IPyth(pyth));
            v.setMaxFee(c.cfg.readUint(".perps.pyth.maxFee"));
            for (uint256 i = 0;; i++) {
                string memory k = string.concat(".perps.markets[", vm.toString(i), "]");
                if (!vm.keyExistsJson(c.cfg, k)) break;
                bytes32 pythId = c.cfg.readBytes32(string.concat(k, ".pythId"));
                if (pythId == bytes32(0)) revert NotConfigured(string.concat(k, ".pythId"));
                v.setFeed(
                    keccak256(bytes(c.cfg.readString(string.concat(k, ".feed")))),
                    pythId,
                    uint16(c.cfg.readUint(string.concat(k, ".maxConfBps")))
                );
            }
            return address(v);
        }
        if (_isTestSigner(c)) {
            address signer = c.cfg.readAddress(".perps.priceSigner");
            if (signer == address(0)) revert NotConfigured("perps.priceSigner");
            return address(new SignedReportVerifier(deployer, signer));
        }
        address v = c.cfg.readAddress(".perps.reportVerifier");
        if (v == address(0) || v.code.length == 0) revert NotConfigured("perps.reportVerifier (open decision FR-19)");
        return v;
    }

    function _markets(Ctx memory c, OracleAdapter oracle, PerpEngine engine) internal {
        for (uint256 i = 0;; i++) {
            string memory k = string.concat(".perps.markets[", vm.toString(i), "]");
            if (!vm.keyExistsJson(c.cfg, k)) break;
            bytes32 feedId = keccak256(bytes(c.cfg.readString(string.concat(k, ".feed"))));
            oracle.setFeed(
                feedId,
                true,
                uint32(c.cfg.readUint(string.concat(k, ".maxReportAge"))),
                c.cfg.readAddress(string.concat(k, ".reference")),
                uint32(c.cfg.readUint(string.concat(k, ".referenceHeartbeat"))),
                uint16(c.cfg.readUint(string.concat(k, ".maxDeviationBps")))
            );
            engine.setMarket(uint32(c.cfg.readUint(string.concat(k, ".id"))), _marketConfig(c.cfg, k, feedId));
        }
    }

    function _marketConfig(string memory cfg, string memory k, bytes32 feedId)
        internal
        pure
        returns (PerpEngine.MarketConfig memory m)
    {
        m.feedId = feedId;
        m.enabled = true;
        m.maxLeverageBps = uint32(cfg.readUint(string.concat(k, ".maxLeverageBps")));
        m.maintenanceMarginBps = uint16(cfg.readUint(string.concat(k, ".maintenanceMarginBps")));
        m.openFeeBps = uint16(cfg.readUint(string.concat(k, ".openFeeBps")));
        m.closeFeeBps = uint16(cfg.readUint(string.concat(k, ".closeFeeBps")));
        m.liquidationFeeBps = uint16(cfg.readUint(string.concat(k, ".liquidationFeeBps")));
        m.maxProfitBps = uint32(cfg.readUint(string.concat(k, ".maxProfitBps")));
        m.maxOpenInterestLong = uint128(cfg.readUint(string.concat(k, ".maxOpenInterestLong")));
        m.maxOpenInterestShort = uint128(cfg.readUint(string.concat(k, ".maxOpenInterestShort")));
        m.minCollateral = uint128(cfg.readUint(string.concat(k, ".minCollateral")));
        m.maxFundingRatePerHour = uint128(cfg.readUint(string.concat(k, ".maxFundingRatePerHour")));
    }

    function _context() internal view returns (Ctx memory c) {
        c.network = vm.envString("NETWORK");
        c.cfg = vm.readFile(string.concat("config/", c.network, ".json"));
        string memory foundation = vm.readFile(string.concat("deployments/", c.network, ".foundation.json"));
        string memory execution = vm.readFile(string.concat("deployments/", c.network, ".execution.json"));
        uint256 chainId = c.cfg.readUint(".chainId");
        if (block.chainid != chainId) revert WrongChain(chainId, block.chainid);
        c.admin = c.cfg.readAddress(".admin");
        if (c.admin == address(0)) revert NotConfigured("admin");
        c.feeRecipient = FeeRecipients.treasury(c.cfg, c.network, ".perps.feeRecipient", "perps");
        if (c.feeRecipient == address(0)) revert NotConfigured("perps.feeRecipient");
        c.testAssets = c.cfg.readBool(".deployTestAssets");
        c.usdg = c.testAssets ? foundation.readAddress(".usdg") : c.cfg.readAddress(".assets.usdg");
        c.pool = execution.readAddress(".shieldedPool");
        if (c.usdg.code.length == 0) revert NotConfigured("usdg");
        if (c.pool.code.length == 0) revert NotConfigured("shieldedPool");
    }

    function _write(Ctx memory c, Out memory o) internal {
        string memory out = "perps";
        out.serialize("priceSource", c.cfg.readString(".perps.priceSource"));
        out.serialize("reportVerifier", o.verifier);
        out.serialize("oracleAdapter", o.oracle);
        out.serialize("perpLiquidityVault", o.vault);
        out.serialize("perpEngine", o.engine);
        out.serialize("orderManager", o.orders);
        out.serialize("perpLens", o.lens);
        out.serialize("shieldedPerpsAdapter", o.adapter);
        out = out.serialize("deployBlock", block.number);
        vm.writeJson(out, string.concat("deployments/", c.network, ".perps.json"));
    }
}
