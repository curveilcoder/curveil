// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetRegistry} from "../../src/shared/AssetRegistry.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {DammFactory} from "../../src/markets/DammFactory.sol";
import {DammPool} from "../../src/markets/DammPool.sol";
import {DlmmFactory} from "../../src/markets/DlmmFactory.sol";
import {DlmmPair} from "../../src/markets/DlmmPair.sol";
import {CurveilRouter} from "../../src/markets/CurveilRouter.sol";
import {LiquidityShapes} from "../../src/markets/libraries/LiquidityShapes.sol";

abstract contract MarketsBase is Test {
    uint256 internal constant Q128 = 1 << 128;

    AssetRegistry internal registry;
    TestToken internal usdg;
    TestToken internal weth;
    TestToken internal wbtc;
    DammFactory internal dammFactory;
    DlmmFactory internal dlmmFactory;
    CurveilRouter internal router;

    address internal feeTo = makeAddr("feeTo");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public virtual {
        registry = new AssetRegistry(address(this));
        usdg = new TestToken("Curveil Test USDG", "tUSDG", 6, address(this));
        weth = new TestToken("Curveil Test WETH", "tWETH", 18, address(this));
        wbtc = new TestToken("Curveil Test WBTC", "tWBTC", 8, address(this));
        registry.admit(address(usdg), "USDG");
        registry.admit(address(weth), "WETH");
        registry.admit(address(wbtc), "WBTC");

        dammFactory = new DammFactory(address(this), registry, feeTo);
        dammFactory.setTier(0, defaultTier(), true);
        dlmmFactory = new DlmmFactory(address(this), registry, feeTo, 2000);
        dlmmFactory.setPreset(10, 20, true);
        dlmmFactory.setPreset(25, 30, true);
        dlmmFactory.setPreset(100, 80, true);
        router = new CurveilRouter(dammFactory, dlmmFactory);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            usdg.mint(users[i], 1e15); // 1bn tUSDG
            weth.mint(users[i], 1e24); // 1m tWETH
            wbtc.mint(users[i], 1e14); // 1m tWBTC
            vm.startPrank(users[i]);
            usdg.approve(address(router), type(uint256).max);
            weth.approve(address(router), type(uint256).max);
            wbtc.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function defaultTier() internal pure returns (DammPool.FeeParams memory) {
        return DammPool.FeeParams({
            baseFeeBps: 30,
            maxFeeBps: 100,
            protocolShareBps: 2000,
            variableFeeControl: 2000,
            filterPeriod: 30,
            decayPeriod: 600,
            reductionBps: 5000,
            maxVolatilityBps: 5000
        });
    }

    // ------------------------------------------------------------------ DAMM helpers

    function _dammPool(address a, address b, uint256 amountA, uint256 amountB) internal returns (DammPool pool) {
        pool = DammPool(dammFactory.createPool(a, b, 0));
        vm.prank(alice);
        router.addLiquidityDamm(
            CurveilRouter.DammDeposit({
                tokenA: a,
                tokenB: b,
                amountADesired: amountA,
                amountBDesired: amountB,
                amountAMin: 0,
                amountBMin: 0,
                to: alice,
                deadline: block.timestamp
            })
        );
    }

    function _hop(address pool, address tokenIn, address tokenOut)
        internal
        pure
        returns (CurveilRouter.Hop[] memory h)
    {
        h = new CurveilRouter.Hop[](1);
        h[0] = CurveilRouter.Hop(pool, tokenIn, tokenOut);
    }

    function _swap(address who, address pool, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return router.swapExactIn(_hop(pool, tokenIn, tokenOut), amountIn, 0, who, block.timestamp);
    }

    // ------------------------------------------------------------------ DLMM helpers

    function _idForPrice(uint256 priceQ128, uint16 binStep) internal pure returns (uint24) {
        return LiquidityShapes.idForPrice(priceQ128, binStep);
    }

    /// Price of tokenB per tokenA in raw units, Q128, from a human price.
    function _rawPrice(uint256 humanPriceE6, uint8 decA, uint8 decB) internal pure returns (uint256) {
        return Math.mulDiv(humanPriceE6 * 10 ** decB, Q128, 1e6 * 10 ** decA);
    }

    function _shape(LiquidityShapes.Shape shape, uint256 k)
        internal
        pure
        returns (int256[] memory ids, uint256[] memory dx, uint256[] memory dy)
    {
        return LiquidityShapes.distribution(shape, k);
    }

    function _addDlmm(
        address who,
        DlmmPair pair,
        uint256 amountX,
        uint256 amountY,
        LiquidityShapes.Shape shape,
        uint256 k
    ) internal returns (uint256[] memory ids, uint256[] memory minted) {
        (int256[] memory d, uint256[] memory dx, uint256[] memory dy) = _shape(shape, k);
        CurveilRouter.DlmmDeposit memory dep = CurveilRouter.DlmmDeposit({
            pair: address(pair),
            amountX: amountX,
            amountY: amountY,
            activeIdExpected: pair.activeId(),
            idSlippage: 0,
            deltaIds: d,
            distributionX: dx,
            distributionY: dy,
            to: who,
            deadline: block.timestamp
        });
        vm.prank(who);
        (,, ids, minted) = router.addLiquidityDlmm(dep);
    }

    /// WETH/USDG pair at 2000 USDG per WETH with balanced liquidity over 2k+1 bins.
    function _dlmmWethUsdg(uint16 binStep, uint256 k) internal returns (DlmmPair pair) {
        uint24 id = _idForPrice(_rawPrice(2000e6, 18, 6), binStep);
        pair = DlmmPair(dlmmFactory.createPair(address(weth), address(usdg), binStep, id));
        (uint256 ax, uint256 ay) = pair.tokenX() == address(weth)
            ? (uint256(100e18), uint256(200_000e6))
            : (uint256(200_000e6), uint256(100e18));
        _addDlmm(alice, pair, ax, ay, LiquidityShapes.Shape.Balanced, k);
    }

    function _sumBins(DlmmPair pair, uint24 from, uint24 to) internal view returns (uint256 x, uint256 y) {
        for (uint24 id = from; id <= to; ++id) {
            DlmmPair.Bin memory b = pair.getBin(id);
            x += b.x;
            y += b.y;
        }
    }
}
