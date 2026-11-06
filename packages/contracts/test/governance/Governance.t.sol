// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketsBase} from "../markets/MarketsBase.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {DammPool} from "../../src/markets/DammPool.sol";
import {CurveilTimelock} from "../../src/governance/CurveilTimelock.sol";
import {ProtocolTreasury} from "../../src/governance/ProtocolTreasury.sol";
import {BuybackBurner} from "../../src/governance/BuybackBurner.sol";

contract GovernanceTest is MarketsBase {
    address safe = makeAddr("safe");
    address stranger = makeAddr("stranger");
    CurveilTimelock timelock;
    ProtocolTreasury treasury;
    BuybackBurner burner;
    TestToken curveil;
    DammPool pool;

    uint256 constant DELAY = 72 hours;

    function setUp() public override {
        super.setUp();
        address[] memory list = new address[](1);
        list[0] = safe;
        timelock = new CurveilTimelock(DELAY, list, list);
        treasury = new ProtocolTreasury("markets", address(timelock));
        burner = new BuybackBurner(IERC20(address(usdg)), address(timelock), safe);

        // The registry hands its ownership to the timelock (two steps).
        registry.transferOwnership(address(timelock));
        _viaTimelock(address(registry), abi.encodeWithSignature("acceptOwnership()"), "accept");

        curveil = new TestToken("Curveil", "CURVEIL", 18, address(this));
        _viaTimelock(address(registry), abi.encodeWithSignature("admit(address,string)", address(curveil), "CURVEIL"), "admit");
        curveil.mint(alice, 1e27);
        vm.prank(alice);
        curveil.approve(address(router), type(uint256).max);
        pool = _dammPool(address(curveil), address(usdg), 100_000_000e18, 1_000_000e6); // 0.01 USDG each
    }

    function _viaTimelock(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    // ---------------------------------------------------------------- timelock

    function test_noAdminCallBypassesTheDelay() public {
        bytes memory data = abi.encodeWithSignature("suspend(address)", address(weth));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        vm.prank(safe);
        registry.suspend(address(weth));

        vm.prank(safe);
        timelock.schedule(address(registry), 0, data, bytes32(0), "s", DELAY);
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(registry), 0, data, bytes32(0), "s");

        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        timelock.execute(address(registry), 0, data, bytes32(0), "s");
        assertFalse(registry.isAdmitted(address(weth)));
    }

    function test_onlyTheSafeProposes() public {
        bytes memory data = abi.encodeWithSignature("suspend(address)", address(weth));
        vm.prank(stranger);
        vm.expectRevert();
        timelock.schedule(address(registry), 0, data, bytes32(0), "x", DELAY);
    }

    function test_shorterDelayRefused() public {
        bytes memory data = abi.encodeWithSignature("suspend(address)", address(weth));
        vm.prank(safe);
        vm.expectRevert();
        timelock.schedule(address(registry), 0, data, bytes32(0), "x", DELAY - 1);
    }

    function test_mainnetFloorHolds() public {
        vm.chainId(4663);
        address[] memory list = new address[](1);
        list[0] = safe;
        vm.expectRevert(abi.encodeWithSelector(CurveilTimelock.DelayBelowFloor.selector, 1 hours, 72 hours));
        new CurveilTimelock(1 hours, list, list);

        CurveilTimelock t = new CurveilTimelock(72 hours, list, list);
        bytes memory data = abi.encodeWithSignature("updateDelay(uint256)", 1 hours);
        vm.prank(safe);
        t.schedule(address(t), 0, data, bytes32(0), "d", 72 hours);
        vm.warp(block.timestamp + 72 hours);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(CurveilTimelock.DelayBelowFloor.selector, 1 hours, 72 hours));
        t.execute(address(t), 0, data, bytes32(0), "d");
        assertEq(t.getMinDelay(), 72 hours);
    }

    function test_testnetMayUseShortDelay() public {
        address[] memory list = new address[](1);
        list[0] = safe;
        CurveilTimelock t = new CurveilTimelock(5 minutes, list, list);
        assertEq(t.getMinDelay(), 5 minutes);
        assertEq(t.delayFloor(), 0);
    }

    // ---------------------------------------------------------------- treasury

    function test_treasuryReleasesOnlyThroughTheTimelock() public {
        usdg.mint(address(treasury), 5_000e6);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        treasury.release(address(usdg), safe, 1, "x");

        _viaTimelock(
            address(treasury),
            abi.encodeCall(ProtocolTreasury.release, (address(usdg), address(burner), 2_000e6, "2026-11 buyback")),
            "r"
        );
        assertEq(usdg.balanceOf(address(burner)), 2_000e6);
        assertEq(treasury.balanceOf(address(usdg)), 3_000e6);
        assertEq(treasury.source(), bytes32("markets"));
    }

    /// Swaps through a pool whose protocol fees go to the treasury: only the protocol share
    /// (20% of the fee) lands there; the LP share stays in the pool for LPs.
    function test_treasuryReceivesOnlyTheProtocolShare() public {
        DammPool p = _dammPool(address(weth), address(usdg), 1_000e18, 3_000_000e6);
        _feeToTreasury();
        vm.prank(bob);
        usdg.transfer(address(p), 10_000e6);
        uint256 feeBps = p.currentFeeBps();
        vm.prank(bob);
        p.swap(address(usdg), bob);
        uint256 fee = (10_000e6 * feeBps + 9_999) / 10_000;
        (uint256 owed0, uint256 owed1) = (p.protocolFees0(), p.protocolFees1());
        p.collectProtocolFees();
        uint256 got = usdg.balanceOf(address(treasury));
        assertEq(got, (fee * 2000) / 10_000, "protocol share only");
        assertEq(owed0 + owed1, got);
    }

    function _feeToTreasury() internal {
        dammFactory.setFeeTo(address(treasury));
    }

    // ---------------------------------------------------------------- buyback and burn

    function _bind() internal {
        _viaTimelock(address(burner), abi.encodeCall(BuybackBurner.bind, (IERC20(address(curveil)), pool)), "b");
    }

    function test_buybackBurnsWithinTheImpactCap() public {
        _bind();
        usdg.mint(address(burner), 10_000e6);
        uint256 supply = curveil.totalSupply();
        uint256 impact = burner.impactBps(5_000e6);
        assertLe(impact, 100);
        vm.prank(safe);
        uint256 burned = burner.buyback(5_000e6, 1, block.timestamp);
        assertGt(burned, 0);
        assertEq(curveil.balanceOf(burner.DEAD()), burned, "bought tokens go straight to the burn address");
        assertEq(curveil.balanceOf(address(burner)), 0);
        assertEq(burner.burnedSupply(), burned);
        assertEq(burner.totalSpent(), 5_000e6);
        assertEq(burner.tranches(), 1);
        assertEq(curveil.totalSupply(), supply, "fixed supply; burn = dead address");
    }

    function test_buybackRefusesAboveOnePercentImpact() public {
        _bind();
        usdg.mint(address(burner), 100_000e6);
        uint256 impact = burner.impactBps(50_000e6); // 5% of the pool's USDG side
        assertGt(impact, 100);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(BuybackBurner.ImpactTooHigh.selector, impact));
        burner.buyback(50_000e6, 1, block.timestamp);
    }

    function test_buybackOnlyByOperatorAndAfterBind() public {
        usdg.mint(address(burner), 1_000e6);
        vm.prank(safe);
        vm.expectRevert(BuybackBurner.NotBound.selector);
        burner.buyback(100e6, 1, block.timestamp);
        _bind();
        vm.prank(stranger);
        vm.expectRevert(BuybackBurner.NotOperator.selector);
        burner.buyback(100e6, 1, block.timestamp);
        vm.prank(safe);
        vm.expectRevert(BuybackBurner.Expired.selector);
        burner.buyback(100e6, 1, block.timestamp - 1);
        vm.prank(safe);
        vm.expectRevert();
        burner.buyback(100e6, type(uint256).max, block.timestamp);
    }

    function test_bindOnceAndOnlyToTheTokenUsdgPool() public {
        DammPool other = _dammPool(address(weth), address(usdg), 1_000e18, 3_000_000e6);
        vm.prank(safe);
        timelock.schedule(address(burner), 0, abi.encodeCall(BuybackBurner.bind, (IERC20(address(curveil)), other)), bytes32(0), "w", DELAY);
        vm.warp(block.timestamp + DELAY);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(burner), 0, abi.encodeCall(BuybackBurner.bind, (IERC20(address(curveil)), other)), bytes32(0), "w");

        _bind();
        vm.prank(address(timelock));
        vm.expectRevert(BuybackBurner.AlreadyBound.selector);
        burner.bind(IERC20(address(curveil)), pool);
    }

    function test_burnHeld() public {
        _bind();
        vm.prank(alice);
        curveil.transfer(address(burner), 123e18);
        vm.prank(safe);
        assertEq(burner.burnHeld(), 123e18);
        assertEq(curveil.balanceOf(burner.DEAD()), 123e18);
    }

    // ---------------------------------------------------------------- edges

    function test_treasuryRefusesZeroes() public {
        vm.startPrank(address(timelock));
        vm.expectRevert(ProtocolTreasury.ZeroAddress.selector);
        treasury.release(address(0), safe, 1, "x");
        vm.expectRevert(ProtocolTreasury.ZeroAddress.selector);
        treasury.release(address(usdg), address(0), 1, "x");
        vm.expectRevert(ProtocolTreasury.ZeroAmount.selector);
        treasury.release(address(usdg), safe, 0, "x");
        vm.stopPrank();
    }

    function test_burnerOwnerControls() public {
        vm.expectRevert(BuybackBurner.ZeroAddress.selector);
        new BuybackBurner(IERC20(address(0)), address(timelock), safe);
        vm.expectRevert(BuybackBurner.ZeroAddress.selector);
        new BuybackBurner(IERC20(address(usdg)), address(timelock), address(0));

        vm.startPrank(address(timelock));
        vm.expectRevert(BuybackBurner.ZeroAddress.selector);
        burner.setOperator(address(0));
        burner.setOperator(stranger);
        assertEq(burner.operator(), stranger);
        vm.expectRevert(BuybackBurner.ZeroAddress.selector);
        burner.bind(IERC20(address(0)), pool);
        vm.stopPrank();

        usdg.mint(address(burner), 700e6);
        vm.startPrank(address(timelock));
        vm.expectRevert(BuybackBurner.ZeroAddress.selector);
        burner.returnUsdg(address(0), 1, "x");
        burner.returnUsdg(address(treasury), 700e6, "programme paused");
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(treasury)), 700e6);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        burner.returnUsdg(safe, 1, "x");
    }

    function test_burnerViewsBeforeBind() public {
        assertEq(burner.burnedSupply(), 0);
        vm.expectRevert(BuybackBurner.NotBound.selector);
        burner.impactBps(1e6);
        vm.prank(safe);
        vm.expectRevert(BuybackBurner.NotBound.selector);
        burner.burnHeld();
    }

    function test_buybackEdgeCases() public {
        _bind();
        vm.startPrank(safe);
        vm.expectRevert(BuybackBurner.ZeroAmount.selector);
        burner.buyback(0, 0, block.timestamp);
        vm.expectRevert(BuybackBurner.ZeroAmount.selector);
        burner.burnHeld();
        vm.stopPrank();
    }

    /// The cap holds whichever way the pool orders its tokens.
    function testFuzz_impactCapBothOrders(uint256 amount) public {
        _bind();
        amount = bound(amount, 1e6, 200_000e6);
        uint256 impact = burner.impactBps(amount);
        usdg.mint(address(burner), amount);
        vm.prank(safe);
        if (impact > 100) {
            vm.expectRevert(abi.encodeWithSelector(BuybackBurner.ImpactTooHigh.selector, impact));
            burner.buyback(amount, 0, block.timestamp);
        } else {
            uint256 burned = burner.buyback(amount, 0, block.timestamp);
            assertGt(burned, 0);
        }
    }
}
