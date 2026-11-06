// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IReportVerifier} from "./interfaces/IReportVerifier.sol";

/// @title OracleAdapter
/// @notice Every price perps use passes through here. A price arrives as a report from the
///         oracle network, checked by the report verifier, and then by this adapter:
///         - the feed is configured and enabled,
///         - the report is recent (not older than the feed's `maxReportAge`, not in the future),
///         - the price is positive,
///         - when the feed has a reference feed (a Chainlink push feed), the report is within
///           `maxDeviationBps` of it. A stale reference blocks new risk only,
///         - when a sequencer uptime feed is set, new risk and liquidations wait until the
///           sequencer has been up for the grace period. Closing is never held back by it.
///         The newest checked price per feed is stored; anyone may submit a report to refresh it.
contract OracleAdapter is Ownable2Step {
    /// @notice What a price is for. Opening adds risk; reducing (closing, conditional orders)
    ///         takes it away; liquidating removes an unsafe position.
    enum Use {
        Open,
        Reduce,
        Liquidate
    }

    struct Feed {
        bool enabled;
        uint8 referenceDecimals;
        uint16 maxDeviationBps;
        uint32 maxReportAge;
        uint32 referenceHeartbeat;
        address referenceFeed;
    }

    struct Stored {
        uint192 price;
        uint64 timestamp;
    }

    uint256 public constant BPS = 10_000;
    /// @notice How far ahead of the chain's clock a report's timestamp may be.
    uint256 public constant MAX_FUTURE = 5;
    uint256 public constant MAX_REPORT_AGE_LIMIT = 1 hours;

    IReportVerifier public verifier;
    address public sequencerFeed;
    uint32 public sequencerGracePeriod;

    mapping(bytes32 feedId => Feed) private _feeds;
    mapping(bytes32 feedId => Stored) private _latest;

    event VerifierSet(address verifier);
    event FeedSet(
        bytes32 indexed feedId,
        bool enabled,
        uint32 maxReportAge,
        address referenceFeed,
        uint32 referenceHeartbeat,
        uint16 maxDeviationBps
    );
    event SequencerFeedSet(address feed, uint32 gracePeriod);
    event PriceRecorded(bytes32 indexed feedId, uint256 price, uint256 timestamp);

    error ZeroAddress();
    error BadConfig();
    error UnknownFeed(bytes32 feedId);
    error WrongFeed(bytes32 expected, bytes32 actual);
    error BadPrice();
    error ReportTooOld(uint256 timestamp, uint256 maxAge);
    error ReportInFuture(uint256 timestamp);
    error ReferenceStale(bytes32 feedId);
    error PriceDeviates(uint256 price, uint256 reference_);
    error SequencerDown();
    error GracePeriodNotOver();

    constructor(address owner_, IReportVerifier verifier_) Ownable(owner_) {
        _setVerifier(verifier_);
    }

    // ---------------------------------------------------------------- prices

    /// @notice Verifies `report` for `feedId` and `use`, records it if it is the newest, and
    ///         returns the price (USD per unit, 18 decimals) and when it was observed.
    function priceFor(bytes32 feedId, bytes calldata report, Use use) external returns (uint256 price, uint256 timestamp) {
        bytes32 got;
        (got, price, timestamp) = verifier.verifyReport(report);
        if (got != feedId) revert WrongFeed(feedId, got);
        _check(feedId, price, timestamp, use);
        _record(feedId, price, timestamp);
    }

    /// @notice Like priceFor, for filling a request: the report must be the first price for the
    ///         feed observed at or after `notBefore`, and no later than `notAfter` (see
    ///         IReportVerifier.verifyFirstReport). Only one report passes, so the executor cannot
    ///         choose a favourable one.
    function priceForRequest(bytes32 feedId, bytes calldata report, Use use, uint64 notBefore, uint64 notAfter)
        external
        returns (uint256 price, uint256 timestamp)
    {
        bytes32 got;
        (got, price, timestamp) = verifier.verifyFirstReport(report, notBefore, notAfter);
        if (got != feedId) revert WrongFeed(feedId, got);
        _check(feedId, price, timestamp, use);
        _record(feedId, price, timestamp);
    }

    /// @notice Records a report as the newest price for its feed (if it is newer). Anyone may call;
    ///         keepers do so regularly so that vault valuations and the website have a fresh price.
    function submit(bytes calldata report) external returns (bytes32 feedId, uint256 price, uint256 timestamp) {
        (feedId, price, timestamp) = verifier.verifyReport(report);
        _check(feedId, price, timestamp, Use.Reduce);
        _record(feedId, price, timestamp);
    }

    /// @notice The newest recorded price for a feed, and when it was observed (zero if none).
    function latestPrice(bytes32 feedId) external view returns (uint256 price, uint256 timestamp) {
        Stored memory s = _latest[feedId];
        return (s.price, s.timestamp);
    }

    /// @notice The reference feed's answer scaled to 18 decimals, its update time, and whether it
    ///         is within its heartbeat. Zero when the feed has no reference.
    function referencePrice(bytes32 feedId) public view returns (uint256 price, uint256 updatedAt, bool fresh) {
        Feed memory f = _feeds[feedId];
        if (f.referenceFeed == address(0)) return (0, 0, false);
        try IAggregatorV3(f.referenceFeed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 at, uint80) {
            if (answer <= 0) return (0, at, false);
            price = _scale(uint256(answer), f.referenceDecimals);
            updatedAt = at;
            fresh = at <= block.timestamp && block.timestamp - at <= f.referenceHeartbeat;
        } catch {
            return (0, 0, false);
        }
    }

    /// @notice Whether the sequencer is up and past its grace period (always true when no
    ///         sequencer feed is set).
    function sequencerReady() public view returns (bool) {
        address uptime = sequencerFeed;
        if (uptime == address(0)) return true;
        (, int256 status, uint256 startedAt,,) = IAggregatorV3(uptime).latestRoundData();
        return status == 0 && startedAt != 0 && block.timestamp - startedAt > sequencerGracePeriod;
    }

    function feedConfig(bytes32 feedId) external view returns (Feed memory) {
        return _feeds[feedId];
    }

    // ---------------------------------------------------------------- admin

    function setVerifier(IReportVerifier verifier_) external onlyOwner {
        _setVerifier(verifier_);
    }

    /// @param referenceFeed Chainlink feed proxy to compare against, or zero for none.
    function setFeed(
        bytes32 feedId,
        bool enabled,
        uint32 maxReportAge,
        address referenceFeed,
        uint32 referenceHeartbeat,
        uint16 maxDeviationBps
    ) external onlyOwner {
        if (feedId == bytes32(0) || maxReportAge == 0 || maxReportAge > MAX_REPORT_AGE_LIMIT) revert BadConfig();
        uint8 decimals;
        if (referenceFeed != address(0)) {
            if (referenceHeartbeat == 0 || maxDeviationBps == 0 || maxDeviationBps > BPS) revert BadConfig();
            decimals = IAggregatorV3(referenceFeed).decimals();
        }
        _feeds[feedId] = Feed(enabled, decimals, maxDeviationBps, maxReportAge, referenceHeartbeat, referenceFeed);
        emit FeedSet(feedId, enabled, maxReportAge, referenceFeed, referenceHeartbeat, maxDeviationBps);
    }

    /// @param uptimeFeed Chainlink L2 sequencer uptime feed, or zero where none exists.
    function setSequencerFeed(address uptimeFeed, uint32 gracePeriod) external onlyOwner {
        sequencerFeed = uptimeFeed;
        sequencerGracePeriod = gracePeriod;
        emit SequencerFeedSet(uptimeFeed, gracePeriod);
    }

    // ---------------------------------------------------------------- internals

    function _check(bytes32 feedId, uint256 price, uint256 timestamp, Use use) private view {
        Feed memory f = _feeds[feedId];
        if (!f.enabled) revert UnknownFeed(feedId);
        if (price == 0 || price > type(uint192).max) revert BadPrice();
        if (timestamp > block.timestamp + MAX_FUTURE) revert ReportInFuture(timestamp);
        if (timestamp + f.maxReportAge < block.timestamp) revert ReportTooOld(timestamp, f.maxReportAge);
        if (f.referenceFeed != address(0)) {
            (uint256 ref,, bool fresh) = referencePrice(feedId);
            if (fresh) {
                uint256 diff = price > ref ? price - ref : ref - price;
                if (diff * BPS > ref * f.maxDeviationBps) revert PriceDeviates(price, ref);
            } else if (use == Use.Open) {
                revert ReferenceStale(feedId);
            }
        }
        if (use != Use.Reduce && sequencerFeed != address(0)) {
            (, int256 status, uint256 startedAt,,) = IAggregatorV3(sequencerFeed).latestRoundData();
            if (status != 0) revert SequencerDown();
            if (startedAt == 0 || block.timestamp - startedAt <= sequencerGracePeriod) revert GracePeriodNotOver();
        }
    }

    function _record(bytes32 feedId, uint256 price, uint256 timestamp) private {
        if (timestamp > _latest[feedId].timestamp) {
            _latest[feedId] = Stored(uint192(price), uint64(timestamp));
            emit PriceRecorded(feedId, price, timestamp);
        }
    }

    function _setVerifier(IReportVerifier verifier_) private {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        verifier = verifier_;
        emit VerifierSet(address(verifier_));
    }

    function _scale(uint256 answer, uint8 decimals) private pure returns (uint256) {
        if (decimals == 18) return answer;
        return decimals < 18 ? answer * 10 ** (18 - decimals) : answer / 10 ** (decimals - 18);
    }
}
