// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IShieldedAdapter} from "../../../src/vault/interfaces/IShieldedAdapter.sol";

/// @notice Test adapter: returns every fungible input to the pool and reports it as an output.
///         `inflate` makes it over-report what it delivered, like a buggy or hostile adapter.
contract MockShieldedAdapter is IShieldedAdapter {
    address public immutable pool;
    uint256 public inflate;

    constructor(address pool_) {
        pool = pool_;
    }

    function setInflate(uint256 x) external {
        inflate = x;
    }

    function execute(bytes calldata, Input[] calldata inputs) external returns (Output[] memory outs) {
        require(msg.sender == pool, "only pool");
        outs = new Output[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            if (inputs[i].token != address(0)) {
                IERC20(inputs[i].token).transfer(pool, inputs[i].amount);
                outs[i] = Output(inputs[i].token, 0, inputs[i].amount + inflate);
            } else {
                outs[i] = Output(address(0), inputs[i].shareId, inputs[i].amount);
            }
        }
    }
}
