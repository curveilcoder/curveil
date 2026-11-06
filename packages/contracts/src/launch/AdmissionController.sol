// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Guarded} from "../shared/Guarded.sol";
import {AssetRegistry} from "../shared/AssetRegistry.sol";
import {ILaunchFactory} from "./interfaces/ILaunch.sol";

/// @title AdmissionController
/// @notice Owns the AssetRegistry. The owner keeps every admission power it had, and the
///         graduation migrator gains exactly one: admitting a Curveil launch token at the
///         moment it graduates, so its DAMM pool can be created in the same transaction.
/// @dev Launch tokens cannot be admitted any other way. Before graduation no Curveil pool can
///      exist for them, so nobody can pre-create the destination pool at a skewed price and
///      block migration.
contract AdmissionController is Guarded {
    AssetRegistry public immutable registry;
    ILaunchFactory public launchFactory;
    address public migrator;

    event LaunchModulesSet(address launchFactory, address migrator);

    error NotMigrator();
    error NotLaunchToken(address token);
    error LaunchTokenOnlyAtGraduation(address token);

    constructor(address initialOwner, AssetRegistry registry_) Ownable(initialOwner) {
        registry = registry_;
    }

    function setLaunchModules(ILaunchFactory factory, address migrator_) external onlyOwner {
        launchFactory = factory;
        migrator = migrator_;
        emit LaunchModulesSet(address(factory), migrator_);
    }

    function admitLaunchToken(address token) external {
        if (msg.sender != migrator) revert NotMigrator();
        if (!launchFactory.isLaunchToken(token)) revert NotLaunchToken(token);
        registry.admit(token, "launch");
    }

    // ------------------------------------------------------------------ owner pass-through

    function admit(address token, string calldata label) external onlyOwner {
        if (address(launchFactory) != address(0) && launchFactory.isLaunchToken(token)) {
            revert LaunchTokenOnlyAtGraduation(token);
        }
        registry.admit(token, label);
    }

    /// The guardian can suspend an asset at once (for example a token that was exploited);
    /// only the owner can reinstate it.
    function suspend(address token) external {
        _checkStop(true);
        registry.suspend(token);
    }

    function reinstate(address token) external onlyOwner {
        registry.reinstate(token);
    }

    /// Completes a registry ownership handover started by the registry's previous owner.
    function acceptRegistryOwnership() external onlyOwner {
        registry.acceptOwnership();
    }

    /// Starts handing the registry to another owner (two-step).
    function transferRegistryOwnership(address newOwner) external onlyOwner {
        registry.transferOwnership(newOwner);
    }
}
