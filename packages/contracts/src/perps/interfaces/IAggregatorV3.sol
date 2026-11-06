// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Chainlink's price feed interface (AggregatorV3Interface), read through a feed proxy.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
