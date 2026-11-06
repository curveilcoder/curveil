// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IOperatorCurve {
    function operator() external view returns (address);
    function claimFees(uint8 bucket) external returns (uint256);
}

/// @title FeeSplitter
/// @notice One per launchpad operator, created by the LaunchpadRegistry. Its address is the
///         operator's address on every launch it runs, so the launches' operator fees land here.
///         It splits what arrives between the operator's recipients by fixed weights, and each
///         recipient pulls its own share.
///
///         `distribute` allocates whatever arrived since the last call, exactly: the shares
///         always add up to the amount received, never more, with rounding dust going to the
///         first recipient. Allocated amounts belong to their recipient and stay theirs when the
///         operator later changes recipients. Nothing else can move the funds: not the operator,
///         not the registry, not the protocol.
contract FeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 8;
    uint8 internal constant OPERATOR_BUCKET = 1;

    address public registry;
    address[] internal _recipients;
    uint16[] internal _weights;

    /// Allocated to recipients and not yet paid, per token.
    mapping(address token => uint256) public unpaid;
    /// Ever allocated, per token.
    mapping(address token => uint256) public totalDistributed;
    mapping(address token => mapping(address recipient => uint256)) public owed;
    mapping(address token => mapping(address recipient => uint256)) public released;

    event RecipientsSet(address[] recipients, uint16[] weights);
    event Distributed(address indexed token, uint256 amount);
    event Released(address indexed token, address indexed recipient, uint256 amount);

    error AlreadyInitialised();
    error NotRegistry();
    error BadRecipients();

    /// @dev Locks the implementation; clones start with empty storage and are initialised once.
    constructor() {
        registry = address(0xdead);
    }

    function initialise(address registry_, address[] calldata recipients_, uint16[] calldata weights) external {
        if (registry != address(0)) revert AlreadyInitialised();
        registry = registry_;
        _setRecipients(recipients_, weights);
    }

    function recipients() external view returns (address[] memory, uint16[] memory) {
        return (_recipients, _weights);
    }

    /// @notice What has arrived for `token` and is not allocated yet.
    function pending(address token) public view returns (uint256) {
        return IERC20(token).balanceOf(address(this)) - unpaid[token];
    }

    /// @notice Allocates everything that arrived for `token` since the last call. Anyone may call.
    function distribute(address token) public nonReentrant returns (uint256 amount) {
        amount = pending(token);
        if (amount == 0) return 0;
        uint256 n = _recipients.length;
        uint256 left = amount;
        for (uint256 i = n; i > 1; --i) {
            uint256 part = (amount * _weights[i - 1]) / BPS;
            owed[token][_recipients[i - 1]] += part;
            left -= part;
        }
        owed[token][_recipients[0]] += left;
        unpaid[token] += amount;
        totalDistributed[token] += amount;
        emit Distributed(token, amount);
    }

    /// @notice Pays `recipient` everything allocated to it in `token`. Anyone may call; the
    ///         money only ever goes to the recipient.
    function release(address token, address recipient) public nonReentrant returns (uint256 amount) {
        amount = owed[token][recipient];
        if (amount == 0) return 0;
        owed[token][recipient] = 0;
        unpaid[token] -= amount;
        released[token][recipient] += amount;
        IERC20(token).safeTransfer(recipient, amount);
        emit Released(token, recipient, amount);
    }

    /// @notice Pulls the operator fees of `curves` (launches this operator runs) into the
    ///         splitter and allocates them. Curves run by another operator are skipped.
    function collect(address[] calldata curves, address token) external returns (uint256) {
        for (uint256 i; i < curves.length; ++i) {
            if (IOperatorCurve(curves[i]).operator() == address(this)) IOperatorCurve(curves[i]).claimFees(OPERATOR_BUCKET);
        }
        return distribute(token);
    }

    /// @notice New recipients for fees that arrive from now on. Allocates `tokens` first, so
    ///         what already arrived goes to the old recipients. Only through the registry, on
    ///         the operator admin's instruction.
    function setRecipients(address[] calldata recipients_, uint16[] calldata weights, address[] calldata tokens) external {
        if (msg.sender != registry) revert NotRegistry();
        for (uint256 i; i < tokens.length; ++i) distribute(tokens[i]);
        _setRecipients(recipients_, weights);
    }

    function _setRecipients(address[] calldata recipients_, uint16[] calldata weights) internal {
        uint256 n = recipients_.length;
        if (n == 0 || n > MAX_RECIPIENTS || weights.length != n) revert BadRecipients();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (recipients_[i] == address(0) || weights[i] == 0) revert BadRecipients();
            for (uint256 j; j < i; ++j) if (recipients_[j] == recipients_[i]) revert BadRecipients();
            sum += weights[i];
        }
        if (sum != BPS) revert BadRecipients();
        _recipients = recipients_;
        _weights = weights;
        emit RecipientsSet(recipients_, weights);
    }
}
