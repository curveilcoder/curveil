// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {DammFactory} from "../src/markets/DammFactory.sol";
import {DlmmFactory} from "../src/markets/DlmmFactory.sol";
import {DlmmPair} from "../src/markets/DlmmPair.sol";
import {CurveilRouter} from "../src/markets/CurveilRouter.sol";
import {LiquidityShapes} from "../src/markets/libraries/LiquidityShapes.sol";

/// @notice TESTNET ONLY. Creates a tUSDG/tWETH DAMM pool and DLMM pair and seeds them with
///         freshly minted test tokens, so the markets have liquidity to trade against.
/// Usage: NETWORK=testnet forge script script/SeedTestPools.s.sol --rpc-url robinhood_testnet --broadcast
contract SeedTestPools is Script {
    using stdJson for string;

    uint256 internal constant MAINNET_CHAIN_ID = 4663;

    error NotOnMainnet();

    struct Ctx {
        string cfg;
        TestToken usdg;
        TestToken weth;
        CurveilRouter router;
        address deployer;
    }

    function run() external {
        if (block.chainid == MAINNET_CHAIN_ID) revert NotOnMainnet();
        string memory network = vm.envString("NETWORK");
        string memory f = vm.readFile(string.concat("deployments/", network, ".foundation.json"));
        string memory m = vm.readFile(string.concat("deployments/", network, ".markets.json"));
        Ctx memory c = Ctx({
            cfg: vm.readFile(string.concat("config/", network, ".json")),
            usdg: TestToken(f.readAddress(".usdg")),
            weth: TestToken(f.readAddress(".weth")),
            router: CurveilRouter(m.readAddress(".router")),
            deployer: address(0)
        });

        vm.startBroadcast();
        c.deployer = msg.sender;
        c.usdg.mint(c.deployer, c.cfg.readUint(".seed.damm.usdg") + c.cfg.readUint(".seed.dlmm.usdg"));
        c.weth.mint(c.deployer, c.cfg.readUint(".seed.damm.weth") + c.cfg.readUint(".seed.dlmm.weth"));
        c.usdg.approve(address(c.router), type(uint256).max);
        c.weth.approve(address(c.router), type(uint256).max);
        address pool = _seedDamm(c, DammFactory(m.readAddress(".dammFactory")));
        address pair = _seedDlmm(c, DlmmFactory(m.readAddress(".dlmmFactory")));
        vm.stopBroadcast();

        string memory o = "pools";
        o.serialize("network", network);
        o.serialize("deployBlock", block.number);
        o.serialize("dammUsdgWeth", pool);
        string memory out = o.serialize("dlmmWethUsdg", pair);
        vm.writeJson(out, string.concat("deployments/", network, ".pools.json"));
        console2.log("DAMM tUSDG/tWETH", pool);
        console2.log("DLMM tWETH/tUSDG", pair);
    }

    function _seedDamm(Ctx memory c, DammFactory factory) internal returns (address pool) {
        uint256 u = c.cfg.readUint(".seed.damm.usdg");
        uint256 w = c.cfg.readUint(".seed.damm.weth");
        pool = factory.createPool(address(c.usdg), address(c.weth), uint8(c.cfg.readUint(".seed.damm.tier")));
        c.router
            .addLiquidityDamm(
                CurveilRouter.DammDeposit({
                    tokenA: address(c.usdg),
                    tokenB: address(c.weth),
                    amountADesired: u,
                    amountBDesired: w,
                    amountAMin: u,
                    amountBMin: w,
                    to: c.deployer,
                    deadline: block.timestamp + 600
                })
            );
    }

    function _seedDlmm(Ctx memory c, DlmmFactory factory) internal returns (address) {
        uint16 binStep = uint16(c.cfg.readUint(".seed.dlmm.binStep"));
        // Raw price of tWETH in tUSDG units (Q128): human price * 1e6 / 1e18.
        uint256 priceQ128 = Math.mulDiv(c.cfg.readUint(".seed.priceUsdgPerWethE6"), 1 << 128, 1e18);
        // activeId is stated as the price of tokenB (tUSDG) per tokenA (tWETH).
        uint24 id = LiquidityShapes.idForPrice(priceQ128, binStep);
        DlmmPair pair = DlmmPair(factory.createPair(address(c.weth), address(c.usdg), binStep, id));
        CurveilRouter.DlmmDeposit memory dep;
        (dep.deltaIds, dep.distributionX, dep.distributionY) =
            LiquidityShapes.distribution(LiquidityShapes.Shape.Balanced, c.cfg.readUint(".seed.dlmm.radius"));
        bool wethIsX = pair.tokenX() == address(c.weth);
        uint256 u = c.cfg.readUint(".seed.dlmm.usdg");
        uint256 w = c.cfg.readUint(".seed.dlmm.weth");
        dep.pair = address(pair);
        dep.amountX = wethIsX ? w : u;
        dep.amountY = wethIsX ? u : w;
        dep.activeIdExpected = pair.activeId();
        dep.to = c.deployer;
        dep.deadline = block.timestamp + 600;
        c.router.addLiquidityDlmm(dep);
        return address(pair);
    }
}
