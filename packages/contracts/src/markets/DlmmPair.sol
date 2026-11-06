// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICurveilPool, IPoolFactory} from "./interfaces/ICurveilPool.sol";
import {BinMath} from "./libraries/BinMath.sol";
import {BinBitmap} from "./libraries/BinBitmap.sol";

/// @title DlmmPair
/// @notice Discrete liquidity in price bins. Bin `id` trades at P(id) = (1 + binStep/10_000)^(id - 2^23),
///         quoted as raw units of Y per raw unit of X. Bins above the active bin hold only X,
///         bins below hold only Y, and the active bin may hold both.
/// @dev Shares are per bin and are never fungible across bins (whitepaper 5.3). LP fees stay
///      outside bin reserves and accrue per share only in the bins where trades happen.
///      Adding to the active bin is accepted only in the bin's current proportion, with the
///      excess refunded, so a deposit followed by a withdrawal can never act as a fee-free swap.
contract DlmmPair is ReentrancyGuard, ICurveilPool {
    using SafeERC20 for IERC20;
    using BinBitmap for BinBitmap.Tree;

    struct Bin {
        uint128 x;
        uint128 y;
        uint256 shares;
        uint256 growthX; // LP fee per share, Q128
        uint256 growthY;
    }

    struct Position {
        uint256 shares;
        uint256 growthX;
        uint256 growthY;
        uint128 owedX;
        uint128 owedY;
    }

    struct AddParams {
        address to; // owner of the new shares
        address refundTo; // receives any input not placed in bins
        uint24 activeIdExpected;
        uint24 idSlippage;
        int256[] deltaIds; // bin offsets from the active bin
        uint256[] distributionX; // share of the X input per bin, 1e18 = 100%
        uint256[] distributionY;
    }

    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PRECISION = 1e18;
    uint256 public constant MAX_BINS_PER_CALL = 101;
    uint256 public constant MAX_BIN_CROSSINGS = 128;

    address public immutable factory;
    address public immutable tokenX;
    address public immutable tokenY;
    uint16 public immutable binStep;
    uint16 public immutable baseFeeBps;
    uint16 public immutable protocolShareBps;

    uint24 public activeId;
    uint128 public reserveX; // sum of x over bins
    uint128 public reserveY;
    uint128 public lpFeesX; // unclaimed LP fees held by the pair
    uint128 public lpFeesY;
    uint128 public protocolFeesX;
    uint128 public protocolFeesY;

    mapping(uint24 id => Bin) internal _bins;
    mapping(uint24 id => mapping(address owner => Position)) internal _positions;
    BinBitmap.Tree internal _tree;

    event DepositedToBins(
        address indexed sender,
        address indexed to,
        uint256[] ids,
        uint256[] amountsX,
        uint256[] amountsY,
        uint256[] shares
    );
    event WithdrawnFromBins(
        address indexed owner,
        address indexed to,
        uint256[] ids,
        uint256[] amountsX,
        uint256[] amountsY,
        uint256[] shares
    );
    event Swap(
        address indexed sender,
        address indexed to,
        bool swapForY,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint256 protocolFee,
        uint24 activeIdBefore,
        uint24 activeIdAfter
    );
    event SharesTransferred(address indexed from, address indexed to, uint256[] ids, uint256[] shares);
    event FeesClaimed(address indexed owner, address indexed to, uint256 amountX, uint256 amountY);
    event ProtocolFeesCollected(address indexed to, uint256 amountX, uint256 amountY);

    error InvalidToken(address token);
    error InsufficientInput();
    error InsufficientOutput();
    error InsufficientLiquidity();
    error TooManyBins();
    error ActiveIdSlippage(uint24 expected, uint24 actual);
    error LengthMismatch();
    error InvalidDistribution();
    error IdOutOfRange(int256 id);
    error CompositionViolation(uint24 id);
    error ZeroShares(uint24 id);
    error InsufficientShares(uint24 id);
    error SlippageExceeded(uint256 amountX, uint256 amountY);
    error Expired();
    error Overflow();

    constructor(
        address tokenX_,
        address tokenY_,
        uint16 binStep_,
        uint16 baseFeeBps_,
        uint16 protocolShareBps_,
        uint24 activeId_
    ) {
        factory = msg.sender;
        tokenX = tokenX_;
        tokenY = tokenY_;
        binStep = binStep_;
        baseFeeBps = baseFeeBps_;
        protocolShareBps = protocolShareBps_;
        BinMath.getPrice(activeId_, binStep_); // reverts when out of range
        activeId = activeId_;
    }

    // ------------------------------------------------------------------ views

    function tokens() external view returns (address, address) {
        return (tokenX, tokenY);
    }

    function getBin(uint24 id) external view returns (Bin memory) {
        return _bins[id];
    }

    function getBins(uint24[] calldata ids) external view returns (Bin[] memory bins) {
        bins = new Bin[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            bins[i] = _bins[ids[i]];
        }
    }

    function getPosition(uint24 id, address owner) external view returns (Position memory) {
        return _positions[id][owner];
    }

    function getPrice(uint24 id) external view returns (uint256 priceQ128) {
        return BinMath.getPrice(id, binStep);
    }

    /// @notice Next bin holding liquidity strictly below (or above) `id`.
    function nextNonEmptyBin(bool below, uint24 id) external view returns (bool found, uint24 next) {
        return below ? _tree.nextBelow(id) : _tree.nextAbove(id);
    }

    function pendingFees(address owner, uint24[] calldata ids) external view returns (uint256 x, uint256 y) {
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = _positions[ids[i]][owner];
            Bin storage b = _bins[ids[i]];
            x += p.owedX + Math.mulDiv(p.shares, b.growthX - p.growthX, Q128);
            y += p.owedY + Math.mulDiv(p.shares, b.growthY - p.growthY, Q128);
        }
    }

    /// @notice Amounts that withdrawing `shares` from bin `id` would return now.
    function previewWithdraw(uint24 id, uint256 shares) public view returns (uint256 x, uint256 y) {
        Bin storage b = _bins[id];
        if (b.shares == 0) return (0, 0);
        x = Math.mulDiv(b.x, shares, b.shares);
        y = Math.mulDiv(b.y, shares, b.shares);
    }

    function quote(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut, uint256 fee) {
        bool swapForY = _direction(tokenIn);
        SwapState memory s = _simulate(swapForY, amountIn);
        return (s.amountOut, s.fee);
    }

    // ------------------------------------------------------------------ liquidity

    function addLiquidity(AddParams calldata p)
        external
        nonReentrant
        returns (uint256 usedX, uint256 usedY, uint256[] memory ids, uint256[] memory minted)
    {
        uint256 n = p.deltaIds.length;
        if (n == 0 || n > MAX_BINS_PER_CALL || p.distributionX.length != n || p.distributionY.length != n) {
            revert LengthMismatch();
        }
        uint24 active = activeId;
        uint256 diff = active > p.activeIdExpected ? active - p.activeIdExpected : p.activeIdExpected - active;
        if (diff > p.idSlippage) revert ActiveIdSlippage(p.activeIdExpected, active);

        (uint256 amountX, uint256 amountY) = _unaccounted();
        AddResult memory r = _depositAll(p, active, amountX, amountY);
        usedX = r.usedX;
        usedY = r.usedY;

        reserveX = _u128(uint256(reserveX) + usedX);
        reserveY = _u128(uint256(reserveY) + usedY);
        if (amountX > usedX) IERC20(tokenX).safeTransfer(p.refundTo, amountX - usedX);
        if (amountY > usedY) IERC20(tokenY).safeTransfer(p.refundTo, amountY - usedY);

        emit DepositedToBins(msg.sender, p.to, r.ids, r.amountsX, r.amountsY, r.minted);
        return (usedX, usedY, r.ids, r.minted);
    }

    function removeLiquidity(
        address to,
        uint24[] calldata ids,
        uint256[] calldata shares,
        uint256 minX,
        uint256 minY,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountX, uint256 amountY) {
        if (block.timestamp > deadline) revert Expired();
        if (ids.length == 0 || ids.length > MAX_BINS_PER_CALL || shares.length != ids.length) revert LengthMismatch();
        AddResult memory r = _withdrawAll(ids, shares);
        amountX = r.usedX;
        amountY = r.usedY;
        if (amountX < minX || amountY < minY) revert SlippageExceeded(amountX, amountY);
        reserveX -= uint128(amountX);
        reserveY -= uint128(amountY);
        if (amountX > 0) IERC20(tokenX).safeTransfer(to, amountX);
        if (amountY > 0) IERC20(tokenY).safeTransfer(to, amountY);
        emit WithdrawnFromBins(msg.sender, to, r.ids, r.amountsX, r.amountsY, r.minted);
    }

    function claimFees(address to, uint24[] calldata ids) external nonReentrant returns (uint256 x, uint256 y) {
        for (uint256 i; i < ids.length; ++i) {
            Position storage pos = _positions[ids[i]][msg.sender];
            _settle(pos, _bins[ids[i]]);
            x += pos.owedX;
            y += pos.owedY;
            pos.owedX = 0;
            pos.owedY = 0;
        }
        lpFeesX -= uint128(x);
        lpFeesY -= uint128(y);
        if (x > 0) IERC20(tokenX).safeTransfer(to, x);
        if (y > 0) IERC20(tokenY).safeTransfer(to, y);
        emit FeesClaimed(msg.sender, to, x, y);
    }

    /// @notice Moves bin shares (with their future fees) to another owner. Fees earned so far stay with the sender.
    function transferShares(address to, uint24[] calldata ids, uint256[] calldata shares) external nonReentrant {
        if (ids.length != shares.length) revert LengthMismatch();
        uint256[] memory outIds = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            Bin storage b = _bins[ids[i]];
            Position storage from = _positions[ids[i]][msg.sender];
            Position storage dest = _positions[ids[i]][to];
            _settle(from, b);
            _settle(dest, b);
            if (shares[i] > from.shares) revert InsufficientShares(ids[i]);
            from.shares -= shares[i];
            dest.shares += shares[i];
            outIds[i] = ids[i];
        }
        emit SharesTransferred(msg.sender, to, outIds, shares);
    }

    function collectProtocolFees() external nonReentrant returns (uint256 x, uint256 y) {
        address to = IPoolFactory(factory).feeTo();
        x = protocolFeesX;
        y = protocolFeesY;
        protocolFeesX = 0;
        protocolFeesY = 0;
        if (x > 0) IERC20(tokenX).safeTransfer(to, x);
        if (y > 0) IERC20(tokenY).safeTransfer(to, y);
        emit ProtocolFeesCollected(to, x, y);
    }

    // ------------------------------------------------------------------ swap

    struct SwapState {
        uint24 id;
        uint256 remaining;
        uint256 amountOut;
        uint256 netIn;
        uint256 fee;
        uint256 protocolFee;
    }

    function swap(address tokenIn, address to) external nonReentrant returns (uint256 amountOut) {
        bool swapForY = _direction(tokenIn);
        (uint256 ux, uint256 uy) = _unaccounted();
        uint256 amountIn = swapForY ? ux : uy;
        if (amountIn == 0) revert InsufficientInput();
        uint24 before = activeId;

        SwapState memory s = _executeSwap(swapForY, amountIn);
        amountOut = s.amountOut;
        if (amountOut == 0) revert InsufficientOutput();

        uint256 lpFee = s.fee - s.protocolFee;
        activeId = s.id;
        if (swapForY) {
            reserveX = _u128(uint256(reserveX) + s.netIn);
            reserveY -= uint128(amountOut);
            lpFeesX += _u128(lpFee);
            protocolFeesX += _u128(s.protocolFee);
            IERC20(tokenY).safeTransfer(to, amountOut);
        } else {
            reserveY = _u128(uint256(reserveY) + s.netIn);
            reserveX -= uint128(amountOut);
            lpFeesY += _u128(lpFee);
            protocolFeesY += _u128(s.protocolFee);
            IERC20(tokenX).safeTransfer(to, amountOut);
        }
        emit Swap(msg.sender, to, swapForY, amountIn, amountOut, s.fee, s.protocolFee, before, s.id);
    }

    // ------------------------------------------------------------------ internals

    /// Walks bins from the active one without writing. Swaps run the same steps through
    /// `_executeSwap`, and each step only changes the bin it reads, so a quote always equals
    /// the swap executed against the same state.
    function _simulate(bool swapForY, uint256 amountIn) internal view returns (SwapState memory s) {
        s.id = activeId;
        s.remaining = amountIn;
        uint256 crossings;
        while (true) {
            Bin storage b = _bins[s.id];
            uint256 avail = swapForY ? b.y : b.x;
            if (avail > 0) _step(b, s, swapForY, avail);
            if (s.remaining == 0) break;
            s.id = _next(swapForY, s.id, ++crossings);
        }
    }

    function _executeSwap(bool swapForY, uint256 amountIn) internal returns (SwapState memory s) {
        s.id = activeId;
        s.remaining = amountIn;
        uint256 crossings;
        while (true) {
            Bin storage b = _bins[s.id];
            uint256 avail = swapForY ? b.y : b.x;
            if (avail > 0) {
                (uint256 net, uint256 out, uint256 lpFee) = _step(b, s, swapForY, avail);
                uint256 growth = Math.mulDiv(lpFee, Q128, b.shares);
                if (swapForY) {
                    b.x = _u128(uint256(b.x) + net);
                    b.y = uint128(uint256(b.y) - out);
                    b.growthX += growth;
                } else {
                    b.y = _u128(uint256(b.y) + net);
                    b.x = uint128(uint256(b.x) - out);
                    b.growthY += growth;
                }
            }
            if (s.remaining == 0) break;
            s.id = _next(swapForY, s.id, ++crossings);
        }
    }

    function _next(bool swapForY, uint24 id, uint256 crossings) internal view returns (uint24 next) {
        bool found;
        (found, next) = swapForY ? _tree.nextBelow(id) : _tree.nextAbove(id);
        if (!found) revert InsufficientLiquidity();
        if (crossings > MAX_BIN_CROSSINGS) revert TooManyBins();
    }

    /// One bin's share of a swap. Rounds every amount against the trader.
    function _step(Bin storage b, SwapState memory s, bool swapForY, uint256 avail)
        internal
        view
        returns (uint256 net, uint256 out, uint256 lpFee)
    {
        uint256 price = BinMath.getPrice(s.id, binStep);
        // Net input that empties this bin of the output token.
        uint256 maxNet = swapForY
            ? Math.mulDiv(avail, Q128, price, Math.Rounding.Ceil)
            : Math.mulDiv(avail, price, Q128, Math.Rounding.Ceil);
        uint256 maxGross = Math.mulDiv(maxNet, BPS, BPS - baseFeeBps, Math.Rounding.Ceil);

        uint256 gross;
        if (s.remaining >= maxGross) {
            gross = maxGross;
            net = maxNet;
            out = avail;
        } else {
            gross = s.remaining;
            net = gross - Math.mulDiv(gross, baseFeeBps, BPS, Math.Rounding.Ceil);
            out = swapForY ? Math.mulDiv(net, price, Q128) : Math.mulDiv(net, Q128, price);
            if (out > avail) out = avail;
        }
        uint256 fee = gross - net;
        uint256 pFee = (fee * protocolShareBps) / BPS;
        // A bin with liquidity always has shares; the guard keeps fee routing total either way.
        if (b.shares == 0) pFee = fee;
        lpFee = fee - pFee;

        s.remaining -= gross;
        s.amountOut += out;
        s.netIn += net;
        s.fee += fee;
        s.protocolFee += pFee;
    }

    struct AddResult {
        uint256[] ids;
        uint256[] amountsX;
        uint256[] amountsY;
        uint256[] minted;
        uint256 usedX;
        uint256 usedY;
        uint256 availX;
        uint256 availY;
    }

    function _depositAll(AddParams calldata p, uint24 active, uint256 amountX, uint256 amountY)
        internal
        returns (AddResult memory r)
    {
        uint256 n = p.deltaIds.length;
        uint256 sumX;
        uint256 sumY;
        for (uint256 i; i < n; ++i) {
            sumX += p.distributionX[i];
            sumY += p.distributionY[i];
        }
        if (sumX > PRECISION || sumY > PRECISION) revert InvalidDistribution();
        r.ids = new uint256[](n);
        r.amountsX = new uint256[](n);
        r.amountsY = new uint256[](n);
        r.minted = new uint256[](n);
        r.availX = amountX;
        r.availY = amountY;
        for (uint256 i; i < n; ++i) {
            _depositAt(p, i, active, r);
        }
    }

    function _depositAt(AddParams calldata p, uint256 i, uint24 active, AddResult memory r) internal {
        uint24 id = _binId(active, p.deltaIds[i]);
        (uint256 x, uint256 y, uint256 m) = _deposit(
            id,
            active,
            p.to,
            Math.mulDiv(r.availX, p.distributionX[i], PRECISION),
            Math.mulDiv(r.availY, p.distributionY[i], PRECISION)
        );
        r.ids[i] = id;
        r.amountsX[i] = x;
        r.amountsY[i] = y;
        r.minted[i] = m;
        r.usedX += x;
        r.usedY += y;
    }

    /// Reuses AddResult: `minted` holds the shares burned.
    function _withdrawAll(uint24[] calldata ids, uint256[] calldata shares) internal returns (AddResult memory r) {
        uint256 n = ids.length;
        r.ids = new uint256[](n);
        r.amountsX = new uint256[](n);
        r.amountsY = new uint256[](n);
        r.minted = shares;
        for (uint256 i; i < n; ++i) {
            r.ids[i] = ids[i];
            (r.amountsX[i], r.amountsY[i]) = _withdraw(ids[i], msg.sender, shares[i]);
            r.usedX += r.amountsX[i];
            r.usedY += r.amountsY[i];
        }
    }

    function _binId(uint24 active, int256 delta) internal pure returns (uint24) {
        int256 raw = int256(uint256(active)) + delta;
        if (raw < 0 || raw > int256(uint256(type(uint24).max))) revert IdOutOfRange(raw);
        return uint24(uint256(raw));
    }

    function _deposit(uint24 id, uint24 active, address to, uint256 x, uint256 y)
        internal
        returns (uint256, uint256, uint256 minted)
    {
        if (id > active && y != 0) revert CompositionViolation(id);
        if (id < active && x != 0) revert CompositionViolation(id);
        Bin storage b = _bins[id];
        if (id == active && b.shares != 0) (x, y) = _matchProportion(b, x, y);
        if (x == 0 && y == 0) return (0, 0, 0);

        minted = _sharesFor(b, id, x, y);
        Position storage pos = _positions[id][to];
        _settle(pos, b);
        pos.shares += minted;
        if (b.shares == 0) _tree.add(id);
        b.shares += minted;
        b.x = _u128(uint256(b.x) + x);
        b.y = _u128(uint256(b.y) + y);
        return (x, y, minted);
    }

    /// Largest deposit in the active bin's current proportion; the remainder is refunded.
    function _matchProportion(Bin storage b, uint256 x, uint256 y) internal view returns (uint256, uint256) {
        uint256 bx = b.x;
        uint256 by = b.y;
        if (bx == 0) return (0, y);
        if (by == 0) return (x, 0);
        if (x * by > y * bx) return (Math.mulDiv(y, bx, by), y);
        return (x, Math.mulDiv(x, by, bx));
    }

    function _sharesFor(Bin storage b, uint24 id, uint256 x, uint256 y) internal view returns (uint256 minted) {
        uint256 price = BinMath.getPrice(id, binStep);
        uint256 value = BinMath.liquidity(x, y, price);
        uint256 binValue = BinMath.liquidity(b.x, b.y, price);
        minted = (b.shares == 0 || binValue == 0) ? value : Math.mulDiv(value, b.shares, binValue);
        if (minted == 0) revert ZeroShares(id);
    }

    function _withdraw(uint24 id, address owner, uint256 shares) internal returns (uint256 x, uint256 y) {
        Bin storage b = _bins[id];
        Position storage pos = _positions[id][owner];
        _settle(pos, b);
        if (shares == 0 || shares > pos.shares) revert InsufficientShares(id);
        x = Math.mulDiv(b.x, shares, b.shares);
        y = Math.mulDiv(b.y, shares, b.shares);
        pos.shares -= shares;
        b.shares -= shares;
        b.x -= uint128(x);
        b.y -= uint128(y);
        // The last withdrawal takes the whole bin (shares == b.shares), so an unowned bin is empty.
        if (b.shares == 0) _tree.remove(id);
    }

    function _settle(Position storage pos, Bin storage b) internal {
        if (pos.shares > 0) {
            pos.owedX += _u128(Math.mulDiv(pos.shares, b.growthX - pos.growthX, Q128));
            pos.owedY += _u128(Math.mulDiv(pos.shares, b.growthY - pos.growthY, Q128));
        }
        pos.growthX = b.growthX;
        pos.growthY = b.growthY;
    }

    function _direction(address tokenIn) internal view returns (bool swapForY) {
        if (tokenIn == tokenX) return true;
        if (tokenIn == tokenY) return false;
        revert InvalidToken(tokenIn);
    }

    function _unaccounted() internal view returns (uint256 x, uint256 y) {
        x = IERC20(tokenX).balanceOf(address(this)) - reserveX - lpFeesX - protocolFeesX;
        y = IERC20(tokenY).balanceOf(address(this)) - reserveY - lpFeesY - protocolFeesY;
    }

    function _u128(uint256 v) internal pure returns (uint128) {
        if (v > type(uint128).max) revert Overflow();
        return uint128(v);
    }
}
