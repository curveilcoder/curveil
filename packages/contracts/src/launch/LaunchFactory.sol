// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Guarded} from "../shared/Guarded.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TransferHelper} from "../shared/TransferHelper.sol";
import {LaunchTemplateRegistry} from "./LaunchTemplateRegistry.sol";
import {CurveilLaunchToken} from "./CurveilLaunchToken.sol";
import {BondingCurve} from "./BondingCurve.sol";

interface ILaunchpadRegistry {
    /// Whether `operator` may run launches on `templateId`, and its share of the protocol fee.
    function operatorTerms(address operator, uint256 templateId) external view returns (bool allowed, uint16 shareBps);
}

/// @title LaunchFactory
/// @notice Creates a fixed-supply token and its bonding curve from an enabled template
///         (whitepaper 10.2). The whole supply goes to the curve: curve inventory for sale and
///         migration inventory for the DAMM pool. Nothing is reserved for the creator; a
///         creator who wants tokens buys them on the curve like everyone else, optionally in
///         the creation transaction.
/// @dev The guardian or owner can pause new launches; only the owner can resume them. The
///      owner sets the migrator once. Neither can touch a live launch, its token or its reserves.
contract LaunchFactory is Guarded, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct CreateParams {
        uint256 templateId;
        string name;
        string symbol;
        string metadataURI;
        address creatorRecipient;
        address operator;
        uint256 initialBuy;
        uint256 minTokensOut;
        uint256 deadline;
    }

    LaunchTemplateRegistry public immutable templates;
    address public migrator;
    /// Launchpad operator registry (Phase 6). Unset means launches have no operator.
    ILaunchpadRegistry public launchpads;
    bool public creationPaused;

    mapping(address token => address curve) public curveOf;
    mapping(address curve => bool) public isCurve;
    address[] public allTokens;
    uint256 internal _nonce;

    event LaunchCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        uint256 templateId,
        string name,
        string symbol,
        string metadataURI,
        address creatorRecipient
    );
    event MigratorSet(address migrator);
    event CreationPaused(bool paused);
    event LaunchpadsSet(address launchpads);

    error TemplateDisabled(uint256 id);
    error Paused();
    error MigratorNotSet();
    error MigratorAlreadySet();
    error InvalidName();
    error InvalidSymbol();
    error InvalidURI();
    error ZeroAddress();
    error OperatorNotAllowed(address operator);

    constructor(address initialOwner, LaunchTemplateRegistry templates_) Ownable(initialOwner) {
        templates = templates_;
    }

    function setMigrator(address migrator_) external onlyOwner {
        if (migrator != address(0)) revert MigratorAlreadySet();
        if (migrator_ == address(0)) revert ZeroAddress();
        migrator = migrator_;
        emit MigratorSet(migrator_);
    }

    function setCreationPaused(bool paused) external {
        _checkStop(paused);
        creationPaused = paused;
        emit CreationPaused(paused);
    }

    /// Affects only launches created afterwards.
    function setLaunchpads(ILaunchpadRegistry launchpads_) external onlyOwner {
        launchpads = launchpads_;
        emit LaunchpadsSet(address(launchpads_));
    }

    function isLaunchToken(address token) external view returns (bool) {
        return curveOf[token] != address(0);
    }

    function launchCount() external view returns (uint256) {
        return allTokens.length;
    }

    function createLaunch(CreateParams calldata p) external nonReentrant returns (address token, address curve) {
        if (creationPaused) revert Paused();
        if (migrator == address(0)) revert MigratorNotSet();
        if (!templates.enabled(p.templateId)) revert TemplateDisabled(p.templateId);
        if (p.creatorRecipient == address(0)) revert ZeroAddress();
        _checkText(p.name, p.symbol, p.metadataURI);
        LaunchTemplateRegistry.Template memory t = templates.get(p.templateId);

        curve = address(new BondingCurve(_config(p, t)));
        token = address(
            new CurveilLaunchToken{salt: keccak256(abi.encode(msg.sender, _nonce++))}(
                p.name, p.symbol, p.metadataURI, t.totalSupply, curve
            )
        );
        BondingCurve(curve).bindToken(token);
        curveOf[token] = curve;
        isCurve[curve] = true;
        allTokens.push(token);
        emit LaunchCreated(token, curve, msg.sender, p.templateId, p.name, p.symbol, p.metadataURI, p.creatorRecipient);

        if (p.initialBuy > 0) _initialBuy(p, IERC20(t.quoteAsset), curve);
    }

    function _config(CreateParams calldata p, LaunchTemplateRegistry.Template memory t)
        internal
        view
        returns (BondingCurve.Config memory c)
    {
        c.quote = t.quoteAsset;
        c.migrator = migrator;
        c.creator = msg.sender;
        c.creatorRecipient = p.creatorRecipient;
        c.protocolFeeRecipient = t.protocolFeeRecipient;
        c.templateId = p.templateId;
        c.curveSupply = t.curveSupply;
        c.graduationThreshold = t.graduationThreshold;
        c.virtualBase = t.virtualBase;
        c.virtualQuote = t.virtualQuote;
        c.feeBps = t.feeBps;
        c.creatorFeeShareBps = t.creatorFeeShareBps;
        if (p.operator != address(0)) {
            if (address(launchpads) == address(0)) revert OperatorNotAllowed(p.operator);
            (bool allowed, uint16 shareBps) = launchpads.operatorTerms(p.operator, p.templateId);
            if (!allowed || shareBps > 10_000) revert OperatorNotAllowed(p.operator);
            c.operator = p.operator;
            c.operatorShareBps = shareBps;
        }
    }

    function _initialBuy(CreateParams calldata p, IERC20 quote, address curve) internal {
        TransferHelper.pullExact(quote, msg.sender, p.initialBuy);
        quote.forceApprove(curve, p.initialBuy);
        (, uint256 used) = BondingCurve(curve).buy(p.initialBuy, p.minTokensOut, msg.sender, p.deadline);
        quote.forceApprove(curve, 0);
        if (used < p.initialBuy) quote.safeTransfer(msg.sender, p.initialBuy - used);
    }

    function _checkText(string calldata name, string calldata symbol, string calldata uri) internal pure {
        uint256 n = bytes(name).length;
        if (n == 0 || n > 32) revert InvalidName();
        bytes memory s = bytes(symbol);
        if (s.length == 0 || s.length > 10) revert InvalidSymbol();
        for (uint256 i; i < s.length; ++i) {
            bytes1 ch = s[i];
            bool ok = (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A);
            if (!ok) revert InvalidSymbol();
        }
        if (bytes(uri).length > 200) revert InvalidURI();
    }
}
