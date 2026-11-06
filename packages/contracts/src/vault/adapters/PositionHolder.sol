// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Holds one shielded liquidity position's pool shares, so the DAMM pool or DLMM pair
///         accounts that position's fees exactly as for any other LP. Deployed as a minimal
///         clone per position and driven only by the adapter that created it.
contract PositionHolder {
    address public adapter;

    error OnlyAdapter();
    error AlreadyInitialised();

    function initialize() external {
        if (adapter != address(0)) revert AlreadyInitialised();
        adapter = msg.sender;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != adapter) revert OnlyAdapter();
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
