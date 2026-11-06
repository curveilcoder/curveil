// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice The parts of Pyth's on-chain price contract that Curveil uses. Matches
///         IPyth and PythStructs in the Pyth Solidity SDK (pyth-sdk-solidity) for these functions.
library PythStructs {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }
}

interface IPyth {
    /// @notice The fee, in wei, to verify `updateData`.
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    /// @notice Verifies `updateData` and returns the price of each id with a publish time in
    ///         [minPublishTime, maxPublishTime]. Does not store anything.
    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory priceFeeds);

    /// @notice Like parsePriceFeedUpdates, but only accepts, for each id, the first update at or
    ///         after minPublishTime: its publish time is in the range and the previous update's
    ///         publish time is before minPublishTime. Exactly one update can meet that.
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory priceFeeds);
}
