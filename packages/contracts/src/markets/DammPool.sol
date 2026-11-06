// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICurveilPool, IPoolFactory} from "./interfaces/ICurveilPool.sol";

/// @title DammPool
/// @notice Full-range constant-product pool (x * y = k) with a bounded dynamic fee.
///         Fee = min(maxFee, baseFee + volatility component). The LP share of each fee is
///         held outside the reserves and claimed per LP; the protocol share is collected
///         to the factory's fee recipient.
/// @dev Fee parameters are fixed at creation; a new factory default never changes an existing pool.
///      The pool's ERC-20 is the LP share. Fees are settled on every share transfer.
contract DammPool is ERC20, ReentrancyGuard, ICurveilPool {
    using SafeERC20 for IERC20;

    struct FeeParams {
        uint16 baseFeeBps; // e.g. 30 = 0.30%
        uint16 maxFeeBps; // e.g. 100 = 1.00%
        uint16 protocolShareBps; // share of each fee that goes to the protocol, e.g. 2000 = 20%
        uint16 variableFeeControl; // bps of fee added per 10_000 bps of volatility
        uint32 filterPeriod; // seconds within which volatility keeps accumulating
        uint32 decayPeriod; // seconds after which volatility resets
        uint16 reductionBps; // share of volatility kept when it decays
        uint32 maxVolatilityBps; // cap on the accumulator
    }

    struct Checkpoint {
        uint256 growth0;
        uint256 growth1;
        uint128 owed0;
        uint128 owed1;
    }

    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q128 = 1 << 128;

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;

    FeeParams internal _params;

    uint128 public reserve0;
    uint128 public reserve1;
    uint128 public lpFees0; // unclaimed LP fees held by the pool
    uint128 public lpFees1;
    uint128 public protocolFees0;
    uint128 public protocolFees1;
    uint256 public feeGrowth0; // LP fee per share, Q128
    uint256 public feeGrowth1;

    // Volatility state (deterministic, documented in Docs).
    uint256 public priceReference; // reserve1 / reserve0 in Q128 at the start of the current window
    uint32 public volatilityReference; // bps carried into the window
    uint32 public volatilityAccumulator; // bps
    uint40 public lastSwapAt;

    mapping(address account => Checkpoint) internal _checkpoints;

    event Mint(address indexed sender, address indexed to, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Burn(address indexed sender, address indexed to, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(
        address indexed sender,
        address indexed to,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint256 protocolFee,
        uint16 feeBps
    );
    event Sync(uint128 reserve0, uint128 reserve1);
    event FeesClaimed(address indexed owner, address indexed to, uint256 amount0, uint256 amount1);
    event ProtocolFeesCollected(address indexed to, uint256 amount0, uint256 amount1);

    error InsufficientInput();
    error InsufficientOutput();
    error InsufficientLiquidity();
    error InvalidToken(address token);
    error Overflow();

    constructor(address token0_, address token1_, FeeParams memory params_) ERC20("Curveil DAMM LP", "CVL-DAMM-LP") {
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
        _params = params_;
    }

    // ------------------------------------------------------------------ views

    function tokens() external view returns (address, address) {
        return (token0, token1);
    }

    function feeParams() external view returns (FeeParams memory) {
        return _params;
    }

    function getReserves() external view returns (uint128, uint128) {
        return (reserve0, reserve1);
    }

    /// @notice Fee in bps that a swap would pay right now.
    function currentFeeBps() public view returns (uint16) {
        (uint256 vRef, uint256 pRef) = _windowStart();
        uint256 v = vRef + _deviationBps(pRef);
        return _feeFromVolatility(v);
    }

    function pendingFees(address account) external view returns (uint256 owed0, uint256 owed1) {
        Checkpoint memory c = _checkpoints[account];
        uint256 bal = balanceOf(account);
        owed0 = c.owed0 + Math.mulDiv(bal, feeGrowth0 - c.growth0, Q128);
        owed1 = c.owed1 + Math.mulDiv(bal, feeGrowth1 - c.growth1, Q128);
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut, uint256 fee) {
        return _quoteAt(_direction(tokenIn), amountIn, currentFeeBps());
    }

    // ------------------------------------------------------------------ liquidity

    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        (uint256 a0, uint256 a1) = _unaccounted();
        uint256 supply = totalSupply();
        if (supply == 0) {
            liquidity = Math.sqrt(a0 * a1);
            if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            liquidity -= MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
            priceReference = Math.mulDiv(a1, Q128, a0);
            lastSwapAt = uint40(block.timestamp);
        } else {
            liquidity = Math.min((a0 * supply) / reserve0, (a1 * supply) / reserve1);
        }
        if (liquidity == 0) revert InsufficientLiquidity();
        _setReserves(uint256(reserve0) + a0, uint256(reserve1) + a1);
        _mint(to, liquidity);
        emit Mint(msg.sender, to, a0, a1, liquidity);
    }

    /// @notice Burns LP shares that were transferred to this pool and sends out the underlying.
    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        uint256 liquidity = balanceOf(address(this));
        uint256 supply = totalSupply();
        amount0 = (liquidity * reserve0) / supply;
        amount1 = (liquidity * reserve1) / supply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();
        _burn(address(this), liquidity);
        _setReserves(uint256(reserve0) - amount0, uint256(reserve1) - amount1);
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);
        emit Burn(msg.sender, to, amount0, amount1, liquidity);
    }

    function claimFees(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        _settle(msg.sender);
        Checkpoint storage c = _checkpoints[msg.sender];
        amount0 = c.owed0;
        amount1 = c.owed1;
        c.owed0 = 0;
        c.owed1 = 0;
        lpFees0 -= uint128(amount0);
        lpFees1 -= uint128(amount1);
        if (amount0 > 0) IERC20(token0).safeTransfer(to, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(to, amount1);
        emit FeesClaimed(msg.sender, to, amount0, amount1);
    }

    function collectProtocolFees() external nonReentrant returns (uint256 amount0, uint256 amount1) {
        address to = IPoolFactory(factory).feeTo();
        amount0 = protocolFees0;
        amount1 = protocolFees1;
        protocolFees0 = 0;
        protocolFees1 = 0;
        if (amount0 > 0) IERC20(token0).safeTransfer(to, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(to, amount1);
        emit ProtocolFeesCollected(to, amount0, amount1);
    }

    // ------------------------------------------------------------------ swap

    function swap(address tokenIn, address to) external nonReentrant returns (uint256 amountOut) {
        bool zeroForOne = _direction(tokenIn);
        (uint256 u0, uint256 u1) = _unaccounted();
        uint256 amountIn = zeroForOne ? u0 : u1;
        if (amountIn == 0) revert InsufficientInput();

        (uint256 vRef, uint256 pRef) = _windowStart();
        uint16 feeBps = _feeFromVolatility(vRef + _deviationBps(pRef));
        uint256 fee;
        (amountOut, fee) = _quoteAt(zeroForOne, amountIn, feeBps);
        uint256 protocolFee = (fee * _params.protocolShareBps) / BPS;
        _book(zeroForOne, amountIn - fee, amountOut, fee - protocolFee, protocolFee);
        IERC20(zeroForOne ? token1 : token0).safeTransfer(to, amountOut);

        // Volatility after the trade, measured against the window's reference price.
        volatilityReference = uint32(vRef);
        volatilityAccumulator = uint32(Math.min(vRef + _deviationBps(pRef), _params.maxVolatilityBps));
        priceReference = pRef;
        lastSwapAt = uint40(block.timestamp);

        emit Swap(msg.sender, to, zeroForOne, amountIn, amountOut, fee, protocolFee, feeBps);
    }

    // ------------------------------------------------------------------ internals

    function _quoteAt(bool zeroForOne, uint256 amountIn, uint16 feeBps)
        internal
        view
        returns (uint256 amountOut, uint256 fee)
    {
        (uint256 rIn, uint256 rOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (rIn == 0 || rOut == 0) revert InsufficientLiquidity();
        fee = Math.mulDiv(amountIn, feeBps, BPS, Math.Rounding.Ceil);
        uint256 net = amountIn - fee;
        amountOut = (net * rOut) / (rIn + net);
        if (amountOut == 0 || amountOut >= rOut) revert InsufficientOutput();
    }

    function _book(bool zeroForOne, uint256 net, uint256 amountOut, uint256 lpFee, uint256 protocolFee) internal {
        uint256 growth = Math.mulDiv(lpFee, Q128, totalSupply());
        if (zeroForOne) {
            _setReserves(uint256(reserve0) + net, uint256(reserve1) - amountOut);
            feeGrowth0 += growth;
            lpFees0 += _u128(lpFee);
            protocolFees0 += _u128(protocolFee);
        } else {
            _setReserves(uint256(reserve0) - amountOut, uint256(reserve1) + net);
            feeGrowth1 += growth;
            lpFees1 += _u128(lpFee);
            protocolFees1 += _u128(protocolFee);
        }
    }

    function _direction(address tokenIn) internal view returns (bool zeroForOne) {
        if (tokenIn == token0) return true;
        if (tokenIn == token1) return false;
        revert InvalidToken(tokenIn);
    }

    /// Tokens held beyond reserves and owed fees: the input of the current mint or swap.
    function _unaccounted() internal view returns (uint256 a0, uint256 a1) {
        a0 = IERC20(token0).balanceOf(address(this)) - reserve0 - lpFees0 - protocolFees0;
        a1 = IERC20(token1).balanceOf(address(this)) - reserve1 - lpFees1 - protocolFees1;
    }

    function _setReserves(uint256 r0, uint256 r1) internal {
        reserve0 = _u128(r0);
        reserve1 = _u128(r1);
        emit Sync(reserve0, reserve1);
    }

    function _spotPrice() internal view returns (uint256) {
        if (reserve0 == 0) return 0;
        return Math.mulDiv(reserve1, Q128, reserve0);
    }

    /// Volatility carried into, and price reference of, the window a swap now would fall in.
    function _windowStart() internal view returns (uint256 vRef, uint256 pRef) {
        uint256 dt = block.timestamp - lastSwapAt;
        if (dt >= _params.decayPeriod) return (0, _spotPrice());
        if (dt >= _params.filterPeriod) {
            return ((uint256(volatilityAccumulator) * _params.reductionBps) / BPS, _spotPrice());
        }
        return (volatilityReference, priceReference);
    }

    function _deviationBps(uint256 pRef) internal view returns (uint256) {
        uint256 p = _spotPrice();
        if (pRef == 0 || p == 0) return 0;
        uint256 diff = p > pRef ? p - pRef : pRef - p;
        return Math.mulDiv(diff, BPS, pRef);
    }

    function _feeFromVolatility(uint256 v) internal view returns (uint16) {
        v = Math.min(v, _params.maxVolatilityBps);
        uint256 f = _params.baseFeeBps + (v * _params.variableFeeControl) / BPS;
        return uint16(Math.min(f, _params.maxFeeBps));
    }

    function _settle(address account) internal {
        Checkpoint storage c = _checkpoints[account];
        uint256 bal = balanceOf(account);
        if (bal > 0) {
            c.owed0 += _u128(Math.mulDiv(bal, feeGrowth0 - c.growth0, Q128));
            c.owed1 += _u128(Math.mulDiv(bal, feeGrowth1 - c.growth1, Q128));
        }
        c.growth0 = feeGrowth0;
        c.growth1 = feeGrowth1;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0) && to != from) _settle(to);
        super._update(from, to, value);
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert Overflow();
        return uint128(x);
    }
}
