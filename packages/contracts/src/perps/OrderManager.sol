// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OracleAdapter} from "./OracleAdapter.sol";
import {PerpEngine} from "./PerpEngine.sol";

/// @title OrderManager
/// @notice Conditional orders on open positions: take-profit and stop-loss. A position's owner
///         places them; anyone (normally a keeper) executes one with an oracle report that is
///         newer than the order and than the newest recorded price, at which the trigger is
///         met. The order then closes its size (or the whole position) at the reported price
///         through the engine, and the execution fee comes out of the proceeds.
///
///         Orders follow their position: once it is closed or liquidated, its orders can no
///         longer fill and anyone may clear them (`expire`), as they may once an order expires.
contract OrderManager is ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;

    enum Kind {
        None,
        TakeProfit,
        StopLoss
    }

    enum Status {
        None,
        Active,
        Filled,
        Cancelled
    }

    enum CancelReason {
        None,
        Owner,
        Expired,
        PositionGone
    }

    /// @param size Size to close; zero closes the whole position.
    /// @param acceptablePrice Worst fill price accepted: the least a long close receives (0 for
    ///        any), the most a short close pays (type(uint256).max for any).
    struct Order {
        uint256 positionId;
        address owner;
        Kind kind;
        Status status;
        uint64 createdAt;
        uint64 expiresAt;
        uint128 size;
        uint128 executionFee;
        uint256 triggerPrice;
        uint256 acceptablePrice;
    }

    uint256 public constant MAX_ORDERS_PER_POSITION = 4;

    PerpEngine public immutable engine;
    OracleAdapter public immutable oracle;

    uint256 public orderCount;
    mapping(uint256 orderId => Order) internal _orders;
    mapping(uint256 positionId => uint256) public activeOrders;
    EnumerableSet.UintSet internal _active;

    event OrderPlaced(
        uint256 indexed orderId,
        uint256 indexed positionId,
        address indexed owner,
        Kind kind,
        uint256 triggerPrice,
        uint256 size,
        uint256 acceptablePrice,
        uint256 executionFee,
        uint64 expiresAt
    );
    event OrderExecuted(uint256 indexed orderId, uint256 indexed positionId, uint256 price, uint256 sizeClosed, address executor);
    event OrderCancelled(uint256 indexed orderId, uint256 indexed positionId, CancelReason reason);

    error NotOwner();
    error NotOpen();
    error BadOrder();
    error FeeTooLow(uint256 minimum);
    error TooManyOrders();
    error NotActive();
    error Expired();
    error NotTriggered(uint256 price, uint256 trigger);
    error PriceNotAcceptable(uint256 price, uint256 acceptable);
    error PriceNotNewer(uint256 timestamp, uint256 required);
    error StillValid();

    constructor(PerpEngine engine_) {
        engine = engine_;
        oracle = engine_.oracle();
    }

    function place(
        uint256 positionId,
        Kind kind,
        uint256 triggerPrice,
        uint128 size,
        uint256 acceptablePrice,
        uint128 executionFee,
        uint64 expiresAt
    ) external nonReentrant returns (uint256 orderId) {
        PerpEngine.Position memory p = engine.position(positionId);
        if (p.owner != msg.sender) revert NotOwner();
        if (p.status != PerpEngine.Status.Open) revert NotOpen();
        if (kind == Kind.None || triggerPrice == 0 || (expiresAt != 0 && expiresAt <= block.timestamp)) revert BadOrder();
        uint128 minFee = engine.minExecutionFee();
        if (executionFee < minFee) revert FeeTooLow(minFee);
        if (activeOrders[positionId] >= MAX_ORDERS_PER_POSITION) revert TooManyOrders();
        orderId = ++orderCount;
        _orders[orderId] = Order(
            positionId,
            msg.sender,
            kind,
            Status.Active,
            uint64(block.timestamp),
            expiresAt,
            size,
            executionFee,
            triggerPrice,
            acceptablePrice
        );
        activeOrders[positionId]++;
        _active.add(orderId);
        emit OrderPlaced(orderId, positionId, msg.sender, kind, triggerPrice, size, acceptablePrice, executionFee, expiresAt);
    }

    function cancel(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.owner != msg.sender) revert NotOwner();
        if (o.status != Status.Active) revert NotActive();
        _close(orderId, o, Status.Cancelled);
        emit OrderCancelled(orderId, o.positionId, CancelReason.Owner);
    }

    /// @notice Fills a triggered order at the price in `report`.
    function execute(uint256 orderId, bytes calldata report) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != Status.Active) revert NotActive();
        if (o.expiresAt != 0 && block.timestamp > o.expiresAt) revert Expired();
        PerpEngine.Position memory p = engine.position(o.positionId);
        if (p.status != PerpEngine.Status.Open || p.owner != o.owner) revert NotOpen();
        bytes32 feedId = engine.marketConfig(p.market).feedId;
        (, uint256 newest) = oracle.latestPrice(feedId);
        (uint256 price, uint256 ts) = oracle.priceFor(feedId, report, OracleAdapter.Use.Reduce);
        if (ts <= o.createdAt) revert PriceNotNewer(ts, uint256(o.createdAt) + 1);
        if (ts < newest) revert PriceNotNewer(ts, newest);
        if (!triggered(o.kind, p.isLong, price, o.triggerPrice)) revert NotTriggered(price, o.triggerPrice);
        if (p.isLong ? price < o.acceptablePrice : price > o.acceptablePrice) {
            revert PriceNotAcceptable(price, o.acceptablePrice);
        }
        _close(orderId, o, Status.Filled);
        uint256 closed = engine.closeFromOrder(o.positionId, o.size, price, msg.sender, o.executionFee);
        emit OrderExecuted(orderId, o.positionId, price, closed, msg.sender);
    }

    /// @notice Clears an order that can no longer fill: expired, or its position is gone.
    function expire(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != Status.Active) revert NotActive();
        PerpEngine.Position memory p = engine.position(o.positionId);
        CancelReason reason;
        if (p.status != PerpEngine.Status.Open || p.owner != o.owner) reason = CancelReason.PositionGone;
        else if (o.expiresAt != 0 && block.timestamp > o.expiresAt) reason = CancelReason.Expired;
        else revert StillValid();
        _close(orderId, o, Status.Cancelled);
        emit OrderCancelled(orderId, o.positionId, reason);
    }

    // ---------------------------------------------------------------- views

    function order(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function activeOrderIds(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n = _active.length();
        if (offset >= n) return ids;
        uint256 end = Math.min(n, offset + limit);
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _active.at(i);
        }
    }

    function activeCount() external view returns (uint256) {
        return _active.length();
    }

    /// @notice Take-profit fires when the price moves in the position's favour past the trigger,
    ///         stop-loss when it moves against it.
    function triggered(Kind kind, bool isLong, uint256 price, uint256 trigger) public pure returns (bool) {
        bool up = price >= trigger;
        bool down = price <= trigger;
        if (kind == Kind.TakeProfit) return isLong ? up : down;
        if (kind == Kind.StopLoss) return isLong ? down : up;
        return false;
    }

    function _close(uint256 orderId, Order storage o, Status status) private {
        o.status = status;
        activeOrders[o.positionId]--;
        _active.remove(orderId);
    }
}
