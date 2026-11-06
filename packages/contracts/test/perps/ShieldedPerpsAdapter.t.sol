// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PerpsBase} from "./PerpsBase.sol";
import {PerpEngine} from "../../src/perps/PerpEngine.sol";
import {OrderManager} from "../../src/perps/OrderManager.sol";
import {IShieldedAdapter} from "../../src/vault/interfaces/IShieldedAdapter.sol";
import {ShieldedPerpsAdapter} from "../../src/vault/adapters/ShieldedPerpsAdapter.sol";

/// @notice Adapter rules with the pool's role played directly (the pool's proofs and settlement
///         are covered by ShieldedExecute.t.sol; this checks what the adapter does with them).
contract ShieldedPerpsAdapterTest is PerpsBase {
    address pool = makeAddr("pool");
    ShieldedPerpsAdapter adapter;
    uint256 constant CLAIM = 0xC1A1;
    uint8 constant OPEN = 1;
    uint8 constant CLOSE = 2;
    uint8 constant ADD = 3;
    uint8 constant PLACE = 4;
    uint8 constant CANCEL = 5;
    uint8 constant COLLECT = 6;

    function setUp() public override {
        super.setUp();
        adapter = new ShieldedPerpsAdapter(pool, engine, orders);
        assertEq(adapter.OP_OPEN(), OPEN);
        assertEq(adapter.OP_COLLECT(), COLLECT);
        _fund(pool, 50_000 * USD);
    }

    function _usdg(uint256 amount) internal view returns (IShieldedAdapter.Input memory) {
        return IShieldedAdapter.Input(address(usdg), 0, amount);
    }

    function _claim(uint256 claimId) internal pure returns (IShieldedAdapter.Input memory) {
        return IShieldedAdapter.Input(address(0), claimId, 1);
    }

    /// @dev The pool sends fungible inputs before calling the adapter.
    function _exec(uint8 op, bytes memory body, IShieldedAdapter.Input[] memory inputs)
        internal
        returns (IShieldedAdapter.Output[] memory)
    {
        vm.startPrank(pool);
        for (uint256 i = 0; i < inputs.length; i++) {
            if (inputs[i].token != address(0)) usdg.transfer(address(adapter), inputs[i].amount);
        }
        IShieldedAdapter.Output[] memory outs = adapter.execute(abi.encode(op, body), inputs);
        vm.stopPrank();
        return outs;
    }

    function _one(IShieldedAdapter.Input memory a) internal pure returns (IShieldedAdapter.Input[] memory x) {
        x = new IShieldedAdapter.Input[](1);
        x[0] = a;
    }

    function _two(IShieldedAdapter.Input memory a, IShieldedAdapter.Input memory b)
        internal
        pure
        returns (IShieldedAdapter.Input[] memory x)
    {
        x = new IShieldedAdapter.Input[](2);
        x[0] = a;
        x[1] = b;
    }

    function _openClaim() internal returns (uint256 positionId) {
        ShieldedPerpsAdapter.Open memory o = ShieldedPerpsAdapter.Open(
            CLAIM, M_ETH, true, uint128(10_000 * USD), uint128(2_100 * USD), type(uint256).max, EXEC_FEE
        );
        IShieldedAdapter.Output[] memory outs = _exec(OPEN, abi.encode(o), _one(_usdg(2_100 * USD + EXEC_FEE)));
        assertEq(outs.length, 1);
        assertEq(outs[0].token, address(0));
        assertEq(outs[0].shareId, CLAIM);
        assertEq(outs[0].amount, 1);
        positionId = adapter.claim(CLAIM).positionId;
        assertEq(engine.position(positionId).owner, address(adapter));
        bytes memory r = _fresh(ETH, PRICE);
        vm.prank(keeper);
        engine.executeRequest(engine.requestCount(), r);
    }

    function test_OpenCloseCollect() public {
        uint256 pid = _openClaim();
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Open));

        ShieldedPerpsAdapter.Close memory c = ShieldedPerpsAdapter.Close(CLAIM, uint128(10_000 * USD), 0, EXEC_FEE);
        IShieldedAdapter.Output[] memory outs = _exec(CLOSE, abi.encode(c), _one(_claim(CLAIM)));
        assertEq(outs.length, 1, "claim re-issued");
        bytes memory r = _fresh(ETH, 2_200e18);
        vm.prank(keeper);
        engine.executeRequest(engine.requestCount(), r);
        uint256 owed = adapter.collectable(CLAIM);
        assertApproxEqAbs(owed, 3_083_800_000, 1_000);

        // the claim must be dropped once the position is closed
        ShieldedPerpsAdapter.Collect memory keep = ShieldedPerpsAdapter.Collect(CLAIM, true);
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPerpsAdapter.KeepMismatch.selector, false));
        adapter.execute(abi.encode(COLLECT, abi.encode(keep)), _one(_claim(CLAIM)));

        uint256 poolBefore = usdg.balanceOf(pool);
        outs = _exec(COLLECT, abi.encode(ShieldedPerpsAdapter.Collect(CLAIM, false)), _one(_claim(CLAIM)));
        assertEq(outs.length, 1);
        assertEq(outs[0].token, address(usdg));
        assertEq(outs[0].amount, owed);
        assertEq(usdg.balanceOf(pool) - poolBefore, owed);
        assertEq(adapter.collectable(CLAIM), 0);
        assertEq(usdg.balanceOf(address(adapter)), 0);
    }

    function test_CancelledOpenRefundsToClaim() public {
        ShieldedPerpsAdapter.Open memory o = ShieldedPerpsAdapter.Open(
            CLAIM, M_ETH, true, uint128(10_000 * USD), uint128(2_100 * USD), 1_000e18, EXEC_FEE
        );
        _exec(OPEN, abi.encode(o), _one(_usdg(2_100 * USD + EXEC_FEE)));
        bytes memory r = _fresh(ETH, PRICE);
        engine.executeRequest(engine.requestCount(), r); // price above the limit: cancelled
        assertEq(adapter.collectable(CLAIM), 2_100 * USD);
        IShieldedAdapter.Output[] memory outs =
            _exec(COLLECT, abi.encode(ShieldedPerpsAdapter.Collect(CLAIM, false)), _one(_claim(CLAIM)));
        assertEq(outs[0].amount, 2_100 * USD);
    }

    function test_LiquidationLeavesNothingToRedeem() public {
        uint256 pid = _openClaim();
        bytes memory r = _fresh(ETH, 1_600e18);
        engine.liquidate(pid, r);
        assertEq(adapter.collectable(CLAIM), 0);
        IShieldedAdapter.Output[] memory outs =
            _exec(COLLECT, abi.encode(ShieldedPerpsAdapter.Collect(CLAIM, false)), _one(_claim(CLAIM)));
        assertEq(outs.length, 1);
        assertEq(outs[0].amount, 0);
    }

    function test_FeeLegComesBackAndCollateralAdds() public {
        uint256 pid = _openClaim();
        ShieldedPerpsAdapter.Close memory c = ShieldedPerpsAdapter.Close(CLAIM, uint128(1_000 * USD), 0, EXEC_FEE);
        IShieldedAdapter.Output[] memory outs = _exec(CLOSE, abi.encode(c), _two(_claim(CLAIM), _usdg(1)));
        assertEq(outs.length, 2);
        assertEq(outs[1].token, address(usdg));
        assertEq(outs[1].amount, 1);

        outs = _exec(ADD, abi.encode(CLAIM), _two(_claim(CLAIM), _usdg(500 * USD)));
        assertEq(outs.length, 1);
        assertEq(engine.position(pid).collateral, 2_592 * USD);
    }

    function test_OrdersThroughTheClaim() public {
        uint256 pid = _openClaim();
        ShieldedPerpsAdapter.PlaceOrder memory o =
            ShieldedPerpsAdapter.PlaceOrder(CLAIM, OrderManager.Kind.TakeProfit, 2_200e18, 0, 0, EXEC_FEE, 0);
        _exec(PLACE, abi.encode(o), _one(_claim(CLAIM)));
        uint256 oid = orders.orderCount();
        assertEq(orders.order(oid).owner, address(adapter));

        // another claim cannot cancel this claim's order
        ShieldedPerpsAdapter.Open memory other =
            ShieldedPerpsAdapter.Open(7, M_ETH, false, uint128(1_000 * USD), uint128(300 * USD), 0, EXEC_FEE);
        _exec(OPEN, abi.encode(other), _one(_usdg(300 * USD + EXEC_FEE)));
        vm.prank(pool);
        vm.expectRevert(ShieldedPerpsAdapter.NotThisPosition.selector);
        adapter.execute(abi.encode(CANCEL, abi.encode(ShieldedPerpsAdapter.CancelOrder(7, oid))), _one(_claim(7)));

        bytes memory r = _fresh(ETH, 2_250e18);
        orders.execute(oid, r);
        assertEq(uint8(engine.position(pid).status), uint8(PerpEngine.Status.Closed));
        assertGt(adapter.collectable(CLAIM), 3_000 * USD);
    }

    function test_InputRules() public {
        _openClaim();
        ShieldedPerpsAdapter.Open memory o = ShieldedPerpsAdapter.Open(
            CLAIM, M_ETH, true, uint128(1_000 * USD), uint128(300 * USD), type(uint256).max, EXEC_FEE
        );
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPerpsAdapter.ClaimExists.selector, CLAIM));
        adapter.execute(abi.encode(OPEN, abi.encode(o)), _one(_usdg(300 * USD + EXEC_FEE)));

        o.claimId = 99;
        vm.prank(pool);
        vm.expectRevert(ShieldedPerpsAdapter.BadInputs.selector);
        adapter.execute(abi.encode(OPEN, abi.encode(o)), _one(_usdg(300 * USD)));

        ShieldedPerpsAdapter.Close memory c = ShieldedPerpsAdapter.Close(98, 1, 0, EXEC_FEE);
        vm.prank(pool);
        vm.expectRevert(abi.encodeWithSelector(ShieldedPerpsAdapter.UnknownClaim.selector, 98));
        adapter.execute(abi.encode(CLOSE, abi.encode(c)), _one(_claim(98)));

        c.claimId = CLAIM;
        vm.prank(pool);
        vm.expectRevert(ShieldedPerpsAdapter.BadInputs.selector);
        adapter.execute(abi.encode(CLOSE, abi.encode(c)), _one(IShieldedAdapter.Input(address(0), CLAIM, 2)));

        vm.expectRevert(ShieldedPerpsAdapter.OnlyPool.selector);
        adapter.execute(abi.encode(CLOSE, abi.encode(c)), _one(_claim(CLAIM)));
    }
}
