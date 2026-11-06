// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MarketsBase} from "./MarketsBase.sol";
import {AssetRegistry} from "../../src/shared/AssetRegistry.sol";
import {DlmmFactory} from "../../src/markets/DlmmFactory.sol";
import {DlmmPair} from "../../src/markets/DlmmPair.sol";
import {DammFactory} from "../../src/markets/DammFactory.sol";
import {DammPool} from "../../src/markets/DammPool.sol";
import {BinMath} from "../../src/markets/libraries/BinMath.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

/// Owner bounds and creation rules of both factories.
contract FactoriesTest is MarketsBase {
    address stranger = makeAddr("stranger");

    // ---------------------------------------------------------------- DLMM

    function test_dlmmConstructorChecks() public {
        vm.expectRevert(DlmmFactory.ZeroAddress.selector);
        new DlmmFactory(address(this), registry, address(0), 2000);
        vm.expectRevert(DlmmFactory.ZeroAddress.selector);
        new DlmmFactory(address(this), AssetRegistry(address(0)), feeTo, 2000);
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        new DlmmFactory(address(this), registry, feeTo, 5001);
    }

    function test_dlmmPresetBounds() public {
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.setPreset(0, 20, true);
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.setPreset(201, 20, true);
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.setPreset(50, 0, true);
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.setPreset(50, 1001, true);

        uint256 before = dlmmFactory.binSteps().length;
        dlmmFactory.setPreset(50, 40, true);
        dlmmFactory.setPreset(50, 45, false); // updating does not list the step twice
        uint16[] memory steps = dlmmFactory.binSteps();
        assertEq(steps.length, before + 1);
        assertEq(steps[steps.length - 1], 50);
        (uint16 fee, bool on) = dlmmFactory.presets(50);
        assertEq(fee, 45);
        assertFalse(on);
    }

    function test_dlmmOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        dlmmFactory.setPreset(50, 40, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        dlmmFactory.setFeeTo(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        dlmmFactory.setProtocolShare(100);
        vm.stopPrank();
    }

    function test_dlmmFeeToAndShareApplyToNewPairsOnly() public {
        vm.expectRevert(DlmmFactory.ZeroAddress.selector);
        dlmmFactory.setFeeTo(address(0));
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.setProtocolShare(5001);

        address old = dlmmFactory.createPair(address(weth), address(usdg), 25, BinMath.CENTER);
        dlmmFactory.setProtocolShare(1000);
        dlmmFactory.setFeeTo(stranger);
        assertEq(dlmmFactory.feeTo(), stranger);
        address fresh = dlmmFactory.createPair(address(wbtc), address(usdg), 25, BinMath.CENTER);
        assertEq(DlmmPair(old).protocolShareBps(), 2000, "existing pair keeps its share");
        assertEq(DlmmPair(fresh).protocolShareBps(), 1000);
        assertEq(dlmmFactory.allPairsLength(), 2);
    }

    function test_dlmmCreatePairRules() public {
        vm.expectRevert(DlmmFactory.IdenticalTokens.selector);
        dlmmFactory.createPair(address(weth), address(weth), 25, BinMath.CENTER);
        vm.expectRevert(abi.encodeWithSelector(DlmmFactory.PresetDisabled.selector, uint16(7)));
        dlmmFactory.createPair(address(weth), address(usdg), 7, BinMath.CENTER);

        TestToken stray = new TestToken("Stray", "STRAY", 18, address(this));
        (address lo, address hi) = address(stray) < address(usdg) ? (address(stray), address(usdg)) : (address(usdg), address(stray));
        vm.expectRevert();
        dlmmFactory.createPair(lo, hi, 25, BinMath.CENTER);

        address pair = dlmmFactory.createPair(address(weth), address(usdg), 25, BinMath.CENTER);
        assertTrue(dlmmFactory.isPool(pair));
        assertEq(dlmmFactory.getPair(address(usdg), address(weth), 25), pair);
        vm.expectRevert(abi.encodeWithSelector(DlmmFactory.PairExists.selector, pair));
        dlmmFactory.createPair(address(usdg), address(weth), 25, BinMath.CENTER);
    }

    function test_dlmmPriceIsInvertedWhenTheOrderFlips() public {
        (address x, address y) = address(weth) < address(usdg) ? (address(weth), address(usdg)) : (address(usdg), address(weth));
        uint24 id = BinMath.CENTER + 100;
        address a = dlmmFactory.createPair(y, x, 25, id); // stated as price of x per y
        assertEq(DlmmPair(a).activeId(), BinMath.CENTER - 100);
        address b = dlmmFactory.createPair(x, y, 10, id);
        assertEq(DlmmPair(b).activeId(), id);
        vm.expectRevert(DlmmFactory.InvalidParams.selector);
        dlmmFactory.createPair(y, x, 100, 0); // would flip past the top bin
    }

    function test_suspendedAssetGetsNoNewPools() public {
        registry.suspend(address(weth));
        vm.expectRevert();
        dlmmFactory.createPair(address(weth), address(usdg), 25, BinMath.CENTER);
        vm.expectRevert();
        dammFactory.createPool(address(weth), address(usdg), 0);
    }

    // ---------------------------------------------------------------- DAMM

    function test_dammTierBounds() public {
        DammPool.FeeParams memory p = _tier();
        p.baseFeeBps = 0;
        vm.expectRevert(DammFactory.InvalidParams.selector);
        dammFactory.setTier(9, p, true);
        p = _tier();
        p.maxFeeBps = 1001;
        vm.expectRevert(DammFactory.InvalidParams.selector);
        dammFactory.setTier(9, p, true);
        p = _tier();
        p.baseFeeBps = p.maxFeeBps + 1;
        vm.expectRevert(DammFactory.InvalidParams.selector);
        dammFactory.setTier(9, p, true);
        p = _tier();
        p.protocolShareBps = 5001;
        vm.expectRevert(DammFactory.InvalidParams.selector);
        dammFactory.setTier(9, p, true);
        p = _tier();
        p.filterPeriod = p.decayPeriod;
        vm.expectRevert(DammFactory.InvalidParams.selector);
        dammFactory.setTier(9, p, true);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        dammFactory.setTier(9, _tier(), true);
        vm.expectRevert(DammFactory.ZeroAddress.selector);
        dammFactory.setFeeTo(address(0));
    }

    function test_dammTierChangeLeavesExistingPools() public {
        address pool = dammFactory.createPool(address(weth), address(usdg), 0);
        uint256 before = DammPool(pool).currentFeeBps();
        DammPool.FeeParams memory p = _tier();
        p.baseFeeBps = 500;
        p.maxFeeBps = 900;
        dammFactory.setTier(0, p, true);
        assertEq(DammPool(pool).currentFeeBps(), before);
    }

    function _tier() internal pure returns (DammPool.FeeParams memory) {
        return defaultTier();
    }
}
