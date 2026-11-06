// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice A market adapter the shielded pool calls inside `execute`. Before the call the pool has
///         already verified every proof, spent the input notes and sent fungible inputs to the
///         adapter. The adapter performs the market action and, before returning, sends every
///         fungible output to the pool. The pool turns each returned output into a note or a
///         public payout, and checks that its token balances still cover what it owes.
/// @dev Adapters are trusted with what users send them, and with the share positions they
///      issue. A share output's resource is derived by the pool from (adapter, shareId), so an
///      adapter can only create and consume claims in its own namespace.
interface IShieldedAdapter {
    /// @param token   Fungible input token, or address(0) for a share input.
    /// @param shareId Share being consumed when `token` is zero.
    struct Input {
        address token;
        uint256 shareId;
        uint256 amount;
    }

    /// @param token   Fungible output token (already sent to the pool), or address(0) for a share.
    /// @param shareId Share the output represents when `token` is zero.
    struct Output {
        address token;
        uint256 shareId;
        uint256 amount;
    }

    function execute(bytes calldata params, Input[] calldata inputs) external returns (Output[] memory outputs);
}
