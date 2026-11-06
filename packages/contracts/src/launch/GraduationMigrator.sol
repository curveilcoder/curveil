// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DammFactory} from "../markets/DammFactory.sol";
import {DammPool} from "../markets/DammPool.sol";
import {AssetRegistry} from "../shared/AssetRegistry.sol";
import {AdmissionController} from "./AdmissionController.sol";
import {LaunchTemplateRegistry} from "./LaunchTemplateRegistry.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {LpEscrow} from "./LpEscrow.sol";
import {ILaunchFactory} from "./interfaces/ILaunch.sol";

/// @title GraduationMigrator
/// @notice Moves a graduated curve into its committed DAMM pool (whitepaper 11). It has no
///         owner and no settings: the destination, recipients and locks all come from the
///         launch's immutable template and curve. Every check below must pass or the whole
///         graduation reverts and the reserves stay in the curve.
///
///         Checks: the caller is a curve created by the LaunchFactory, the amounts handed over
///         price the token within the template's tolerance of the curve's final price, the
///         pool is the DAMM factory's pool for exactly (token, quote asset) and was empty, its
///         fee settings match the template, the LP minted reaches the minimum, and the escrow
///         received it.
contract GraduationMigrator {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    ILaunchFactory public immutable launchFactory;
    LaunchTemplateRegistry public immutable templates;
    DammFactory public immutable damm;
    AdmissionController public immutable admission;
    LpEscrow public immutable escrow;

    event Migrated(
        address indexed curve,
        address indexed token,
        address indexed pool,
        uint256 tokenAmount,
        uint256 quoteAmount,
        uint256 liquidity,
        uint256 creatorLockId,
        uint256 protocolLockId
    );

    event GiftsExceededMigration(address indexed pool, uint256 tokenGift, uint256 quoteGift);

    error NotCurve();
    error AmountMismatch();
    error PoolNotEmpty(address pool);
    error WrongPool(address pool);
    error FeeConfigMismatch();
    error PriceOutOfTolerance(uint256 poolPriceE36, uint256 curvePriceE36);
    error InsufficientLiquidity(uint256 minted, uint256 minimum);

    constructor(
        ILaunchFactory launchFactory_,
        LaunchTemplateRegistry templates_,
        DammFactory damm_,
        AdmissionController admission_,
        LpEscrow escrow_
    ) {
        launchFactory = launchFactory_;
        templates = templates_;
        damm = damm_;
        admission = admission_;
        escrow = escrow_;
    }

    function migrate(uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (address pool, uint256 liquidity, uint256 creatorLockId, uint256 protocolLockId)
    {
        if (!launchFactory.isCurve(msg.sender)) revert NotCurve();
        BondingCurve curve = BondingCurve(msg.sender);
        LaunchTemplateRegistry.Template memory t = templates.get(curve.templateId());
        (address token, address quote) = _checkInputs(curve, tokenAmount, quoteAmount, t.priceToleranceBps);
        pool = _destination(token, quote, t);
        liquidity = _deposit(pool, token, quote, tokenAmount, quoteAmount, t);
        (creatorLockId, protocolLockId) = _lock(pool, liquidity, curve.creatorRecipient(), t);
        emit Migrated(address(curve), token, pool, tokenAmount, quoteAmount, liquidity, creatorLockId, protocolLockId);
    }

    function _checkInputs(BondingCurve curve, uint256 tokenAmount, uint256 quoteAmount, uint16 tolBps)
        internal
        view
        returns (address token, address quote)
    {
        token = address(curve.token());
        quote = address(curve.quote());
        if (tokenAmount == 0 || quoteAmount == 0) revert AmountMismatch();
        if (
            IERC20(token).balanceOf(address(this)) < tokenAmount || IERC20(quote).balanceOf(address(this)) < quoteAmount
        ) {
            revert AmountMismatch();
        }
        _checkPrice(curve, tokenAmount, quoteAmount, tolBps);
    }

    /// Opens the pool at exactly the curve's final ratio. Tokens or quote someone sent to the
    /// (predictable) pool address beforehand are counted as part of the deposit, and the same
    /// amount is withheld: withheld tokens are burned and withheld quote goes to the protocol
    /// fee recipient. If gifts exceed the migration amounts the ratio cannot be restored; the
    /// pool then opens with everything and `GiftsExceededMigration` is emitted, rather than
    /// letting a transfer block graduation forever.
    function _deposit(
        address pool,
        address token,
        address quote,
        uint256 tokenAmount,
        uint256 quoteAmount,
        LaunchTemplateRegistry.Template memory t
    ) internal returns (uint256 liquidity) {
        uint256 giftT = IERC20(token).balanceOf(pool);
        uint256 giftQ = IERC20(quote).balanceOf(pool);
        uint256 sendT = tokenAmount;
        uint256 sendQ = quoteAmount;
        if (giftT <= tokenAmount && giftQ <= quoteAmount) {
            sendT -= giftT;
            sendQ -= giftQ;
            if (giftT > 0) IERC20(token).safeTransfer(DEAD, giftT);
            if (giftQ > 0) IERC20(quote).safeTransfer(t.protocolFeeRecipient, giftQ);
        } else {
            emit GiftsExceededMigration(pool, giftT, giftQ);
        }
        if (sendT > 0) IERC20(token).safeTransfer(pool, sendT);
        if (sendQ > 0) IERC20(quote).safeTransfer(pool, sendQ);
        liquidity = DammPool(pool).mint(address(escrow));
        uint256 minimum = Math.mulDiv(
            Math.sqrt((giftT + sendT) * (giftQ + sendQ)) - MINIMUM_LIQUIDITY, BPS - t.priceToleranceBps, BPS
        );
        if (liquidity < minimum) revert InsufficientLiquidity(liquidity, minimum);
    }

    function _destination(address token, address quote, LaunchTemplateRegistry.Template memory t)
        internal
        returns (address pool)
    {
        if (!admission.registry().isAdmitted(token)) admission.admitLaunchToken(token);
        pool = damm.getPool(token, quote);
        if (pool == address(0)) {
            pool = damm.createPool(token, quote, t.dammTier);
        } else if (DammPool(pool).totalSupply() != 0) {
            revert PoolNotEmpty(pool);
        }
        if (!damm.isPool(pool)) revert WrongPool(pool);
        (address t0, address t1) = DammPool(pool).tokens();
        if (!((t0 == token && t1 == quote) || (t0 == quote && t1 == token))) revert WrongPool(pool);
        DammPool.FeeParams memory fp = DammPool(pool).feeParams();
        if (fp.baseFeeBps != t.dammBaseFeeBps || fp.maxFeeBps != t.dammMaxFeeBps) revert FeeConfigMismatch();
    }

    function _checkPrice(BondingCurve curve, uint256 tokenAmount, uint256 quoteAmount, uint16 tolBps) internal view {
        (uint256 vBase, uint256 vQuote) = curve.virtualReserves();
        uint256 poolPrice = Math.mulDiv(quoteAmount, 1e36, tokenAmount);
        uint256 curvePrice = Math.mulDiv(vQuote, 1e36, vBase);
        uint256 diff = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
        if (diff * BPS > curvePrice * tolBps) revert PriceOutOfTolerance(poolPrice, curvePrice);
    }

    function _lock(address pool, uint256 liquidity, address creatorRecipient, LaunchTemplateRegistry.Template memory t)
        internal
        returns (uint256 creatorLockId, uint256 protocolLockId)
    {
        address[] memory who = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        uint64[] memory unlocks = new uint64[](2);
        who[0] = creatorRecipient;
        who[1] = t.protocolLpRecipient;
        amounts[0] = (liquidity * t.creatorLpBps) / BPS;
        amounts[1] = liquidity - amounts[0];
        unlocks[0] = uint64(block.timestamp) + t.creatorLockSeconds;
        unlocks[1] = uint64(block.timestamp) + t.protocolLockSeconds;
        uint256[] memory ids = escrow.createLocks(pool, who, amounts, unlocks);
        return (ids[0], ids[1]);
    }
}
