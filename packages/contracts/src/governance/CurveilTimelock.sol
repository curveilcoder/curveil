// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title CurveilTimelock
/// @notice Owner of every Curveil admin role. Ordinary changes are proposed by the protocol
///         Safe, wait `getMinDelay()`, then execute. On mainnet the delay can never go below
///         72 hours, not even through the timelock itself (whitepaper section 20).
/// @dev The timelock administers itself: there is no separate admin. Scoped emergency pauses
///      do not go through here; each module's guardian (the Safe) can pause new risk at once,
///      and only the owner (this timelock) can unpause.
contract CurveilTimelock is TimelockController {
    uint256 public constant MAINNET_CHAIN_ID = 4663;
    uint256 public constant MAINNET_MIN_DELAY = 72 hours;

    error DelayBelowFloor(uint256 delay, uint256 floor);

    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors)
        TimelockController(minDelay, proposers, executors, address(0))
    {
        _checkFloor(minDelay);
    }

    /// @notice The lowest delay this network allows: 72 hours on mainnet, none elsewhere.
    function delayFloor() public view returns (uint256) {
        return block.chainid == MAINNET_CHAIN_ID ? MAINNET_MIN_DELAY : 0;
    }

    function updateDelay(uint256 newDelay) public override {
        _checkFloor(newDelay);
        super.updateDelay(newDelay);
    }

    function _checkFloor(uint256 delay) private view {
        uint256 floor = delayFloor();
        if (delay < floor) revert DelayBelowFloor(delay, floor);
    }
}
