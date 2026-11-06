// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IPyth, PythStructs} from "../../src/perps/interfaces/IPyth.sol";

/// @notice A stand-in for Pyth's contract with the same parse rules. An update is
///         abi.encode(PriceFeed feed, uint64 prevPublishTime) instead of a signed Wormhole message.
contract MockPyth is IPyth {
    error InsufficientFee();
    error PriceFeedNotFoundWithinRange();

    uint256 public feePerUpdate;

    function setFee(uint256 fee) external {
        feePerUpdate = fee;
    }

    function update(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint64 prevPublishTime)
        external
        pure
        returns (bytes[] memory data)
    {
        PythStructs.Price memory p = PythStructs.Price(price, conf, expo, publishTime);
        data = new bytes[](1);
        data[0] = abi.encode(PythStructs.PriceFeed(id, p, p), prevPublishTime);
    }

    function getUpdateFee(bytes[] calldata updateData) public view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function parsePriceFeedUpdates(bytes[] calldata data, bytes32[] calldata ids, uint64 minTime, uint64 maxTime)
        external
        payable
        returns (PythStructs.PriceFeed[] memory)
    {
        return _parse(data, ids, minTime, maxTime, false);
    }

    function parsePriceFeedUpdatesUnique(bytes[] calldata data, bytes32[] calldata ids, uint64 minTime, uint64 maxTime)
        external
        payable
        returns (PythStructs.PriceFeed[] memory)
    {
        return _parse(data, ids, minTime, maxTime, true);
    }

    function _parse(bytes[] calldata data, bytes32[] calldata ids, uint64 minTime, uint64 maxTime, bool unique)
        private
        returns (PythStructs.PriceFeed[] memory feeds)
    {
        if (msg.value < getUpdateFee(data)) revert InsufficientFee();
        feeds = new PythStructs.PriceFeed[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            bool found;
            for (uint256 j = 0; j < data.length && !found; j++) {
                (PythStructs.PriceFeed memory f, uint64 prev) = abi.decode(data[j], (PythStructs.PriceFeed, uint64));
                uint256 t = f.price.publishTime;
                if (f.id != ids[i] || t < minTime || t > maxTime) continue;
                if (unique && prev >= minTime) continue;
                feeds[i] = f;
                found = true;
            }
            if (!found) revert PriceFeedNotFoundWithinRange();
        }
    }
}
