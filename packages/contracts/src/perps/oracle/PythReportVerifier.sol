// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IReportVerifier} from "../interfaces/IReportVerifier.sol";
import {IPyth, PythStructs} from "../interfaces/IPyth.sol";

/// @title PythReportVerifier
/// @notice Reads prices from Pyth's on-chain contract (pull model). A report is a Pyth price
///         update from Hermes, wrapped with Curveil's feed id:
///         report = abi.encode(bytes32 feedId, bytes[] updateData)
///         where feedId = keccak256("ETH/USD") or keccak256("BTC/USD"), and updateData is what
///         Hermes returns for the feed's Pyth price id.
///
///         - verifyReport accepts any valid update. The OracleAdapter then checks its age.
///         - verifyFirstReport accepts only the first update at or after a time, using Pyth's
///           parsePriceFeedUpdatesUnique. Request fills use it, so the executor has no choice
///           of price.
///         A price whose confidence interval is wider than the feed's `maxConfBps` is refused.
///
///         Pyth may charge a fee in ETH per update (zero on Robinhood Chain when this was
///         written). The verifier pays it from its own balance, up to `maxFee` per call, so that
///         nobody else in the call chain needs to send ETH. Only the OracleAdapter may call, but
///         the adapter's `submit` is open to anyone: keep the balance small and `maxFee` tight.
contract PythReportVerifier is IReportVerifier, Ownable2Step {
    struct Feed {
        bytes32 pythId;
        uint16 maxConfBps;
    }

    uint256 public constant BPS = 10_000;

    IPyth public immutable pyth;
    /// @notice The contract allowed to call verifyReport and verifyFirstReport (the OracleAdapter).
    address public caller;
    /// @notice The most this contract pays Pyth for one report, in wei.
    uint256 public maxFee;

    mapping(bytes32 feedId => Feed) private _feeds;

    event CallerSet(address caller);
    event MaxFeeSet(uint256 maxFee);
    event FeedSet(bytes32 indexed feedId, bytes32 pythId, uint16 maxConfBps);
    event Withdrawn(address to, uint256 amount);

    error ZeroAddress();
    error NotCaller(address sender);
    error UnknownFeed(bytes32 feedId);
    error BadConfig();
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    error FeeUnfunded(uint256 fee, uint256 balance);
    error BadPythPrice(int64 price, int32 expo);
    error ConfidenceTooWide(uint256 conf, uint256 price, uint16 maxConfBps);
    error WithdrawFailed();

    constructor(address owner_, IPyth pyth_) Ownable(owner_) {
        if (address(pyth_) == address(0)) revert ZeroAddress();
        pyth = pyth_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------- reports

    function verifyReport(bytes calldata report) external returns (bytes32 feedId, uint256 price, uint256 timestamp) {
        return _verify(report, 0, type(uint64).max, false);
    }

    function verifyFirstReport(bytes calldata report, uint64 notBefore, uint64 notAfter)
        external
        returns (bytes32 feedId, uint256 price, uint256 timestamp)
    {
        return _verify(report, notBefore, notAfter, true);
    }

    function feed(bytes32 feedId) external view returns (Feed memory) {
        return _feeds[feedId];
    }

    // ---------------------------------------------------------------- admin

    function setCaller(address caller_) external onlyOwner {
        if (caller_ == address(0)) revert ZeroAddress();
        caller = caller_;
        emit CallerSet(caller_);
    }

    function setMaxFee(uint256 maxFee_) external onlyOwner {
        maxFee = maxFee_;
        emit MaxFeeSet(maxFee_);
    }

    /// @param pythId     Pyth's price id for the feed (zero disables it).
    /// @param maxConfBps Widest confidence interval accepted, in basis points of the price.
    function setFeed(bytes32 feedId, bytes32 pythId, uint16 maxConfBps) external onlyOwner {
        if (feedId == bytes32(0) || (pythId != bytes32(0) && (maxConfBps == 0 || maxConfBps > BPS))) {
            revert BadConfig();
        }
        _feeds[feedId] = Feed(pythId, maxConfBps);
        emit FeedSet(feedId, pythId, maxConfBps);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------- internals

    function _verify(bytes calldata report, uint64 notBefore, uint64 notAfter, bool first)
        private
        returns (bytes32 feedId, uint256 price, uint256 timestamp)
    {
        if (msg.sender != caller) revert NotCaller(msg.sender);
        bytes[] memory updateData;
        (feedId, updateData) = abi.decode(report, (bytes32, bytes[]));
        Feed memory f = _feeds[feedId];
        if (f.pythId == bytes32(0)) revert UnknownFeed(feedId);

        uint256 fee = pyth.getUpdateFee(updateData);
        if (fee > maxFee) revert FeeTooHigh(fee, maxFee);
        if (fee > address(this).balance) revert FeeUnfunded(fee, address(this).balance);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = f.pythId;
        PythStructs.PriceFeed[] memory feeds = first
            ? pyth.parsePriceFeedUpdatesUnique{value: fee}(updateData, ids, notBefore, notAfter)
            : pyth.parsePriceFeedUpdates{value: fee}(updateData, ids, notBefore, notAfter);

        PythStructs.Price memory p = feeds[0].price;
        if (p.price < 0 || p.expo > 0 || p.expo < -36) revert BadPythPrice(p.price, p.expo);
        price = _toWad(uint256(int256(p.price)), p.expo);
        uint256 conf = _toWad(p.conf, p.expo);
        if (conf * BPS > price * f.maxConfBps) revert ConfidenceTooWide(conf, price, f.maxConfBps);
        timestamp = p.publishTime;
    }

    /// @dev Pyth prices are `price × 10^expo`; returns the value with 18 decimals.
    function _toWad(uint256 v, int32 expo) private pure returns (uint256) {
        int256 shift = 18 + int256(expo);
        return shift >= 0 ? v * 10 ** uint256(shift) : v / 10 ** uint256(-shift);
    }
}
