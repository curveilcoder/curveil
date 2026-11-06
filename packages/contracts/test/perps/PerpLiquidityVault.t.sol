// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {PerpLiquidityVault} from "../../src/perps/PerpLiquidityVault.sol";

contract PerpLiquidityVaultTest is PerpsBase {
    function test_DepositAndRedeemAtNav() public {
        assertEq(vault.balanceOf(lp), 500_000e18, "1 USDG = 1 share in an empty vault");
        assertEq(vault.totalAssets(), 500_000 * USD);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(PerpLiquidityVault.Locked.selector, block.timestamp + 1 hours));
        vault.redeem(1e18, 0, lp);
        vm.warp(block.timestamp + 1 hours);
        uint256 before = usdg.balanceOf(lp);
        vm.prank(lp);
        uint256 out = vault.redeem(100_000e18, 0, lp);
        assertApproxEqAbs(out, 100_000 * USD, 1);
        assertEq(usdg.balanceOf(lp) - before, out);
    }

    function test_LockedSharesCannotMove() public {
        vm.prank(lp);
        vm.expectRevert();
        vault.transfer(alice, 1e18);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(lp);
        vault.transfer(alice, 1e18);
        assertEq(vault.balanceOf(alice), 1e18);
    }

    function test_NavCountsOpenPositions() public {
        uint256 id = _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 navAfterOpen = vault.totalAssets();
        _submit(ETH, 2_200e18); // alice +1,000
        assertApproxEqAbs(vault.totalAssets(), navAfterOpen - 1_000 * USD, 1_000);
        _submit(ETH, 1_800e18); // alice -1,000
        assertApproxEqAbs(vault.totalAssets(), navAfterOpen + 1_000 * USD, 1_000);

        // a new depositor pays the current value
        vm.prank(bob);
        uint256 shares = vault.deposit(10_000 * USD, 0);
        assertApproxEqRel(vault.previewRedeem(shares), 10_000 * USD, 1e12);

        // a stale price stops share pricing until a keeper records a new one
        vm.warp(block.timestamp + 301);
        vm.expectRevert(abi.encodeWithSelector(PerpLiquidityVault.StalePrice.selector, M_ETH));
        vault.totalAssets();
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1 * USD, 0);
        _submit(ETH, PRICE);
        vault.totalAssets();
        id;
    }

    function test_NavCapsTraderGainsAtReserve() public {
        _open(alice, M_ETH, true, 10_000 * USD, 2_100 * USD, PRICE);
        uint256 nav = vault.totalAssets();
        _submit(ETH, 10_000e18); // +400%, capped at the 10,000 reserve
        assertApproxEqAbs(vault.totalAssets(), nav - 10_000 * USD, 1_000);
    }

    function test_RedeemLimitedToUnreserved() public {
        // reserve 380k of the 500k
        _open(alice, M_ETH, true, 380_000 * USD, 80_000 * USD, PRICE);
        vm.warp(block.timestamp + 1 hours);
        _submit(ETH, PRICE);
        uint256 free = vault.freeLiquidity();
        assertApproxEqAbs(free, usdg.balanceOf(address(vault)) - 380_000 * USD, 1);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(PerpLiquidityVault.InsufficientLiquidity.selector, free));
        vault.redeem(200_000e18, 0, lp);
        vm.prank(lp);
        vault.redeem(100_000e18, 0, lp);
        _checkSolvency();
    }

    function test_DepositCapAndSlippage() public {
        vm.prank(admin);
        vault.setParams(8_000, 1 hours, 510_000 * USD);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PerpLiquidityVault.AboveDepositCap.selector, 510_000 * USD));
        vault.deposit(10_001 * USD, 0);
        vm.prank(bob);
        vm.expectRevert(PerpLiquidityVault.Slippage.selector);
        vault.deposit(10_000 * USD, 10_001e18);
        vm.prank(bob);
        vault.deposit(10_000 * USD, 9_999e18);
    }

    function test_DonationDoesNotStealDeposits() public {
        PerpLiquidityVault fresh = new PerpLiquidityVault(usdg, admin, 8_000, 0, 0);
        vm.startPrank(alice);
        usdg.approve(address(fresh), type(uint256).max);
        fresh.deposit(1, 0);
        usdg.transfer(address(fresh), 10_000 * USD); // donation to inflate the share price
        vm.stopPrank();
        vm.startPrank(bob);
        usdg.approve(address(fresh), type(uint256).max);
        uint256 shares = fresh.deposit(1_000 * USD, 0);
        vm.stopPrank();
        assertGt(shares, 0);
        assertApproxEqRel(fresh.previewRedeem(shares), 1_000 * USD, 0.01e18);
    }

    function test_OnlyEnginePaysAndEngineSetOnce() public {
        vm.expectRevert(PerpLiquidityVault.OnlyEngine.selector);
        vault.pay(alice, 1);
        vm.prank(admin);
        vm.expectRevert(PerpLiquidityVault.EngineAlreadySet.selector);
        vault.setEngine(engine);
    }
}
