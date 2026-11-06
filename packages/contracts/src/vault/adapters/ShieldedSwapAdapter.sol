// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CurveilRouter} from "../../markets/CurveilRouter.sol";
import {IShieldedAdapter} from "../interfaces/IShieldedAdapter.sol";

/// @notice Shielded swaps (whitepaper section 8). The pool sends the spent input to this adapter,
///         which swaps it exact-in through the Curveil router and sends the output straight
///         back to the pool, where it becomes the user's note. The route and minimum output are
///         in `params`, which every proof binds.
/// @dev params = abi.encode(CurveilRouter.Hop[] hops, uint256 minOut). Holds no funds between calls.
contract ShieldedSwapAdapter is IShieldedAdapter {
    using SafeERC20 for IERC20;

    address public immutable pool;
    CurveilRouter public immutable router;

    error OnlyPool();
    error BadInputs();

    constructor(address pool_, CurveilRouter router_) {
        pool = pool_;
        router = router_;
    }

    function execute(bytes calldata params, Input[] calldata inputs) external returns (Output[] memory outputs) {
        if (msg.sender != pool) revert OnlyPool();
        (CurveilRouter.Hop[] memory hops, uint256 minOut) = abi.decode(params, (CurveilRouter.Hop[], uint256));
        if (inputs.length != 1 || hops.length == 0 || inputs[0].token == address(0) || inputs[0].token != hops[0].tokenIn) {
            revert BadInputs();
        }
        IERC20 tokenIn = IERC20(inputs[0].token);
        tokenIn.forceApprove(address(router), inputs[0].amount);
        uint256 amountOut = router.swapExactIn(hops, inputs[0].amount, minOut, pool, block.timestamp);
        outputs = new Output[](1);
        outputs[0] = Output(hops[hops.length - 1].tokenOut, 0, amountOut);
    }
}
