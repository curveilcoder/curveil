// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {TestFaucet} from "../src/testnet/TestFaucet.sol";

contract TestFaucetTest is Test {
    TestToken usdg;
    TestToken weth;
    TestFaucet faucet;
    address user = address(0xCAFE);

    function setUp() public {
        usdg = new TestToken("Curveil Test USDG", "tUSDG", 6, address(this));
        weth = new TestToken("Curveil Test WETH", "tWETH", 18, address(this));
        faucet = new TestFaucet(address(this), 1 days);
        usdg.grantRole(usdg.MINTER_ROLE(), address(faucet));
        weth.grantRole(weth.MINTER_ROLE(), address(faucet));
        faucet.configure(address(usdg), 10_000e6, true);
        faucet.configure(address(weth), 5 ether, true);
        vm.warp(1_700_000_000);
    }

    function test_claimMintsConfiguredAmounts() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(weth);
        vm.prank(user);
        faucet.claimMany(tokens);
        assertEq(usdg.balanceOf(user), 10_000e6);
        assertEq(weth.balanceOf(user), 5 ether);
    }

    function test_cooldownBlocksSecondClaim() public {
        vm.startPrank(user);
        faucet.claim(address(usdg));
        uint256 at = block.timestamp + 1 days;
        vm.expectRevert(abi.encodeWithSelector(TestFaucet.CoolingDown.selector, address(usdg), at));
        faucet.claim(address(usdg));
        vm.warp(at);
        faucet.claim(address(usdg));
        vm.stopPrank();
        assertEq(usdg.balanceOf(user), 20_000e6);
    }

    function test_disabledDripReverts() public {
        faucet.configure(address(usdg), 1, false);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(TestFaucet.DripDisabled.selector, address(usdg)));
        faucet.claim(address(usdg));
    }

    function test_onlyMinterCanMint() public {
        vm.prank(user);
        vm.expectRevert();
        usdg.mint(user, 1);
    }

    function test_decimals() public view {
        assertEq(usdg.decimals(), 6);
        assertEq(weth.decimals(), 18);
    }
}
