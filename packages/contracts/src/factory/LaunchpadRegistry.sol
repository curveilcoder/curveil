// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Guarded} from "../shared/Guarded.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {FeeSplitter} from "./FeeSplitter.sol";

interface ITemplateCount {
    function count() external view returns (uint256);
}

/// @title LaunchpadRegistry
/// @notice Branded launchpads ("operators") on Curveil's shared launch contracts (whitepaper
///         section 12). Anyone may register one. An operator picks which launch templates it
///         offers, a share of the protocol's part of curve fees (bounded by the protocol), its
///         fee recipients, and a brand metadata URI for its frontend.
///
///         Each operator gets its own FeeSplitter, and the splitter's address is the operator's
///         address on launches: LaunchFactory asks `operatorTerms` when a launch names an
///         operator, and the curve then pays the operator part of its fees to the splitter.
///
///         What an operator can not do: change a launch after it is created (its share and fee
///         address are fixed in the curve), touch any curve's reserves, or move fees already
///         allocated to its recipients. The protocol owner can lower the share cap and suspend
///         an operator, and the guardian can suspend one at once; all of these affect only
///         launches created afterwards.
contract LaunchpadRegistry is Guarded {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_TEMPLATES = 64;

    struct Operator {
        address admin;
        address pendingAdmin;
        uint16 shareBps;
        bool active;
        bool suspended;
        uint64 createdAt;
        uint64 templateMask; // bit i: template i allowed
        string slug;
        string brandURI;
    }

    address public immutable splitterImplementation;
    ITemplateCount public immutable templates;
    /// Most an operator may take of the protocol part of curve fees.
    uint16 public maxShareBps;

    address[] internal _operators; // splitter addresses, in registration order
    mapping(address operator => Operator) internal _ops;
    mapping(bytes32 slugHash => address operator) public operatorBySlug;

    event OperatorRegistered(
        address indexed operator, address indexed admin, string slug, uint16 shareBps, uint64 templateMask, string brandURI
    );
    event BrandSet(address indexed operator, string brandURI);
    event ShareSet(address indexed operator, uint16 shareBps);
    event TemplatesSet(address indexed operator, uint64 templateMask);
    event ActiveSet(address indexed operator, bool active);
    event Suspended(address indexed operator, bool suspended);
    event AdminTransferStarted(address indexed operator, address indexed pendingAdmin);
    event AdminTransferred(address indexed operator, address indexed admin);
    event MaxShareSet(uint16 maxShareBps);

    error NotAdmin();
    error NotPendingAdmin();
    error UnknownOperator();
    error BadSlug();
    error SlugTaken();
    error ShareTooHigh();
    error BadTemplates();
    error URITooLong();
    error ZeroAddress();

    constructor(address initialOwner, ITemplateCount templates_, uint16 maxShareBps_) Ownable(initialOwner) {
        if (maxShareBps_ > BPS) revert ShareTooHigh();
        templates = templates_;
        maxShareBps = maxShareBps_;
        splitterImplementation = address(new FeeSplitter());
        emit MaxShareSet(maxShareBps_);
    }

    modifier onlyAdmin(address operator) {
        if (_ops[operator].admin == address(0)) revert UnknownOperator();
        if (msg.sender != _ops[operator].admin) revert NotAdmin();
        _;
    }

    // ------------------------------------------------------------------ registration

    /// @notice Registers a launchpad run by the sender. Returns its address (its FeeSplitter).
    /// @param slug 3 to 32 characters, a-z, 0-9 and "-", not starting or ending with "-". Unique.
    /// @param templateMask Bit i allows template i.
    function register(
        string calldata slug,
        string calldata brandURI,
        uint16 shareBps,
        uint64 templateMask,
        address[] calldata recipients,
        uint16[] calldata weights
    ) external returns (address operator) {
        _checkSlug(slug);
        bytes32 h = keccak256(bytes(slug));
        if (operatorBySlug[h] != address(0)) revert SlugTaken();
        if (shareBps > maxShareBps) revert ShareTooHigh();
        _checkTemplates(templateMask);
        _checkURI(brandURI);

        operator = Clones.cloneDeterministic(splitterImplementation, h);
        FeeSplitter(operator).initialise(address(this), recipients, weights);
        operatorBySlug[h] = operator;
        _operators.push(operator);
        _store(operator, slug, brandURI, shareBps, templateMask);
    }

    function _store(address operator, string calldata slug, string calldata brandURI, uint16 shareBps, uint64 templateMask)
        internal
    {
        Operator storage o = _ops[operator];
        o.admin = msg.sender;
        o.shareBps = shareBps;
        o.active = true;
        o.createdAt = uint64(block.timestamp);
        o.templateMask = templateMask;
        o.slug = slug;
        o.brandURI = brandURI;
        emit OperatorRegistered(operator, msg.sender, slug, shareBps, templateMask, brandURI);
    }

    /// @notice The address a slug would get, before it is registered.
    function predictOperator(string calldata slug) external view returns (address) {
        return Clones.predictDeterministicAddress(splitterImplementation, keccak256(bytes(slug)));
    }

    // ------------------------------------------------------------------ operator admin

    function setBrand(address operator, string calldata brandURI) external onlyAdmin(operator) {
        _checkURI(brandURI);
        _ops[operator].brandURI = brandURI;
        emit BrandSet(operator, brandURI);
    }

    /// Applies to launches created afterwards.
    function setShare(address operator, uint16 shareBps) external onlyAdmin(operator) {
        if (shareBps > maxShareBps) revert ShareTooHigh();
        _ops[operator].shareBps = shareBps;
        emit ShareSet(operator, shareBps);
    }

    /// Applies to launches created afterwards.
    function setTemplates(address operator, uint64 templateMask) external onlyAdmin(operator) {
        _checkTemplates(templateMask);
        _ops[operator].templateMask = templateMask;
        emit TemplatesSet(operator, templateMask);
    }

    /// @notice Pauses or resumes new launches on this launchpad. Live launches are unaffected.
    function setActive(address operator, bool active) external onlyAdmin(operator) {
        _ops[operator].active = active;
        emit ActiveSet(operator, active);
    }

    /// @notice New fee recipients for fees that arrive from now on; `tokens` are allocated to
    ///         the old recipients first.
    function setRecipients(address operator, address[] calldata recipients, uint16[] calldata weights, address[] calldata tokens)
        external
        onlyAdmin(operator)
    {
        FeeSplitter(operator).setRecipients(recipients, weights, tokens);
    }

    function transferAdmin(address operator, address newAdmin) external onlyAdmin(operator) {
        _ops[operator].pendingAdmin = newAdmin;
        emit AdminTransferStarted(operator, newAdmin);
    }

    function acceptAdmin(address operator) external {
        Operator storage o = _ops[operator];
        if (o.admin == address(0)) revert UnknownOperator();
        if (msg.sender != o.pendingAdmin) revert NotPendingAdmin();
        o.admin = msg.sender;
        o.pendingAdmin = address(0);
        emit AdminTransferred(operator, msg.sender);
    }

    // ------------------------------------------------------------------ protocol

    /// @notice Lowers or raises the cap. An operator above a lowered cap gets the cap on new
    ///         launches; existing launches keep their terms.
    function setMaxShare(uint16 maxShareBps_) external onlyOwner {
        if (maxShareBps_ > BPS) revert ShareTooHigh();
        maxShareBps = maxShareBps_;
        emit MaxShareSet(maxShareBps_);
    }

    /// @notice Stops (or allows again) new launches on an operator. Existing launches, and the
    ///         fees they pay to it, are unaffected. The guardian can suspend; only the owner can
    ///         lift a suspension.
    function setSuspended(address operator, bool suspended) external {
        _checkStop(suspended);
        if (_ops[operator].admin == address(0)) revert UnknownOperator();
        _ops[operator].suspended = suspended;
        emit Suspended(operator, suspended);
    }

    // ------------------------------------------------------------------ views

    /// @notice What LaunchFactory asks when a launch names `operator`.
    function operatorTerms(address operator, uint256 templateId) external view returns (bool allowed, uint16 shareBps) {
        Operator storage o = _ops[operator];
        allowed = o.admin != address(0) && o.active && !o.suspended && templateId < MAX_TEMPLATES
            && (o.templateMask >> templateId) & 1 == 1;
        shareBps = o.shareBps < maxShareBps ? o.shareBps : maxShareBps;
    }

    function operatorInfo(address operator) external view returns (Operator memory) {
        return _ops[operator];
    }

    function isOperator(address operator) external view returns (bool) {
        return _ops[operator].admin != address(0);
    }

    function operatorCount() external view returns (uint256) {
        return _operators.length;
    }

    function operatorAt(uint256 i) external view returns (address) {
        return _operators[i];
    }

    // ------------------------------------------------------------------ checks

    function _checkSlug(string calldata slug) internal pure {
        bytes calldata s = bytes(slug);
        if (s.length < 3 || s.length > 32 || s[0] == "-" || s[s.length - 1] == "-") revert BadSlug();
        for (uint256 i; i < s.length; ++i) {
            bytes1 c = s[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) revert BadSlug();
        }
    }

    function _checkTemplates(uint64 mask) internal view {
        uint256 n = templates.count();
        if (mask == 0 || (n < 64 && mask >> n != 0)) revert BadTemplates();
    }

    function _checkURI(string calldata uri) internal pure {
        if (bytes(uri).length > 2048) revert URITooLong();
    }
}
