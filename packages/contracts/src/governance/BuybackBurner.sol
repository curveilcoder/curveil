// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DammPool} from "../markets/DammPool.sol";

/// @title BuybackBurner
/// @notice Buys CURVEIL with USDG in disclosed tranches and burns what it buys (whitepaper
///         section 18). Each tranche swaps through the CURVEIL/USDG DAMM pool, refuses more
///         than `MAX_IMPACT_BPS` of quoted price impact, and sends the purchase straight to the
///         burn address, so bought tokens never sit anywhere they could be spent.
/// @dev The CURVEIL token launches through the standard Launch template, which has no burn
///      function (its supply is fixed by design). A burn is therefore a transfer to the dead
///      address: circulating supply = totalSupply - balanceOf(DEAD), and every tranche emits
///      `Burned` with the running total. The owner (the timelock) binds the token and pool once,
///      after the token exists; the operator (the Safe) runs tranches without the delay, since
///      the cap and the burn destination are fixed in code.
contract BuybackBurner is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_IMPACT_BPS = 100; // 1% quoted price impact
    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdg;
    IERC20 public token;
    DammPool public pool;
    address public operator;
    uint256 public totalSpent;
    uint256 public totalBurned;
    uint256 public tranches;

    event Bound(address indexed token, address indexed pool);
    event OperatorSet(address indexed operator);
    event Burned(uint256 indexed tranche, uint256 usdgIn, uint256 tokensBurned, uint256 impactBps, uint256 totalBurned);
    event Returned(address indexed to, uint256 amount, string memo);

    error ZeroAddress();
    error AlreadyBound();
    error NotBound();
    error NotOperator();
    error WrongPool();
    error Expired();
    error ImpactTooHigh(uint256 impactBps);
    error Slippage(uint256 out, uint256 minOut);
    error ZeroAmount();

    constructor(IERC20 usdg_, address owner_, address operator_) Ownable(owner_) {
        if (address(usdg_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        operator = operator_;
        emit OperatorSet(operator_);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    // ---------------------------------------------------------------- owner (timelock)

    /// @notice Binds the CURVEIL token and its USDG pool. Once only.
    function bind(IERC20 token_, DammPool pool_) external onlyOwner {
        if (address(token) != address(0)) revert AlreadyBound();
        if (address(token_) == address(0) || address(pool_) == address(0)) revert ZeroAddress();
        (address t0, address t1) = (pool_.token0(), pool_.token1());
        bool ok = (t0 == address(token_) && t1 == address(usdg)) || (t1 == address(token_) && t0 == address(usdg));
        if (!ok) revert WrongPool();
        token = token_;
        pool = pool_;
        emit Bound(address(token_), address(pool_));
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Returns unspent USDG, for example to the treasury if the programme changes.
    function returnUsdg(address to, uint256 amount, string calldata memo) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        usdg.safeTransfer(to, amount);
        emit Returned(to, amount, memo);
    }

    // ---------------------------------------------------------------- operator (Safe)

    /// @notice Spends `usdgIn` on CURVEIL and burns all of it. Reverts above 1% quoted price
    ///         impact, below `minOut`, or after `deadline`.
    function buyback(uint256 usdgIn, uint256 minOut, uint256 deadline)
        external
        onlyOperator
        nonReentrant
        returns (uint256 burned)
    {
        if (block.timestamp > deadline) revert Expired();
        if (usdgIn == 0) revert ZeroAmount();
        DammPool p = pool;
        if (address(p) == address(0)) revert NotBound();
        uint256 impact = impactBps(usdgIn);
        if (impact > MAX_IMPACT_BPS) revert ImpactTooHigh(impact);

        uint256 before = token.balanceOf(DEAD);
        usdg.safeTransfer(address(p), usdgIn);
        p.swap(address(usdg), DEAD);
        burned = token.balanceOf(DEAD) - before;
        if (burned < minOut) revert Slippage(burned, minOut);

        totalSpent += usdgIn;
        totalBurned += burned;
        emit Burned(++tranches, usdgIn, burned, impact, totalBurned);
    }

    /// @notice Burns CURVEIL this contract holds (for example tokens sent to it directly).
    function burnHeld() external onlyOperator nonReentrant returns (uint256 amount) {
        if (address(token) == address(0)) revert NotBound();
        amount = token.balanceOf(address(this));
        if (amount == 0) revert ZeroAmount();
        token.safeTransfer(DEAD, amount);
        totalBurned += amount;
        emit Burned(++tranches, 0, amount, 0, totalBurned);
    }

    // ---------------------------------------------------------------- views

    /// @notice Quoted price impact of spending `usdgIn` now, in bps, with the pool fee left out:
    ///         how far the quote falls short of the same amount at the pool's current price.
    function impactBps(uint256 usdgIn) public view returns (uint256) {
        DammPool p = pool;
        if (address(p) == address(0)) revert NotBound();
        (uint256 out, uint256 fee) = p.quote(address(usdg), usdgIn);
        (uint128 r0, uint128 r1) = p.getReserves();
        (uint256 rIn, uint256 rOut) = p.token0() == address(usdg) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 atSpot = ((usdgIn - fee) * rOut) / rIn;
        if (atSpot == 0 || out >= atSpot) return 0;
        return ((atSpot - out) * BPS + atSpot - 1) / atSpot;
    }

    /// @notice CURVEIL out of circulation: everything held by the burn address.
    function burnedSupply() external view returns (uint256) {
        return address(token) == address(0) ? 0 : token.balanceOf(DEAD);
    }
}
