// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TransferHelper} from "../shared/TransferHelper.sol";
import {PerpEngine} from "./PerpEngine.sol";

/// @title PerpLiquidityVault
/// @notice The counterparty to every perps position, funded in USDG by liquidity providers who
///         hold vault shares. Traders' losses, the vault's part of trading fees and funding paid
///         by the larger side flow in; traders' gains flow out. Shares are priced at the vault's
///         net value, which counts open positions at the latest recorded oracle prices.
///
///         Payouts never exceed capacity: when a position opens, the engine reserves its
///         largest possible gain (its size times the market's profit cap), the total reserved
///         may not pass `maxUtilizationBps` of the vault's USDG, and providers can only withdraw
///         what is not reserved. New deposits are locked for `lockSeconds`.
contract PerpLiquidityVault is ERC20, Ownable2Step, ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    /// @dev Virtual shares (as in OpenZeppelin's ERC4626) make share-price inflation by donation
    ///      unprofitable. 1 USDG (6 decimals) mints 1e18 shares in an empty vault.
    uint256 private constant VIRTUAL_SHARES = 1e12;
    uint256 private constant TOKENS = 1e36;
    uint256 private constant ONE = 1e18;
    uint32 public constant MAX_LOCK = 30 days;

    IERC20 public immutable asset;
    PerpEngine public engine;
    uint16 public maxUtilizationBps;
    uint32 public lockSeconds;
    /// @notice Most USDG the vault accepts in deposits (zero: no cap).
    uint256 public depositCap;

    mapping(address account => uint64) public unlockAt;

    event EngineSet(address engine);
    event ParamsSet(uint16 maxUtilizationBps, uint32 lockSeconds, uint256 depositCap);
    event Deposited(address indexed account, uint256 assets, uint256 shares, uint256 navBefore);
    event Redeemed(address indexed owner, address indexed receiver, uint256 shares, uint256 assets, uint256 navBefore);
    event Paid(address indexed to, uint256 amount);

    error ZeroAddress();
    error EngineAlreadySet();
    error OnlyEngine();
    error BadConfig();
    error ZeroAmount();
    error Slippage();
    error Locked(uint256 until);
    error AboveDepositCap(uint256 cap);
    error InsufficientLiquidity(uint256 free);
    error StalePrice(uint32 market);

    constructor(IERC20 asset_, address owner_, uint16 maxUtilizationBps_, uint32 lockSeconds_, uint256 depositCap_)
        ERC20("Curveil Perps Liquidity", "cvPLP")
        Ownable(owner_)
    {
        if (address(asset_) == address(0)) revert ZeroAddress();
        asset = asset_;
        _setParams(maxUtilizationBps_, lockSeconds_, depositCap_);
    }

    // ---------------------------------------------------------------- providers

    /// @notice Deposits `assets` USDG for at least `minShares` shares, credited to the sender
    ///         (only to the sender, so nobody can extend someone else's lock).
    function deposit(uint256 assets, uint256 minShares) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 nav = totalAssets();
        if (depositCap != 0 && nav + assets > depositCap) revert AboveDepositCap(depositCap);
        shares = Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, nav + 1);
        if (shares == 0 || shares < minShares) revert Slippage();
        TransferHelper.pullExact(asset, msg.sender, assets);
        unlockAt[msg.sender] = uint64(block.timestamp + lockSeconds);
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, assets, shares, nav);
    }

    /// @notice Burns `shares` for at least `minAssets` USDG, sent to `receiver`. Only unreserved
    ///         USDG can leave; when too much is reserved, wait for positions to close.
    function redeem(uint256 shares, uint256 minAssets, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint64 until = unlockAt[msg.sender];
        if (block.timestamp < until) revert Locked(until);
        uint256 nav = totalAssets();
        assets = Math.mulDiv(shares, nav + 1, totalSupply() + VIRTUAL_SHARES);
        if (assets == 0 || assets < minAssets) revert Slippage();
        uint256 free = freeLiquidity();
        if (assets > free) revert InsufficientLiquidity(free);
        _burn(msg.sender, shares);
        TransferHelper.push(asset, receiver, assets);
        emit Redeemed(msg.sender, receiver, shares, assets, nav);
    }

    // ---------------------------------------------------------------- views

    /// @notice The vault's net value in USDG: its balance plus its unrealised result on open
    ///         positions (never below zero).
    function totalAssets() public view returns (uint256) {
        int256 nav = int256(asset.balanceOf(address(this))) + vaultPnl();
        return nav > 0 ? uint256(nav) : 0;
    }

    /// @notice The vault's unrealised result on open positions at the latest recorded oracle
    ///         prices: traders' losses and the funding they owe count for the vault, their gains
    ///         (capped per side at what is reserved) against it. Reverts when a market with open
    ///         interest has no price newer than the engine's `navMaxAge`, so shares are never
    ///         priced on a stale valuation.
    function vaultPnl() public view returns (int256 total) {
        PerpEngine e = engine;
        if (address(e) == address(0)) return 0;
        uint32[] memory ids = e.marketIds();
        uint256 maxAge = e.navMaxAge();
        for (uint256 i = 0; i < ids.length; i++) {
            PerpEngine.MarketState memory s = e.marketState(ids[i]);
            if (s.oiLong == 0 && s.oiShort == 0) continue;
            (uint256 price, uint256 ts) = e.oracle().latestPrice(e.marketConfig(ids[i]).feedId);
            if (price == 0 || ts + maxAge < block.timestamp) revert StalePrice(ids[i]);
            int256 d = int256(s.fundingRate) * int256(block.timestamp - s.fundingUpdatedAt);
            int256 traderLong = int256(Math.mulDiv(s.tokensLong, price, TOKENS)) - int256(uint256(s.oiLong))
                - ((s.fundingLong + d) * int256(uint256(s.oiLong)) - s.sizeFundingLong) / int256(ONE);
            int256 traderShort = int256(uint256(s.oiShort)) - int256(Math.mulDiv(s.tokensShort, price, TOKENS))
                - ((s.fundingShort - d) * int256(uint256(s.oiShort)) - s.sizeFundingShort) / int256(ONE);
            if (traderLong > int256(uint256(s.reservedLong))) traderLong = int256(uint256(s.reservedLong));
            if (traderShort > int256(uint256(s.reservedShort))) traderShort = int256(uint256(s.reservedShort));
            total -= traderLong + traderShort;
        }
    }

    /// @notice USDG that is not reserved for open positions.
    function freeLiquidity() public view returns (uint256) {
        uint256 balance = asset.balanceOf(address(this));
        uint256 reserved = address(engine) == address(0) ? 0 : engine.totalReserved();
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice The most the engine may have reserved in total.
    function capacity() external view returns (uint256) {
        return (asset.balanceOf(address(this)) * maxUtilizationBps) / BPS;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, totalAssets() + 1);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + 1, totalSupply() + VIRTUAL_SHARES);
    }

    // ---------------------------------------------------------------- engine

    /// @notice Pays a trader's gain (or a funding payment) out of the vault. The engine never
    ///         asks for more than the position's reserve, which `freeLiquidity` kept in place.
    function pay(address to, uint256 amount) external {
        if (msg.sender != address(engine)) revert OnlyEngine();
        TransferHelper.push(asset, to, amount);
        emit Paid(to, amount);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Links the engine, once.
    function setEngine(PerpEngine engine_) external onlyOwner {
        if (address(engine) != address(0)) revert EngineAlreadySet();
        if (address(engine_) == address(0)) revert ZeroAddress();
        engine = engine_;
        emit EngineSet(address(engine_));
    }

    function setParams(uint16 maxUtilizationBps_, uint32 lockSeconds_, uint256 depositCap_) external onlyOwner {
        _setParams(maxUtilizationBps_, lockSeconds_, depositCap_);
    }

    function _setParams(uint16 maxUtilizationBps_, uint32 lockSeconds_, uint256 depositCap_) private {
        if (maxUtilizationBps_ == 0 || maxUtilizationBps_ > BPS || lockSeconds_ > MAX_LOCK) revert BadConfig();
        maxUtilizationBps = maxUtilizationBps_;
        lockSeconds = lockSeconds_;
        depositCap = depositCap_;
        emit ParamsSet(maxUtilizationBps_, lockSeconds_, depositCap_);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @dev Locked shares cannot be moved, so the lock cannot be stepped around by transferring.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && block.timestamp < unlockAt[from]) revert Locked(unlockAt[from]);
        super._update(from, to, value);
    }
}
