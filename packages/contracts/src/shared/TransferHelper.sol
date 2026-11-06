// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TransferHelper
/// @notice Pulls tokens and checks the amount actually received.
/// @dev Curveil excludes fee-on-transfer and rebasing assets (whitepaper 5.6). Every
///      protocol entry point pulls through `pullExact`, so such tokens revert instead of
///      silently breaking accounting.
library TransferHelper {
    using SafeERC20 for IERC20;

    error ReceivedAmountMismatch(address token, uint256 expected, uint256 received);

    function pullExact(IERC20 token, address from, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert ReceivedAmountMismatch(address(token), amount, received);
    }

    function push(IERC20 token, address to, uint256 amount) internal {
        token.safeTransfer(to, amount);
    }
}
