// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TransferHelper} from "../shared/TransferHelper.sol";
import {IGraduationMigrator} from "./interfaces/ILaunch.sol";

/// @title BondingCurve
/// @notice The trading curve of one launch (whitepaper 10.3 and 11). Price follows virtual
///         reserves Xv * Yv = K. Only real reserves move: net quote paid in (fees excluded)
///         and the token inventory held here. Virtual reserves are never paid out.
///
///         Created -> Trading -> GraduationReady -> Graduated.
///
///         A buy that would pass the graduation threshold is partially filled: it takes exactly
///         the quote needed to reach the threshold and leaves the rest with the buyer. Trading
///         then stops and anyone may call `graduate`, which hands the reserves and the
///         migration inventory to the migrator. No creator or admin function can withdraw
///         reserves.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    enum State {
        Created,
        Trading,
        GraduationReady,
        Graduated
    }

    enum Bucket {
        Creator,
        Operator,
        Protocol
    }

    struct Config {
        address quote;
        address migrator;
        address creator;
        address creatorRecipient;
        address operator;
        address protocolFeeRecipient;
        uint256 templateId;
        uint256 curveSupply;
        uint256 graduationThreshold;
        uint256 virtualBase;
        uint256 virtualQuote;
        uint16 feeBps;
        uint16 creatorFeeShareBps;
        uint16 operatorShareBps; // share of the protocol part that goes to the operator
    }

    address public immutable factory;
    IERC20 public token;
    IERC20 public immutable quote;
    address public immutable migrator;
    address public immutable creator;
    address public immutable operator;
    address public immutable protocolFeeRecipient;
    uint256 public immutable templateId;
    uint256 public immutable curveSupply;
    uint256 public immutable graduationThreshold;
    uint256 public immutable initialVirtualBase;
    uint256 public immutable initialVirtualQuote;
    uint256 public immutable k;
    uint16 public immutable feeBps;
    uint16 public immutable creatorFeeShareBps;
    uint16 public immutable operatorShareBps;

    State public state;
    address public creatorRecipient;
    /// Current virtual token reserve. initialVirtualBase - virtualBase tokens are in circulation.
    uint256 public virtualBase;
    /// Real net quote reserves. The virtual quote reserve is initialVirtualQuote + reserve.
    uint256 public reserve;
    uint128 public creatorFees;
    uint128 public operatorFees;
    uint128 public protocolFees;
    address public pool;

    event Trade(
        address indexed trader,
        address indexed to,
        bool isBuy,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 reserveAfter,
        uint256 virtualBaseAfter
    );
    event StateChanged(State state);
    event Graduated(
        address indexed pool,
        uint256 tokenAmount,
        uint256 quoteAmount,
        uint256 liquidity,
        uint256 creatorLockId,
        uint256 protocolLockId
    );
    event FeesClaimed(Bucket indexed bucket, address indexed recipient, uint256 amount);
    event CreatorRecipientSet(address recipient);

    error NotTrading(State state);
    error NotGraduationReady(State state);
    error Expired();
    error ZeroAmount();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error ExceedsCirculating(uint256 amount, uint256 circulating);
    error NotCreatorRecipient();
    error ZeroAddress();
    error NotFactory();

    constructor(Config memory c) {
        factory = msg.sender;
        quote = IERC20(c.quote);
        migrator = c.migrator;
        creator = c.creator;
        creatorRecipient = c.creatorRecipient;
        operator = c.operator;
        protocolFeeRecipient = c.protocolFeeRecipient;
        templateId = c.templateId;
        curveSupply = c.curveSupply;
        graduationThreshold = c.graduationThreshold;
        initialVirtualBase = c.virtualBase;
        initialVirtualQuote = c.virtualQuote;
        k = c.virtualBase * c.virtualQuote;
        feeBps = c.feeBps;
        creatorFeeShareBps = c.creatorFeeShareBps;
        operatorShareBps = c.operatorShareBps;
        virtualBase = c.virtualBase;
    }

    /// @notice Called once by the factory in the creation transaction, after it deploys the
    ///         token with the full supply minted to this curve.
    function bindToken(address token_) external {
        if (msg.sender != factory || address(token) != address(0)) revert NotFactory();
        token = IERC20(token_);
    }

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ------------------------------------------------------------------ views

    function virtualReserves() public view returns (uint256 base, uint256 quoteReserve) {
        return (virtualBase, initialVirtualQuote + reserve);
    }

    /// Tokens bought from the curve and not sold back.
    function circulating() public view returns (uint256) {
        return initialVirtualBase - virtualBase;
    }

    /// Tokens still for sale on the curve.
    function inventory() public view returns (uint256) {
        uint256 c = circulating();
        return c >= curveSupply ? 0 : curveSupply - c;
    }

    /// Graduation progress in basis points: real net reserves over the threshold, capped at 100%.
    function progressBps() external view returns (uint256) {
        return reserve >= graduationThreshold ? BPS : (reserve * BPS) / graduationThreshold;
    }

    /// @return tokensOut tokens the buyer receives
    /// @return fee curve fee in quote
    /// @return quoteUsed quote actually taken; less than `quoteIn` when the buy completes the curve
    function quoteBuy(uint256 quoteIn) public view returns (uint256 tokensOut, uint256 fee, uint256 quoteUsed) {
        if (quoteIn == 0) revert ZeroAmount();
        fee = Math.mulDiv(quoteIn, feeBps, BPS, Math.Rounding.Ceil);
        uint256 net = quoteIn - fee;
        quoteUsed = quoteIn;
        uint256 room = graduationThreshold - reserve;
        bool completes = net >= room;
        if (completes) {
            net = room;
            quoteUsed = Math.mulDiv(room, BPS, BPS - feeBps, Math.Rounding.Ceil);
            fee = quoteUsed - net;
        }
        uint256 newBase = Math.ceilDiv(k, initialVirtualQuote + reserve + net);
        tokensOut = virtualBase - newBase;
        uint256 inv = inventory();
        if (completes || tokensOut > inv) tokensOut = inv;
    }

    /// @return quoteOut quote the seller receives after the fee
    /// @return fee curve fee in quote
    function quoteSell(uint256 tokensIn) public view returns (uint256 quoteOut, uint256 fee) {
        if (tokensIn == 0) revert ZeroAmount();
        uint256 c = circulating();
        if (tokensIn > c) revert ExceedsCirculating(tokensIn, c);
        uint256 newQuote = Math.ceilDiv(k, virtualBase + tokensIn);
        uint256 cur = initialVirtualQuote + reserve;
        uint256 gross = cur > newQuote ? cur - newQuote : 0;
        fee = Math.mulDiv(gross, feeBps, BPS, Math.Rounding.Ceil);
        quoteOut = gross - fee;
    }

    // ------------------------------------------------------------------ trading

    function buy(uint256 quoteIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        nonReentrant
        ensure(deadline)
        returns (uint256 tokensOut, uint256 quoteUsed)
    {
        State s = state;
        if (s != State.Created && s != State.Trading) revert NotTrading(s);
        if (to == address(0)) revert ZeroAddress();
        uint256 fee;
        (tokensOut, fee, quoteUsed) = quoteBuy(quoteIn);
        if (tokensOut == 0 || tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);

        TransferHelper.pullExact(quote, msg.sender, quoteUsed);
        reserve += quoteUsed - fee;
        virtualBase -= tokensOut;
        _bookFee(fee);
        token.safeTransfer(to, tokensOut);
        emit Trade(msg.sender, to, true, quoteUsed, tokensOut, fee, reserve, virtualBase);

        if (reserve >= graduationThreshold) {
            state = State.GraduationReady;
            emit StateChanged(State.GraduationReady);
        } else if (s == State.Created) {
            state = State.Trading;
            emit StateChanged(State.Trading);
        }
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address to, uint256 deadline)
        external
        nonReentrant
        ensure(deadline)
        returns (uint256 quoteOut)
    {
        State s = state;
        if (s != State.Trading) revert NotTrading(s);
        if (to == address(0)) revert ZeroAddress();
        uint256 fee;
        (quoteOut, fee) = quoteSell(tokensIn);
        if (quoteOut == 0 || quoteOut < minQuoteOut) revert InsufficientOutput(quoteOut, minQuoteOut);

        TransferHelper.pullExact(token, msg.sender, tokensIn);
        virtualBase += tokensIn;
        reserve = Math.ceilDiv(k, virtualBase) - initialVirtualQuote;
        _bookFee(fee);
        quote.safeTransfer(to, quoteOut);
        emit Trade(msg.sender, to, false, quoteOut + fee, tokensIn, fee, reserve, virtualBase);
    }

    // ------------------------------------------------------------------ graduation

    /// @notice Hands the reserves and remaining inventory to the migrator, which creates the
    ///         committed DAMM pool and escrows the LP shares. Anyone may call it once the
    ///         threshold is reached. If any migration check fails, everything reverts and the
    ///         reserves stay here, still accounted for.
    function graduate() external nonReentrant returns (address pool_, uint256 liquidity) {
        if (state != State.GraduationReady) revert NotGraduationReady(state);
        state = State.Graduated;
        // Accounted inventory only. Tokens sent here outside of trades are burned, so a
        // transfer to this address cannot change the opening price.
        uint256 tokenAmount = token.totalSupply() - circulating();
        uint256 extra = token.balanceOf(address(this)) - tokenAmount;
        if (extra > 0) token.safeTransfer(DEAD, extra);
        uint256 quoteAmount = reserve;
        token.safeTransfer(migrator, tokenAmount);
        quote.safeTransfer(migrator, quoteAmount);
        uint256 creatorLock;
        uint256 protocolLock;
        (pool_, liquidity, creatorLock, protocolLock) = IGraduationMigrator(migrator).migrate(tokenAmount, quoteAmount);
        pool = pool_;
        emit StateChanged(State.Graduated);
        emit Graduated(pool_, tokenAmount, quoteAmount, liquidity, creatorLock, protocolLock);
    }

    /// The token and quote amounts graduation hands to the migrator.
    function migrationAmounts() external view returns (uint256 tokenAmount, uint256 quoteAmount) {
        return (token.totalSupply() - circulating(), reserve);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Pays a fee bucket to its fixed recipient. Anyone may call.
    function claimFees(Bucket b) external nonReentrant returns (uint256 amount) {
        address to;
        if (b == Bucket.Creator) {
            amount = creatorFees;
            creatorFees = 0;
            to = creatorRecipient;
        } else if (b == Bucket.Operator) {
            amount = operatorFees;
            operatorFees = 0;
            to = operator;
        } else {
            amount = protocolFees;
            protocolFees = 0;
            to = protocolFeeRecipient;
        }
        if (amount > 0) quote.safeTransfer(to, amount);
        emit FeesClaimed(b, to, amount);
    }

    /// @notice The creator's fee recipient may hand its role to another address.
    function setCreatorRecipient(address recipient) external {
        if (msg.sender != creatorRecipient) revert NotCreatorRecipient();
        if (recipient == address(0)) revert ZeroAddress();
        creatorRecipient = recipient;
        emit CreatorRecipientSet(recipient);
    }

    function _bookFee(uint256 fee) internal {
        uint256 toCreator = (fee * creatorFeeShareBps) / BPS;
        uint256 rest = fee - toCreator;
        uint256 toOperator = operator == address(0) ? 0 : (rest * operatorShareBps) / BPS;
        creatorFees += uint128(toCreator);
        operatorFees += uint128(toOperator);
        protocolFees += uint128(rest - toOperator);
    }
}
