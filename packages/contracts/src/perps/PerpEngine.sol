// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TransferHelper} from "../shared/TransferHelper.sol";
import {OracleAdapter} from "./OracleAdapter.sol";
import {PerpLiquidityVault} from "./PerpLiquidityVault.sol";

/// @title PerpEngine
/// @notice Isolated-margin perpetual positions, long or short, margined and settled in USDG and
///         priced by the OracleAdapter. The PerpLiquidityVault is the counterparty.
///
///         Two steps. Opening and closing are requests; anyone (normally a keeper) executes a
///         request with the oracle's first price observed after it was made, within
///         `requestTimeout`. Only one price passes, so neither the trader nor the executor can
///         choose one. A request that cannot go through (price beyond the
///         trader's limit, a cap, leverage) is cancelled and refunded rather than left hanging,
///         and one nobody executes in time can be cancelled for a full refund.
///
///         Every position carries a version that increases with each change; a position that is
///         closed, liquidated or cancelled can never be reopened, so any claim on it can only
///         collect what the engine already paid out for it (`paidOut`).
///
///         Funding: the larger side pays the smaller side `maxFundingRatePerHour` times the skew
///         ((long - short) / (long + short)) per unit of size. The smaller side receives at the
///         same rate, and the vault, which carries the imbalance, keeps the difference.
///
///         A position's gain (price result less funding) is capped at its reserve, set aside in
///         the vault when it opens, so every payout is backed.
contract PerpEngine is Ownable2Step, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.UintSet;

    uint256 public constant BPS = 10_000;
    uint256 private constant TOKENS = 1e36;
    uint256 private constant ONE = 1e18;
    uint32 public constant MAX_LEVERAGE_BPS = 200_000;
    uint32 public constant MAX_PROFIT_BPS = 100_000;
    uint16 public constant MAX_TRADE_FEE_BPS = 100;
    uint16 public constant MAX_LIQUIDATION_FEE_BPS = 500;
    uint128 public constant MAX_FUNDING_RATE_PER_HOUR = 1e16; // 1% of size per hour

    struct MarketConfig {
        bytes32 feedId;
        bool enabled;
        uint32 maxLeverageBps;
        uint16 maintenanceMarginBps;
        uint16 openFeeBps;
        uint16 closeFeeBps;
        uint16 liquidationFeeBps;
        uint32 maxProfitBps;
        uint128 maxOpenInterestLong;
        uint128 maxOpenInterestShort;
        uint128 minCollateral;
        uint128 maxFundingRatePerHour;
    }

    /// @dev Aggregates per side so the vault can value all positions at once:
    ///      tokens = sum of size * 1e36 / entryPrice, sizeFunding = sum of size * entry index.
    struct MarketState {
        uint128 oiLong;
        uint128 oiShort;
        uint128 reservedLong;
        uint128 reservedShort;
        uint256 tokensLong;
        uint256 tokensShort;
        int256 fundingLong;
        int256 fundingShort;
        int256 sizeFundingLong;
        int256 sizeFundingShort;
        int128 fundingRate;
        uint64 fundingUpdatedAt;
    }

    enum Status {
        None,
        Pending,
        Open,
        Closed,
        Liquidated,
        Cancelled
    }

    struct Position {
        address owner;
        uint32 market;
        bool isLong;
        Status status;
        uint32 version;
        uint64 openedAt;
        uint128 size;
        uint128 collateral;
        uint128 reserve;
        uint256 entryPrice;
        uint256 tokens;
        int256 entryFunding;
        uint256 pendingClose;
    }

    enum Kind {
        None,
        Open,
        Close
    }

    enum RequestStatus {
        None,
        Pending,
        Executed,
        Cancelled
    }

    enum Reason {
        None,
        Timeout,
        Price,
        MarketClosed,
        Leverage,
        MinCollateral,
        OpenInterest,
        Capacity,
        NotOpen,
        Liquidatable
    }

    /// @param acceptablePrice Worst price the owner accepts: the most a long open or a short
    ///        close pays, the least a short open or a long close receives.
    struct Request {
        address owner;
        Kind kind;
        RequestStatus status;
        uint64 createdAt;
        uint256 positionId;
        uint128 size;
        uint128 collateral;
        uint128 executionFee;
        uint256 acceptablePrice;
    }

    /// @notice How a decrease settled, all in USDG. `gain` is the capped price result less funding.
    struct Settlement {
        uint256 sizeDelta;
        uint256 price;
        int256 pnl;
        int256 funding;
        int256 gain;
        uint256 closeFee;
        uint256 executionFee;
        uint256 payout;
        uint256 size;
        uint256 collateral;
    }

    /// @notice How a liquidation settled: the liquidator's fee, and what went to the vault.
    struct Liquidation {
        uint256 price;
        int256 pnl;
        int256 funding;
        uint256 fee;
        uint256 toVault;
    }

    /// @notice How an open settled: entry price, size, collateral after the open fee, the
    ///         vault reserve, and the position's size in asset units (scaled by 1e36 / price).
    struct Opening {
        uint256 price;
        uint256 size;
        uint256 openFee;
        uint256 collateral;
        uint256 reserve;
        uint256 tokens;
    }

    /// @dev The share of a position a decrease takes.
    struct Part {
        bool full;
        uint256 tokens;
        uint256 collateral;
        uint256 reserve;
    }


    IERC20 public immutable usdg;
    OracleAdapter public immutable oracle;
    PerpLiquidityVault public immutable vault;

    address public orderManager;
    address public guardian;
    address public feeRecipient;
    uint16 public protocolShareBps;
    uint128 public minExecutionFee;
    uint32 public requestTimeout;
    uint32 public navMaxAge;

    uint256 public positionCount;
    uint256 public requestCount;
    /// @notice USDG set aside in the vault for the largest gain open positions can still claim.
    uint256 public totalReserved;
    /// @notice Collateral of open positions plus what pending open requests hold.
    uint256 public totalCollateral;

    uint32[] internal _marketIds;
    mapping(uint32 market => MarketConfig) internal _configs;
    mapping(uint32 market => MarketState) internal _states;
    mapping(uint256 positionId => Position) internal _positions;
    mapping(uint256 requestId => Request) internal _requests;
    /// @notice Everything sent to a position's owner: refunds, proceeds and payouts.
    mapping(uint256 positionId => uint256) public paidOut;
    EnumerableSet.UintSet internal _pending;
    EnumerableSet.UintSet internal _open;

    event MarketSet(uint32 indexed market, MarketConfig config);
    event MarketEnabled(uint32 indexed market, bool enabled);
    event ParamsSet(
        address feeRecipient, uint16 protocolShareBps, uint128 minExecutionFee, uint32 requestTimeout, uint32 navMaxAge
    );
    event GuardianSet(address guardian);
    event OrderManagerSet(address orderManager);
    event RequestCreated(
        uint256 indexed requestId,
        uint256 indexed positionId,
        address indexed owner,
        Kind kind,
        uint32 market,
        bool isLong,
        uint256 size,
        uint256 collateral,
        uint256 acceptablePrice,
        uint256 executionFee
    );
    event RequestExecuted(uint256 indexed requestId, uint256 indexed positionId, uint256 price, address executor);
    event RequestCancelled(
        uint256 indexed requestId, uint256 indexed positionId, Reason reason, uint256 price, uint256 feeCharged, address executor
    );
    event PositionOpened(
        uint256 indexed positionId, address indexed owner, uint32 indexed market, bool isLong, Opening o, uint32 version
    );
    event PositionDecreased(uint256 indexed positionId, address indexed executor, Settlement s, uint32 version);
    event CollateralAdded(uint256 indexed positionId, uint256 amount, uint256 collateral, uint32 version);
    event PositionLiquidated(uint256 indexed positionId, address indexed liquidator, Liquidation l, uint32 version);
    event FundingUpdated(uint32 indexed market, int256 rate, int256 fundingLong, int256 fundingShort, uint256 oiLong, uint256 oiShort);
    event Payout(uint256 indexed positionId, address indexed owner, uint256 amount);

    error ZeroAddress();
    error BadConfig();
    error UnknownMarket(uint32 market);
    error MarketClosed(uint32 market);
    error BadRequest();
    error FeeTooLow(uint256 minimum);
    error BelowMinCollateral(uint256 minimum);
    error LeverageTooHigh();
    error NotOwner();
    error NotOpen();
    error NotPending();
    error RequestPending(uint256 requestId);
    error TooEarly(uint256 at);
    error PriceNotNewer(uint256 timestamp, uint256 required);
    error PriceTooLate(uint256 timestamp, uint256 deadline);
    error NotLiquidatable();
    error Liquidatable();
    error OnlyOrderManager();
    error AlreadySet();
    error NotGuardian();

    constructor(
        IERC20 usdg_,
        OracleAdapter oracle_,
        PerpLiquidityVault vault_,
        address owner_,
        address feeRecipient_,
        uint16 protocolShareBps_,
        uint128 minExecutionFee_,
        uint32 requestTimeout_,
        uint32 navMaxAge_
    ) Ownable(owner_) {
        if (address(usdg_) == address(0) || address(oracle_) == address(0) || address(vault_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(vault_.asset()) != address(usdg_)) revert BadConfig();
        usdg = usdg_;
        oracle = oracle_;
        vault = vault_;
        _setParams(feeRecipient_, protocolShareBps_, minExecutionFee_, requestTimeout_, navMaxAge_);
    }

    // ================================================================ trading

    /// @notice Asks to open a position. Pulls `collateral + executionFee` USDG now; the open fee
    ///         comes out of the collateral when the request executes.
    function requestOpen(
        uint32 market,
        bool isLong,
        uint128 size,
        uint128 collateral,
        uint256 acceptablePrice,
        uint128 executionFee
    ) external nonReentrant returns (uint256 requestId, uint256 positionId) {
        MarketConfig memory m = _configs[market];
        if (m.feedId == bytes32(0) || !m.enabled) revert MarketClosed(market);
        if (size == 0) revert BadRequest();
        if (executionFee < minExecutionFee) revert FeeTooLow(minExecutionFee);
        if (collateral < m.minCollateral) revert BelowMinCollateral(m.minCollateral);
        if (uint256(size) * BPS > uint256(collateral) * m.maxLeverageBps) revert LeverageTooHigh();
        uint256 total = uint256(collateral) + executionFee;
        TransferHelper.pullExact(usdg, msg.sender, total);
        totalCollateral += total;

        positionId = ++positionCount;
        Position storage p = _positions[positionId];
        p.owner = msg.sender;
        p.market = market;
        p.isLong = isLong;
        p.status = Status.Pending;
        requestId = _newRequest(Kind.Open, positionId, size, collateral, executionFee, acceptablePrice);
        emit RequestCreated(
            requestId, positionId, msg.sender, Kind.Open, market, isLong, size, collateral, acceptablePrice, executionFee
        );
    }

    /// @notice Asks to close `size` of a position (its whole size or more closes it all). The
    ///         execution fee is paid from the proceeds.
    function requestClose(uint256 positionId, uint128 size, uint256 acceptablePrice, uint128 executionFee)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        Position storage p = _positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.status != Status.Open) revert NotOpen();
        if (p.pendingClose != 0) revert RequestPending(p.pendingClose);
        if (size == 0) revert BadRequest();
        if (executionFee < minExecutionFee) revert FeeTooLow(minExecutionFee);
        requestId = _newRequest(Kind.Close, positionId, size, 0, executionFee, acceptablePrice);
        p.pendingClose = requestId;
        emit RequestCreated(
            requestId, positionId, msg.sender, Kind.Close, p.market, p.isLong, size, 0, acceptablePrice, executionFee
        );
    }

    /// @notice Cancels a request nobody executed within `requestTimeout`. Anyone may call; an
    ///         open request's collateral and execution fee go back to its owner in full.
    function cancelRequest(uint256 requestId) external nonReentrant {
        Request storage r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert NotPending();
        uint256 at = uint256(r.createdAt) + requestTimeout;
        if (block.timestamp <= at) revert TooEarly(at);
        _cancel(requestId, r, Reason.Timeout, 0, address(0));
    }

    /// @notice Executes a request at the price in `report`, observed after the request was made.
    ///         The caller earns the request's execution fee, also when the request has to be
    ///         cancelled (price beyond the owner's limit, a cap, leverage).
    function executeRequest(uint256 requestId, bytes calldata report) external nonReentrant {
        Request storage r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert NotPending();
        Position storage p = _positions[r.positionId];
        MarketConfig memory m = _configs[p.market];
        if (r.kind == Kind.Open && !m.enabled) {
            _cancel(requestId, r, Reason.MarketClosed, 0, msg.sender);
            return;
        }
        uint256 price = _requestPrice(r, m.feedId, report);
        _accrue(p.market);
        Reason reason = r.kind == Kind.Open ? _tryOpen(r, p, m, price) : _tryClose(r, p, m, price);
        if (reason != Reason.None) {
            _cancel(requestId, r, reason, price, msg.sender);
            return;
        }
        r.status = RequestStatus.Executed;
        _pending.remove(requestId);
        emit RequestExecuted(requestId, r.positionId, price, msg.sender);
    }

    /// @notice Adds collateral to an open position. Lowers risk, so it needs no price.
    function addCollateral(uint256 positionId, uint128 amount) external nonReentrant {
        Position storage p = _positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.status != Status.Open) revert NotOpen();
        if (amount == 0) revert BadRequest();
        TransferHelper.pullExact(usdg, msg.sender, amount);
        p.collateral += amount;
        totalCollateral += amount;
        p.version++;
        emit CollateralAdded(positionId, amount, p.collateral, p.version);
    }

    /// @notice Liquidates a position whose equity (collateral plus capped result, less funding
    ///         and the close fee) is below maintenance margin at the reported price. The
    ///         caller earns the liquidation fee; the rest of the collateral goes to the vault.
    function liquidate(uint256 positionId, bytes calldata report) external nonReentrant {
        Position storage p = _positions[positionId];
        if (p.status != Status.Open) revert NotOpen();
        bytes32 feedId = _configs[p.market].feedId;
        (, uint256 newest) = oracle.latestPrice(feedId);
        (uint256 price, uint256 ts) = oracle.priceFor(feedId, report, OracleAdapter.Use.Liquidate);
        if (ts < newest) revert PriceNotNewer(ts, newest);
        _accrue(p.market);
        _liquidate(positionId, p, price);
    }

    /// @notice Closes part or all of a position for a triggered conditional order. Only the
    ///         OrderManager, which has checked the report and the trigger, may call.
    function closeFromOrder(uint256 positionId, uint256 size, uint256 price, address executor, uint256 executionFee)
        external
        nonReentrant
        returns (uint256 closed)
    {
        if (msg.sender != orderManager) revert OnlyOrderManager();
        Position storage p = _positions[positionId];
        if (p.status != Status.Open) revert NotOpen();
        MarketConfig memory m = _configs[p.market];
        _accrue(p.market);
        if (_liquidatable(p, m, price)) revert Liquidatable();
        closed = _decrease(positionId, p, m, size == 0 ? p.size : size, price, executionFee, executor);
    }

    /// @notice Brings a market's funding index up to date and re-reads its skew. Anyone may call.
    function updateFunding(uint32 market) external {
        if (_configs[market].feedId == bytes32(0)) revert UnknownMarket(market);
        _accrue(market);
        _setRate(market);
    }

    // ================================================================ views

    function position(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function request(uint256 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    function marketConfig(uint32 market) external view returns (MarketConfig memory) {
        return _configs[market];
    }

    function marketState(uint32 market) external view returns (MarketState memory) {
        return _states[market];
    }

    function marketIds() external view returns (uint32[] memory) {
        return _marketIds;
    }

    /// @notice Whether a position can still change: waiting to open, or open.
    function isLive(uint256 positionId) external view returns (bool) {
        Status s = _positions[positionId].status;
        return s == Status.Pending || s == Status.Open;
    }

    function pendingRequests(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        return _page(_pending, offset, limit);
    }

    function openPositions(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        return _page(_open, offset, limit);
    }

    function counts() external view returns (uint256 pending, uint256 open) {
        return (_pending.length(), _open.length());
    }

    // ================================================================ admin

    /// @notice Adds a market or updates its risk settings. A market's feed is fixed once set.
    function setMarket(uint32 market, MarketConfig calldata c) external onlyOwner {
        if (
            c.feedId == bytes32(0) || c.maxLeverageBps < BPS || c.maxLeverageBps > MAX_LEVERAGE_BPS
                || c.maintenanceMarginBps == 0
                || uint256(c.maintenanceMarginBps) * c.maxLeverageBps >= BPS * BPS
                || c.openFeeBps > MAX_TRADE_FEE_BPS || c.closeFeeBps > MAX_TRADE_FEE_BPS
                || c.liquidationFeeBps > MAX_LIQUIDATION_FEE_BPS || c.maxProfitBps == 0 || c.maxProfitBps > MAX_PROFIT_BPS
                || c.maxFundingRatePerHour > MAX_FUNDING_RATE_PER_HOUR
        ) revert BadConfig();
        bytes32 existing = _configs[market].feedId;
        if (existing == bytes32(0)) {
            _marketIds.push(market);
            _states[market].fundingUpdatedAt = uint64(block.timestamp);
        } else {
            if (existing != c.feedId) revert BadConfig();
            _accrue(market);
        }
        _configs[market] = c;
        _setRate(market);
        emit MarketSet(market, c);
        emit MarketEnabled(market, c.enabled);
    }

    /// @notice Turns new positions in a market on or off. The guardian may only turn them off;
    ///         closing, conditional orders and liquidations always continue.
    function setMarketEnabled(uint32 market, bool enabled) external {
        if (msg.sender != owner() && (msg.sender != guardian || enabled)) revert NotGuardian();
        if (_configs[market].feedId == bytes32(0)) revert UnknownMarket(market);
        _configs[market].enabled = enabled;
        emit MarketEnabled(market, enabled);
    }

    function setOrderManager(address orderManager_) external onlyOwner {
        if (orderManager != address(0)) revert AlreadySet();
        if (orderManager_ == address(0)) revert ZeroAddress();
        orderManager = orderManager_;
        emit OrderManagerSet(orderManager_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setParams(
        address feeRecipient_,
        uint16 protocolShareBps_,
        uint128 minExecutionFee_,
        uint32 requestTimeout_,
        uint32 navMaxAge_
    ) external onlyOwner {
        _setParams(feeRecipient_, protocolShareBps_, minExecutionFee_, requestTimeout_, navMaxAge_);
    }

    // ================================================================ internals: requests

    function _newRequest(
        Kind kind,
        uint256 positionId,
        uint128 size,
        uint128 collateral,
        uint128 executionFee,
        uint256 acceptablePrice
    ) private returns (uint256 requestId) {
        requestId = ++requestCount;
        _requests[requestId] = Request(
            msg.sender,
            kind,
            RequestStatus.Pending,
            uint64(block.timestamp),
            positionId,
            size,
            collateral,
            executionFee,
            acceptablePrice
        );
        _pending.add(requestId);
    }

    /// @dev The price must be the oracle's first price for the feed observed after the request
    ///      (from the second after `createdAt`), within its timeout. Only one report passes, so
    ///      whoever executes cannot pick a price. A newer price recorded meanwhile does not block
    ///      the fill.
    function _requestPrice(Request storage r, bytes32 feedId, bytes calldata report) private returns (uint256 price) {
        uint64 notBefore = r.createdAt + 1;
        uint64 deadline = r.createdAt + requestTimeout;
        uint256 ts;
        (price, ts) = oracle.priceForRequest(
            feedId, report, r.kind == Kind.Open ? OracleAdapter.Use.Open : OracleAdapter.Use.Reduce, notBefore, deadline
        );
        if (ts < notBefore) revert PriceNotNewer(ts, notBefore);
        if (ts > deadline) revert PriceTooLate(ts, deadline);
    }

    function _tryOpen(Request storage r, Position storage p, MarketConfig memory m, uint256 price)
        private
        returns (Reason reason)
    {
        Opening memory o;
        (reason, o) = _checkOpen(r, p, m, price);
        if (reason != Reason.None) return reason;

        MarketState storage s = _states[p.market];
        int256 index = p.isLong ? s.fundingLong : s.fundingShort;
        if (p.isLong) {
            s.oiLong += uint128(o.size);
            s.reservedLong += uint128(o.reserve);
            s.tokensLong += o.tokens;
            s.sizeFundingLong += int256(o.size) * index;
        } else {
            s.oiShort += uint128(o.size);
            s.reservedShort += uint128(o.reserve);
            s.tokensShort += o.tokens;
            s.sizeFundingShort += int256(o.size) * index;
        }
        totalReserved += o.reserve;
        totalCollateral -= o.openFee + r.executionFee;
        p.size = uint128(o.size);
        p.collateral = uint128(o.collateral);
        p.reserve = uint128(o.reserve);
        p.entryPrice = price;
        p.tokens = o.tokens;
        p.entryFunding = index;
        p.openedAt = uint64(block.timestamp);
        p.status = Status.Open;
        p.version++;
        _open.add(r.positionId);
        _setRate(p.market);

        _payFee(o.openFee);
        TransferHelper.push(usdg, msg.sender, r.executionFee);
        emit PositionOpened(r.positionId, p.owner, p.market, p.isLong, o, p.version);
        return Reason.None;
    }

    function _checkOpen(Request storage r, Position storage p, MarketConfig memory m, uint256 price)
        private
        view
        returns (Reason, Opening memory o)
    {
        bool isLong = p.isLong;
        if (isLong ? price > r.acceptablePrice : price < r.acceptablePrice) return (Reason.Price, o);
        o.price = price;
        o.size = r.size;
        o.openFee = (o.size * m.openFeeBps) / BPS;
        if (r.collateral <= o.openFee) return (Reason.MinCollateral, o);
        o.collateral = r.collateral - o.openFee;
        if (o.collateral < m.minCollateral) return (Reason.MinCollateral, o);
        if (o.size * BPS > o.collateral * m.maxLeverageBps) return (Reason.Leverage, o);
        if (o.collateral * BPS <= o.size * (uint256(m.closeFeeBps) + m.maintenanceMarginBps)) {
            return (Reason.Leverage, o);
        }
        MarketState storage s = _states[p.market];
        if (isLong ? s.oiLong + o.size > m.maxOpenInterestLong : s.oiShort + o.size > m.maxOpenInterestShort) {
            return (Reason.OpenInterest, o);
        }
        o.reserve = (o.size * m.maxProfitBps) / BPS;
        if (totalReserved + o.reserve > vault.capacity()) return (Reason.Capacity, o);
        o.tokens = Math.mulDiv(o.size, TOKENS, price);
        return (Reason.None, o);
    }

    function _tryClose(Request storage r, Position storage p, MarketConfig memory m, uint256 price)
        private
        returns (Reason)
    {
        if (p.status != Status.Open) return Reason.NotOpen;
        if (p.isLong ? price < r.acceptablePrice : price > r.acceptablePrice) return Reason.Price;
        if (_liquidatable(p, m, price)) return Reason.Liquidatable;
        p.pendingClose = 0;
        _decrease(r.positionId, p, m, r.size, price, r.executionFee, msg.sender);
        return Reason.None;
    }

    /// @dev An open request returns its escrow: in full on timeout, less the execution fee when
    ///      an executor processed it. A close request that an executor could not fill for its
    ///      price limit pays the executor at most `minExecutionFee` from collateral, and only
    ///      while the position stays above maintenance margin.
    function _cancel(uint256 requestId, Request storage r, Reason reason, uint256 price, address executor) private {
        r.status = RequestStatus.Cancelled;
        _pending.remove(requestId);
        Position storage p = _positions[r.positionId];
        uint256 charged;
        if (r.kind == Kind.Open) {
            uint256 total = uint256(r.collateral) + r.executionFee;
            charged = executor == address(0) ? 0 : r.executionFee;
            totalCollateral -= total;
            p.status = Status.Cancelled;
            p.version++;
            if (charged != 0) TransferHelper.push(usdg, executor, charged);
            _payOwner(r.positionId, p.owner, total - charged);
        } else {
            if (p.pendingClose == requestId) p.pendingClose = 0;
            if (reason == Reason.Price && executor != address(0)) {
                charged = Math.min(Math.min(r.executionFee, minExecutionFee), p.collateral);
                p.collateral -= uint128(charged);
                if (charged != 0 && !_liquidatable(p, _configs[p.market], price)) {
                    totalCollateral -= charged;
                    p.version++;
                    TransferHelper.push(usdg, executor, charged);
                } else {
                    p.collateral += uint128(charged);
                    charged = 0;
                }
            }
        }
        emit RequestCancelled(requestId, r.positionId, reason, price, charged, executor);
    }

    function _dropPendingClose(uint256 positionId, Position storage p, uint256 price) private {
        uint256 id = p.pendingClose;
        p.pendingClose = 0;
        _requests[id].status = RequestStatus.Cancelled;
        _pending.remove(id);
        emit RequestCancelled(id, positionId, Reason.NotOpen, price, 0, address(0));
    }

    // ================================================================ internals: settlement

    function _decrease(
        uint256 positionId,
        Position storage p,
        MarketConfig memory m,
        uint256 sizeDelta,
        uint256 price,
        uint256 executionFee,
        address executor
    ) private returns (uint256) {
        (Settlement memory s, Part memory part) = _settle(p, m, sizeDelta, price, executionFee);
        _removeFromMarket(p, s.sizeDelta, part.tokens, part.reserve);
        totalCollateral -= part.collateral;
        totalReserved -= part.reserve;
        if (part.full) {
            if (p.pendingClose != 0) _dropPendingClose(positionId, p, price);
            _retire(positionId, p, Status.Closed);
        } else {
            p.size -= uint128(s.sizeDelta);
            p.collateral -= uint128(part.collateral);
            p.tokens -= part.tokens;
            p.reserve -= uint128(part.reserve);
            p.version++;
        }
        s.size = p.size;
        s.collateral = p.collateral;
        _setRate(p.market);
        _distribute(positionId, p.owner, executor, s, part.collateral);
        emit PositionDecreased(positionId, executor, s, p.version);
        return s.sizeDelta;
    }

    /// @dev What closing `sizeDelta` at `price` pays. A partial close that would leave less than
    ///      the minimum collateral closes the whole position.
    function _settle(Position storage p, MarketConfig memory m, uint256 sizeDelta, uint256 price, uint256 executionFee)
        private
        view
        returns (Settlement memory s, Part memory part)
    {
        uint256 size = p.size;
        part.full = sizeDelta >= size || p.collateral - (uint256(p.collateral) * sizeDelta) / size < m.minCollateral;
        s.sizeDelta = part.full ? size : sizeDelta;
        s.price = price;
        part.tokens = part.full ? p.tokens : (p.tokens * s.sizeDelta) / size;
        part.collateral = part.full ? p.collateral : (uint256(p.collateral) * s.sizeDelta) / size;
        part.reserve = part.full ? p.reserve : (uint256(p.reserve) * s.sizeDelta) / size;
        s.pnl = _pnl(p.isLong, s.sizeDelta, part.tokens, price);
        s.funding = _fundingOwed(p, s.sizeDelta);
        s.gain = s.pnl - s.funding;
        if (s.gain > int256(part.reserve)) s.gain = int256(part.reserve);
        int256 avail = int256(part.collateral) + s.gain;
        s.closeFee = _take(avail, (s.sizeDelta * m.closeFeeBps) / BPS);
        avail -= int256(s.closeFee);
        s.executionFee = _take(avail, executionFee);
        avail -= int256(s.executionFee);
        s.payout = avail > 0 ? uint256(avail) : 0;
    }

    /// @dev The engine holds `collateral`; a gain comes from the vault first. Then the protocol's
    ///      share of the close fee, the executor, the owner, and the rest to the vault.
    function _distribute(uint256 positionId, address owner_, address executor, Settlement memory s, uint256 collateral)
        private
    {
        uint256 pot = collateral;
        if (s.gain > 0) {
            vault.pay(address(this), uint256(s.gain));
            pot += uint256(s.gain);
        }
        uint256 toProtocol = (s.closeFee * protocolShareBps) / BPS;
        if (toProtocol != 0) TransferHelper.push(usdg, feeRecipient, toProtocol);
        if (s.executionFee != 0) TransferHelper.push(usdg, executor, s.executionFee);
        if (s.payout != 0) _payOwner(positionId, owner_, s.payout);
        uint256 toVault = pot - s.payout - s.executionFee - toProtocol;
        if (toVault != 0) TransferHelper.push(usdg, address(vault), toVault);
    }

    function _liquidate(uint256 positionId, Position storage p, uint256 price) private {
        MarketConfig memory m = _configs[p.market];
        if (!_liquidatable(p, m, price)) revert NotLiquidatable();
        Liquidation memory l;
        l.price = price;
        l.pnl = _pnl(p.isLong, p.size, p.tokens, price);
        l.funding = _fundingOwed(p, p.size);
        uint256 collateral = p.collateral;
        l.fee = Math.min((uint256(p.size) * m.liquidationFeeBps) / BPS, collateral);
        l.toVault = collateral - l.fee;
        _removeFromMarket(p, p.size, p.tokens, p.reserve);
        totalCollateral -= collateral;
        totalReserved -= p.reserve;
        if (p.pendingClose != 0) _dropPendingClose(positionId, p, price);
        _retire(positionId, p, Status.Liquidated);
        _setRate(p.market);

        if (l.fee != 0) TransferHelper.push(usdg, msg.sender, l.fee);
        if (l.toVault != 0) TransferHelper.push(usdg, address(vault), l.toVault);
        emit PositionLiquidated(positionId, msg.sender, l, p.version);
    }

    function _retire(uint256 positionId, Position storage p, Status status) private {
        p.status = status;
        p.size = 0;
        p.collateral = 0;
        p.reserve = 0;
        p.tokens = 0;
        p.version++;
        _open.remove(positionId);
    }

    function _removeFromMarket(Position storage p, uint256 sizeDelta, uint256 tokens, uint256 reserve) private {
        MarketState storage s = _states[p.market];
        if (p.isLong) {
            s.oiLong -= uint128(sizeDelta);
            s.reservedLong -= uint128(reserve);
            s.tokensLong -= tokens;
            s.sizeFundingLong -= int256(sizeDelta) * p.entryFunding;
        } else {
            s.oiShort -= uint128(sizeDelta);
            s.reservedShort -= uint128(reserve);
            s.tokensShort -= tokens;
            s.sizeFundingShort -= int256(sizeDelta) * p.entryFunding;
        }
    }

    function _payFee(uint256 fee) private {
        uint256 toProtocol = (fee * protocolShareBps) / BPS;
        if (toProtocol != 0) TransferHelper.push(usdg, feeRecipient, toProtocol);
        if (fee > toProtocol) TransferHelper.push(usdg, address(vault), fee - toProtocol);
    }

    function _payOwner(uint256 positionId, address owner_, uint256 amount) private {
        if (amount == 0) return;
        paidOut[positionId] += amount;
        TransferHelper.push(usdg, owner_, amount);
        emit Payout(positionId, owner_, amount);
    }

    // ================================================================ internals: math

    function _accrue(uint32 market) private {
        MarketState storage s = _states[market];
        uint256 dt = block.timestamp - s.fundingUpdatedAt;
        if (dt == 0) return;
        int256 d = int256(s.fundingRate) * int256(dt);
        s.fundingLong += d;
        s.fundingShort -= d;
        s.fundingUpdatedAt = uint64(block.timestamp);
    }

    /// @dev Call after `_accrue` and after open interest changes.
    function _setRate(uint32 market) private {
        MarketState storage s = _states[market];
        uint256 l = s.oiLong;
        uint256 sh = s.oiShort;
        int256 rate;
        if (l + sh != 0) {
            rate = (int256(uint256(_configs[market].maxFundingRatePerHour) / 1 hours) * (int256(l) - int256(sh)))
                / int256(l + sh);
        }
        s.fundingRate = int128(rate);
        emit FundingUpdated(market, rate, s.fundingLong, s.fundingShort, l, sh);
    }

    function _pnl(bool isLong, uint256 size, uint256 tokens, uint256 price) private pure returns (int256) {
        int256 value = int256(Math.mulDiv(tokens, price, TOKENS));
        return isLong ? value - int256(size) : int256(size) - value;
    }

    function _fundingOwed(Position storage p, uint256 sizeDelta) private view returns (int256) {
        MarketState storage s = _states[p.market];
        int256 index = p.isLong ? s.fundingLong : s.fundingShort;
        return (int256(sizeDelta) * (index - p.entryFunding)) / int256(ONE);
    }

    function _liquidatable(Position storage p, MarketConfig memory m, uint256 price) private view returns (bool) {
        uint256 size = p.size;
        int256 gain = _pnl(p.isLong, size, p.tokens, price) - _fundingOwed(p, size);
        if (gain > int256(uint256(p.reserve))) gain = int256(uint256(p.reserve));
        int256 equity = int256(uint256(p.collateral)) + gain - int256((size * m.closeFeeBps) / BPS);
        return equity < int256((size * m.maintenanceMarginBps) / BPS);
    }

    function _take(int256 available, uint256 wanted) private pure returns (uint256) {
        if (available <= 0) return 0;
        return Math.min(uint256(available), wanted);
    }

    function _page(EnumerableSet.UintSet storage set, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids)
    {
        uint256 n = set.length();
        if (offset >= n) return ids;
        uint256 end = Math.min(n, offset + limit);
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = set.at(i);
        }
    }

    function _setParams(
        address feeRecipient_,
        uint16 protocolShareBps_,
        uint128 minExecutionFee_,
        uint32 requestTimeout_,
        uint32 navMaxAge_
    ) private {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (protocolShareBps_ > 5_000 || requestTimeout_ < 10 || requestTimeout_ > 1 days || navMaxAge_ == 0) {
            revert BadConfig();
        }
        feeRecipient = feeRecipient_;
        protocolShareBps = protocolShareBps_;
        minExecutionFee = minExecutionFee_;
        requestTimeout = requestTimeout_;
        navMaxAge = navMaxAge_;
        emit ParamsSet(feeRecipient_, protocolShareBps_, minExecutionFee_, requestTimeout_, navMaxAge_);
    }
}
