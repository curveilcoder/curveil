// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Common surface shared by DAMM pools and DLMM pairs so the router can route across both.
/// @dev Push model: the caller transfers `tokenIn` to the pool first, then calls `swap`.
///      The pool measures the input as its balance minus everything it has accounted for.
interface ICurveilPool {
    function swap(address tokenIn, address to) external returns (uint256 amountOut);

    /// @return amountOut Output for `amountIn` against current state.
    /// @return fee Total fee charged on the input, in `tokenIn` units.
    function quote(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut, uint256 fee);

    function tokens() external view returns (address, address);
}

interface IPoolFactory {
    function isPool(address pool) external view returns (bool);
    function feeTo() external view returns (address);
}
