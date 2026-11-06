// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ProtocolTreasury
/// @notice One bucket of protocol revenue. Curveil deploys one treasury per fee source
///         (markets, launch, vault, perps, factory), so each source's revenue sits at its own
///         address and is reported separately. Only protocol shares are configured to land here:
///         user principal, LP fees and creator fees go elsewhere by construction.
/// @dev Owned by the CurveilTimelock, so every release waits the timelock delay and is public
///      before it executes. Tokens arrive by plain transfer; nothing here can pull from anyone.
contract ProtocolTreasury is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice What this bucket collects, e.g. "markets".
    bytes32 public immutable source;

    event Released(address indexed token, address indexed to, uint256 amount, string memo);

    error ZeroAddress();
    error ZeroAmount();

    constructor(bytes32 source_, address owner_) Ownable(owner_) {
        source = source_;
    }

    /// @notice Sends `amount` of `token` to `to`, with a memo that names the allocation
    ///         (for example "2026-11 buyback tranche" or "audit invoice 14").
    function release(address token, address to, uint256 amount, string calldata memo) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit Released(token, to, amount, memo);
    }

    function balanceOf(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
