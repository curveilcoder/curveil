// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Guarded
/// @notice Adds a guardian that can stop new risk at once, while starting it again stays with
///         the owner. On mainnet the owner is the 72-hour timelock and the guardian is the Safe,
///         so a pause takes effect immediately and an unpause is public for 72 hours first.
/// @dev The guardian can only ever switch something off. It never moves funds and never blocks
///      an exit.
abstract contract Guarded is Ownable2Step {
    address public guardian;

    event GuardianSet(address guardian);

    error NotGuardian();

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// Guardian or owner when `stopping`, owner only otherwise.
    function _checkStop(bool stopping) internal view {
        if (msg.sender == owner()) return;
        if (!stopping || msg.sender != guardian || guardian == address(0)) revert NotGuardian();
    }
}
