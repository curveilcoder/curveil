// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LaunchBase} from "./LaunchBase.sol";
import {BondingCurve} from "../../src/launch/BondingCurve.sol";
import {CurveilLaunchToken} from "../../src/launch/CurveilLaunchToken.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

contract CurveHandler is Test {
    BondingCurve public curve;
    CurveilLaunchToken public token;
    TestToken public usdg;
    address[3] internal actors;
    uint256 public paidIn;
    uint256 public paidOut;

    constructor(BondingCurve curve_, CurveilLaunchToken token_, TestToken usdg_, address[3] memory actors_) {
        curve = curve_;
        token = token_;
        usdg = usdg_;
        actors = actors_;
    }

    function buy(uint256 seed, uint256 amount) external {
        if (curve.state() == BondingCurve.State.GraduationReady || curve.state() == BondingCurve.State.Graduated) {
            return;
        }
        address who = actors[seed % 3];
        amount = bound(amount, 1, 8_000e6);
        (uint256 q,,) = curve.quoteBuy(amount);
        if (q == 0) return;
        vm.prank(who);
        (, uint256 used) = curve.buy(amount, 0, who, block.timestamp);
        paidIn += used;
    }

    function sell(uint256 seed, uint256 amount) external {
        if (curve.state() != BondingCurve.State.Trading) return;
        address who = actors[seed % 3];
        uint256 bal = token.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        (uint256 q,) = curve.quoteSell(amount);
        if (q == 0) return;
        vm.prank(who);
        paidOut += curve.sell(amount, 0, who, block.timestamp);
    }

    function graduate() external {
        if (curve.state() != BondingCurve.State.GraduationReady) return;
        curve.graduate();
    }

    function claim(uint8 b) external {
        curve.claimFees(BondingCurve.Bucket(b % 3));
    }
}

contract LaunchInvariantTest is LaunchBase {
    CurveHandler internal handler;
    BondingCurve internal curve;
    CurveilLaunchToken internal token;

    function setUp() public override {
        super.setUp();
        (token, curve) = _create(0);
        handler = new CurveHandler(curve, token, usdg, [alice, bob, carol]);
        targetContract(address(handler));
    }

    /// The curve always holds exactly its net reserves plus unclaimed fees.
    function invariant_QuoteBackedByReservesAndFees() public view {
        uint256 claimed = usdg.balanceOf(feeTo) + usdg.balanceOf(creatorFees);
        uint256 fees = curve.creatorFees() + curve.protocolFees() + curve.operatorFees();
        if (curve.state() == BondingCurve.State.Graduated) {
            assertEq(usdg.balanceOf(address(curve)), fees);
            assertEq(handler.paidIn() - handler.paidOut(), fees + claimed + curve.reserve());
        } else {
            assertEq(usdg.balanceOf(address(curve)), curve.reserve() + fees);
            assertEq(handler.paidIn() - handler.paidOut(), usdg.balanceOf(address(curve)) + claimed);
        }
    }

    /// Every token is either in the curve or held by a buyer.
    function invariant_TokensConserved() public view {
        if (curve.state() == BondingCurve.State.Graduated) {
            assertEq(token.balanceOf(address(curve)), 0);
            assertEq(token.balanceOf(curve.pool()), token.totalSupply() - curve.circulating());
        } else {
            assertEq(token.balanceOf(address(curve)), token.totalSupply() - curve.circulating());
        }
        assertLe(curve.circulating(), CURVE);
    }

    /// The pool never sells below K and reserves never pass the threshold.
    function invariant_CurveSolvent() public view {
        (uint256 vb, uint256 vq) = curve.virtualReserves();
        assertGe(vb * vq, curve.k());
        assertLe(curve.reserve(), THRESHOLD);
        if (curve.reserve() == THRESHOLD) assertGe(uint8(curve.state()), uint8(BondingCurve.State.GraduationReady));
    }
}
