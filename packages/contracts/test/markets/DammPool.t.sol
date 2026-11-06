// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {MarketsBase} from "./MarketsBase.sol";
import {DammPool} from "../../src/markets/DammPool.sol";
import {DammFactory} from "../../src/markets/DammFactory.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {CurveilRouter} from "../../src/markets/CurveilRouter.sol";

contract DammPoolTest is MarketsBase {
    DammPool internal pool;

    function setUp() public override {
        super.setUp();
        // 1,000,000 tUSDG and 500 tWETH: 2,000 tUSDG per tWETH.
        pool = _dammPool(address(usdg), address(weth), 1_000_000e6, 500e18);
    }

    function _r(address token) internal view returns (uint256) {
        (uint128 r0, uint128 r1) = pool.getReserves();
        return token == pool.token0() ? r0 : r1;
    }

    /// Whitepaper example: a 1,000 USDG trade at 0.30% pays 3 USDG, 2.40 to LPs and 0.60 to the protocol.
    function test_whitepaperFeeExample() public {
        vm.expectEmit(true, true, false, false, address(pool));
        emit DammPool.Swap(address(router), bob, address(usdg) == pool.token0(), 1000e6, 0, 3e6, 0.6e6, 30);
        _swap(bob, address(pool), address(usdg), address(weth), 1000e6);

        bool usdgIs0 = address(usdg) == pool.token0();
        assertEq(usdgIs0 ? pool.protocolFees0() : pool.protocolFees1(), 0.6e6, "protocol share");
        assertEq(usdgIs0 ? pool.lpFees0() : pool.lpFees1(), 2.4e6, "LP share");

        (uint256 p0, uint256 p1) = pool.pendingFees(alice);
        assertApproxEqAbs(usdgIs0 ? p0 : p1, 2.4e6, 1, "alice owns all but the locked minimum");

        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        pool.claimFees(alice);
        assertApproxEqAbs(usdg.balanceOf(alice) - before, 2.4e6, 1);

        pool.collectProtocolFees();
        assertEq(usdg.balanceOf(feeTo), 0.6e6);
    }

    function test_feeIsChargedOnInputAndKGrows() public {
        uint256 k0 = _r(address(usdg)) * _r(address(weth));
        (uint256 quoted, uint256 fee) = pool.quote(address(usdg), 10_000e6);
        uint256 out = _swap(bob, address(pool), address(usdg), address(weth), 10_000e6);
        assertEq(out, quoted, "quote equals swap");
        assertEq(fee, 30e6);
        assertGe(_r(address(usdg)) * _r(address(weth)), k0, "k never decreases");
    }

    function testFuzz_quoteEqualsSwapAndKHolds(uint256 amountIn, bool usdgIn) public {
        (address tin, address tout) = usdgIn ? (address(usdg), address(weth)) : (address(weth), address(usdg));
        amountIn = bound(amountIn, usdgIn ? 1e4 : 1e13, usdgIn ? 5_000_000e6 : 2_500e18);
        uint256 k0 = _r(address(usdg)) * _r(address(weth));
        (uint256 quoted,) = pool.quote(tin, amountIn);
        uint256 out = _swap(bob, address(pool), tin, tout, amountIn);
        assertEq(out, quoted);
        assertGe(_r(address(usdg)) * _r(address(weth)), k0);
        _assertSolvent();
    }

    function test_dynamicFeeRisesWithVolatilityAndDecays() public {
        assertEq(pool.currentFeeBps(), 30);
        // Move the price about 5%.
        _swap(bob, address(pool), address(usdg), address(weth), 25_000e6);
        uint16 raised = pool.currentFeeBps();
        assertGt(raised, 30, "fee rises after a large move");
        assertLe(raised, 100, "never above the cap");

        // Still inside the filter period: volatility keeps the reference price.
        vm.warp(block.timestamp + 10);
        assertEq(pool.currentFeeBps(), raised);

        // Past the decay period it returns to the base fee.
        vm.warp(block.timestamp + 601);
        assertEq(pool.currentFeeBps(), 30);
    }

    function test_feeCappedAtMaximum() public {
        _swap(bob, address(pool), address(usdg), address(weth), 400_000e6); // ~ -50% move
        assertEq(pool.currentFeeBps(), 100);
        (, uint256 fee) = pool.quote(address(usdg), 1000e6);
        assertEq(fee, 10e6);
    }

    function test_lpTransferSettlesFees() public {
        _swap(bob, address(pool), address(usdg), address(weth), 1000e6);
        (uint256 a0, uint256 a1) = pool.pendingFees(alice);
        uint256 half = pool.balanceOf(alice) / 2;
        vm.prank(alice);
        pool.transfer(carol, half);

        (uint256 b0, uint256 b1) = pool.pendingFees(alice);
        assertEq(a0, b0, "earned fees stay with the sender");
        assertEq(a1, b1);
        (uint256 c0, uint256 c1) = pool.pendingFees(carol);
        assertEq(c0 + c1, 0, "receiver starts at zero");

        _swap(bob, address(pool), address(usdg), address(weth), 1000e6);
        (uint256 c0b, uint256 c1b) = pool.pendingFees(carol);
        assertGt(c0b + c1b, 0, "receiver earns from now on");
    }

    function test_removeLiquidityKeepsFeesClaimable() public {
        _swap(bob, address(pool), address(usdg), address(weth), 1000e6);
        uint256 lp = pool.balanceOf(alice);
        vm.startPrank(alice);
        pool.approve(address(router), lp);
        uint256 u0 = usdg.balanceOf(alice);
        (uint256 au, uint256 aw) =
            router.removeLiquidityDamm(address(usdg), address(weth), lp, 1, 1, alice, block.timestamp);
        assertEq(usdg.balanceOf(alice) - u0, au);
        assertGt(aw, 0);
        assertEq(pool.balanceOf(alice), 0);
        (uint256 f0, uint256 f1) = pool.pendingFees(alice);
        assertApproxEqAbs(f0 + f1, 2.4e6, 1);
        pool.claimFees(alice);
        vm.stopPrank();
        _assertSolvent();
    }

    function test_secondDepositIsProportional() public {
        vm.prank(bob);
        (uint256 a, uint256 b, uint256 liq) =
            router.addLiquidityDamm(_deposit(address(weth), address(usdg), 10e18, 1_000_000e6, bob));
        assertEq(a, 10e18);
        assertEq(b, 20_000e6, "uses only the matching amount of USDG");
        assertGt(liq, 0);
    }

    function test_donationIsNotStolenFromLps() public {
        vm.prank(carol);
        usdg.transfer(address(pool), 5_000e6);
        // The donation counts as the next swapper's input, never as owed fees.
        _swap(bob, address(pool), address(weth), address(usdg), 1e18);
        _assertSolvent();
    }

    function test_revertWhen_tokenNotInPool() public {
        vm.expectRevert(abi.encodeWithSelector(DammPool.InvalidToken.selector, address(wbtc)));
        pool.quote(address(wbtc), 1);
    }

    function test_revertWhen_noInput() public {
        vm.expectRevert(DammPool.InsufficientInput.selector);
        pool.swap(address(usdg), bob);
    }

    function test_factoryRules() public {
        vm.expectRevert(abi.encodeWithSelector(DammFactory.PoolExists.selector, address(pool)));
        dammFactory.createPool(address(weth), address(usdg), 0);

        vm.expectRevert(DammFactory.IdenticalTokens.selector);
        dammFactory.createPool(address(weth), address(weth), 0);

        vm.expectRevert(abi.encodeWithSelector(DammFactory.TierDisabled.selector, uint8(7)));
        dammFactory.createPool(address(weth), address(wbtc), 7);

        TestToken rogue = new TestToken("Rogue", "RGE", 18, address(this));
        vm.expectRevert(abi.encodeWithSelector(DammFactory.AssetNotAdmitted.selector, address(rogue)));
        dammFactory.createPool(address(rogue), address(weth), 0);

        DammPool.FeeParams memory bad = defaultTier();
        bad.maxFeeBps = 2000;
        vm.expectRevert(DammFactory.InvalidParams.selector);
        dammFactory.setTier(1, bad, true);

        vm.prank(alice);
        vm.expectRevert();
        dammFactory.setTier(1, defaultTier(), true);
    }

    function test_existingPoolKeepsItsFees() public {
        DammPool.FeeParams memory t = defaultTier();
        t.baseFeeBps = 50;
        dammFactory.setTier(0, t, true);
        assertEq(pool.feeParams().baseFeeBps, 30);
    }

    function _deposit(address a, address b, uint256 amountA, uint256 amountB, address to)
        internal
        view
        returns (CurveilRouter.DammDeposit memory)
    {
        return CurveilRouter.DammDeposit(a, b, amountA, amountB, 0, 0, to, block.timestamp);
    }

    function _assertSolvent() internal view {
        uint256 bal0 = TestToken(pool.token0()).balanceOf(address(pool));
        uint256 bal1 = TestToken(pool.token1()).balanceOf(address(pool));
        (uint128 r0, uint128 r1) = pool.getReserves();
        assertGe(bal0, uint256(r0) + pool.lpFees0() + pool.protocolFees0(), "token0 solvent");
        assertGe(bal1, uint256(r1) + pool.lpFees1() + pool.protocolFees1(), "token1 solvent");
    }
}
