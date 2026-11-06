// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title AssetRegistry
/// @notice The list of assets Curveil admits into pools, the vault and perps.
/// @dev Owned by the deployer on testnet and by the timelock on mainnet. Admission is a
///      compatibility statement, not an endorsement. Suspending an asset blocks new
///      deposits in modules that check it; it never blocks exits.
contract AssetRegistry is Ownable2Step {
    enum Status {
        Unknown,
        Admitted,
        Suspended
    }

    struct Asset {
        Status status;
        uint8 decimals;
        uint64 admittedAt;
        string label;
    }

    mapping(address token => Asset) private _assets;
    address[] private _list;

    event AssetAdmitted(address indexed token, uint8 decimals, string label);
    event AssetSuspended(address indexed token);
    event AssetReinstated(address indexed token);

    error ZeroAddress();
    error AlreadyListed(address token);
    error NotListed(address token);
    error NotSuspended(address token);
    error NotAdmitted(address token);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function admit(address token, string calldata label) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_assets[token].status != Status.Unknown) revert AlreadyListed(token);
        uint8 dec = IERC20Metadata(token).decimals();
        _assets[token] = Asset(Status.Admitted, dec, uint64(block.timestamp), label);
        _list.push(token);
        emit AssetAdmitted(token, dec, label);
    }

    function suspend(address token) external onlyOwner {
        if (_assets[token].status != Status.Admitted) revert NotAdmitted(token);
        _assets[token].status = Status.Suspended;
        emit AssetSuspended(token);
    }

    function reinstate(address token) external onlyOwner {
        if (_assets[token].status != Status.Suspended) revert NotSuspended(token);
        _assets[token].status = Status.Admitted;
        emit AssetReinstated(token);
    }

    function isAdmitted(address token) external view returns (bool) {
        return _assets[token].status == Status.Admitted;
    }

    function requireAdmitted(address token) external view {
        if (_assets[token].status != Status.Admitted) revert NotAdmitted(token);
    }

    function asset(address token) external view returns (Asset memory) {
        Asset memory a = _assets[token];
        if (a.status == Status.Unknown) revert NotListed(token);
        return a;
    }

    function assets() external view returns (address[] memory) {
        return _list;
    }
}
