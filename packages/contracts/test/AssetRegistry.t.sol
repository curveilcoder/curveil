// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AssetRegistry} from "../src/shared/AssetRegistry.sol";
import {TestToken} from "../src/testnet/TestToken.sol";

contract AssetRegistryTest is Test {
    AssetRegistry registry;
    TestToken usdg;
    address owner = address(0xA11CE);
    address stranger = address(0xBEEF);

    function setUp() public {
        registry = new AssetRegistry(owner);
        usdg = new TestToken("Curveil Test USDG", "tUSDG", 6, owner);
    }

    function test_admitRecordsDecimalsAndLabel() public {
        vm.prank(owner);
        registry.admit(address(usdg), "USDG");
        AssetRegistry.Asset memory a = registry.asset(address(usdg));
        assertEq(uint8(a.status), uint8(AssetRegistry.Status.Admitted));
        assertEq(a.decimals, 6);
        assertEq(a.label, "USDG");
        assertTrue(registry.isAdmitted(address(usdg)));
        assertEq(registry.assets().length, 1);
    }

    function test_onlyOwnerCanAdmit() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.admit(address(usdg), "USDG");
    }

    function test_cannotAdmitTwice() public {
        vm.startPrank(owner);
        registry.admit(address(usdg), "USDG");
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.AlreadyListed.selector, address(usdg)));
        registry.admit(address(usdg), "USDG");
        vm.stopPrank();
    }

    function test_suspendAndReinstate() public {
        vm.startPrank(owner);
        registry.admit(address(usdg), "USDG");
        registry.suspend(address(usdg));
        assertFalse(registry.isAdmitted(address(usdg)));
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotAdmitted.selector, address(usdg)));
        registry.requireAdmitted(address(usdg));
        registry.reinstate(address(usdg));
        assertTrue(registry.isAdmitted(address(usdg)));
        vm.stopPrank();
    }

    function test_unknownAssetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotListed.selector, address(usdg)));
        registry.asset(address(usdg));
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        registry.transferOwnership(stranger);
        assertEq(registry.owner(), owner);
        vm.prank(stranger);
        registry.acceptOwnership();
        assertEq(registry.owner(), stranger);
    }
}
