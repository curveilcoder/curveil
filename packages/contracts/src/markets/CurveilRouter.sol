// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICurveilPool} from "./interfaces/ICurveilPool.sol";
import {DammFactory} from "./DammFactory.sol";
import {DammPool} from "./DammPool.sol";
import {DlmmFactory} from "./DlmmFactory.sol";
import {DlmmPair} from "./DlmmPair.sol";

/// @title CurveilRouter
/// @notice Routes exact-input swaps across DAMM pools and DLMM pairs (direct or multi-hop) and
///         wraps DAMM and DLMM deposits. Holds no funds between calls: tokens move from the user
///         straight into the first pool, and each hop pays the next pool directly.
/// @dev Every pool on a path must come from one of the two factories, so a path cannot route
///      through a contract that only claims to be a pool.
contract CurveilRouter {
    using SafeERC20 for IERC20;

    struct Hop {
        address pool;
        address tokenIn;
        address tokenOut;
    }

    struct DammDeposit {
        address tokenA;
        address tokenB;
        uint256 amountADesired;
        uint256 amountBDesired;
        uint256 amountAMin;
        uint256 amountBMin;
        address to;
        uint256 deadline;
    }

    struct DlmmDeposit {
        address pair;
        uint256 amountX;
        uint256 amountY;
        uint24 activeIdExpected;
        uint24 idSlippage;
        int256[] deltaIds;
        uint256[] distributionX;
        uint256[] distributionY;
        address to;
        uint256 deadline;
    }

    uint256 public constant MAX_HOPS = 3;

    DammFactory public immutable damm;
    DlmmFactory public immutable dlmm;

    error Expired();
    error InvalidPath();
    error UnknownPool(address pool);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error PoolMissing(address tokenA, address tokenB);
    error InsufficientAmount(address token);

    constructor(DammFactory damm_, DlmmFactory dlmm_) {
        damm = damm_;
        dlmm = dlmm_;
    }

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ------------------------------------------------------------------ swaps

    function swapExactIn(Hop[] calldata hops, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        ensure(deadline)
        returns (uint256 amountOut)
    {
        _checkPath(hops);
        uint256 n = hops.length;
        IERC20(hops[0].tokenIn).safeTransferFrom(msg.sender, hops[0].pool, amountIn);
        for (uint256 i; i < n; ++i) {
            address recipient = i + 1 < n ? hops[i + 1].pool : to;
            amountOut = ICurveilPool(hops[i].pool).swap(hops[i].tokenIn, recipient);
        }
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
    }

    /// @return amountOut Expected output against current state.
    /// @return fees Fee charged at each hop, in that hop's input token.
    function quoteExactIn(Hop[] calldata hops, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256[] memory fees)
    {
        _checkPath(hops);
        fees = new uint256[](hops.length);
        amountOut = amountIn;
        for (uint256 i; i < hops.length; ++i) {
            (amountOut, fees[i]) = ICurveilPool(hops[i].pool).quote(hops[i].tokenIn, amountOut);
        }
    }

    function isKnownPool(address pool) public view returns (bool) {
        return damm.isPool(pool) || dlmm.isPool(pool);
    }

    // ------------------------------------------------------------------ DAMM liquidity

    function addLiquidityDamm(DammDeposit calldata d)
        external
        ensure(d.deadline)
        returns (uint256 amountA, uint256 amountB, uint256 liquidity)
    {
        address pool = damm.getPool(d.tokenA, d.tokenB);
        if (pool == address(0)) revert PoolMissing(d.tokenA, d.tokenB);
        (amountA, amountB) = _optimal(pool, d);
        IERC20(d.tokenA).safeTransferFrom(msg.sender, pool, amountA);
        IERC20(d.tokenB).safeTransferFrom(msg.sender, pool, amountB);
        liquidity = DammPool(pool).mint(d.to);
    }

    /// @notice Burns LP shares. Fees already earned stay claimable from the pool by the LP.
    function removeLiquidityDamm(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pool = damm.getPool(tokenA, tokenB);
        if (pool == address(0)) revert PoolMissing(tokenA, tokenB);
        IERC20(pool).safeTransferFrom(msg.sender, pool, liquidity);
        (uint256 a0, uint256 a1) = DammPool(pool).burn(to);
        (amountA, amountB) = tokenA == DammPool(pool).token0() ? (a0, a1) : (a1, a0);
        if (amountA < amountAMin) revert InsufficientAmount(tokenA);
        if (amountB < amountBMin) revert InsufficientAmount(tokenB);
    }

    // ------------------------------------------------------------------ DLMM liquidity

    /// @notice Deposits into DLMM bins. Input not placed in bins is refunded to the caller.
    ///         Withdrawals and fee claims go to the pair directly, by the share owner.
    function addLiquidityDlmm(DlmmDeposit calldata d)
        external
        ensure(d.deadline)
        returns (uint256 usedX, uint256 usedY, uint256[] memory ids, uint256[] memory minted)
    {
        if (!dlmm.isPool(d.pair)) revert UnknownPool(d.pair);
        DlmmPair pair = DlmmPair(d.pair);
        if (d.amountX > 0) IERC20(pair.tokenX()).safeTransferFrom(msg.sender, d.pair, d.amountX);
        if (d.amountY > 0) IERC20(pair.tokenY()).safeTransferFrom(msg.sender, d.pair, d.amountY);
        return pair.addLiquidity(
            DlmmPair.AddParams({
                to: d.to,
                refundTo: msg.sender,
                activeIdExpected: d.activeIdExpected,
                idSlippage: d.idSlippage,
                deltaIds: d.deltaIds,
                distributionX: d.distributionX,
                distributionY: d.distributionY
            })
        );
    }

    // ------------------------------------------------------------------ internals

    function _checkPath(Hop[] calldata hops) internal view {
        uint256 n = hops.length;
        if (n == 0 || n > MAX_HOPS) revert InvalidPath();
        for (uint256 i; i < n; ++i) {
            Hop calldata h = hops[i];
            if (!isKnownPool(h.pool)) revert UnknownPool(h.pool);
            (address a, address b) = ICurveilPool(h.pool).tokens();
            bool ok = (h.tokenIn == a && h.tokenOut == b) || (h.tokenIn == b && h.tokenOut == a);
            if (!ok) revert InvalidPath();
            if (i > 0 && hops[i - 1].tokenOut != h.tokenIn) revert InvalidPath();
        }
    }

    function _optimal(address pool, DammDeposit calldata d) internal view returns (uint256 amountA, uint256 amountB) {
        (uint128 r0, uint128 r1) = DammPool(pool).getReserves();
        (uint256 rA, uint256 rB) = d.tokenA == DammPool(pool).token0() ? (r0, r1) : (r1, r0);
        if (rA == 0 && rB == 0) return (d.amountADesired, d.amountBDesired);
        uint256 bOptimal = (d.amountADesired * rB) / rA;
        if (bOptimal <= d.amountBDesired) {
            if (bOptimal < d.amountBMin) revert InsufficientAmount(d.tokenB);
            return (d.amountADesired, bOptimal);
        }
        uint256 aOptimal = (d.amountBDesired * rA) / rB;
        if (aOptimal < d.amountAMin) revert InsufficientAmount(d.tokenA);
        return (aOptimal, d.amountBDesired);
    }
}
