// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetRegistry} from "../shared/AssetRegistry.sol";
import {DammFactory} from "../markets/DammFactory.sol";
import {DammPool} from "../markets/DammPool.sol";

/// @title LaunchTemplateRegistry
/// @notice Versioned launch templates (whitepaper 10.1). A template is immutable once added:
///         the owner can only enable or disable it for new launches. Live launches keep the
///         terms they were created with.
/// @dev Virtual reserves are derived here, not supplied, so that the curve's terminal price
///      equals the migration price: with curve inventory C, migration inventory M and
///      threshold T, Yv0 = M*T/(C-M) and Xv0 = C*(Yv0+T)/T. At net reserves T the curve has
///      sold C tokens at a marginal price of T/M, the price the DAMM pool opens at.
contract LaunchTemplateRegistry is Ownable2Step {
    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_CURVE_FEE_BPS = 500;
    uint16 public constant MAX_TOLERANCE_BPS = 1000;
    uint32 public constant MAX_LOCK_SECONDS = 4 * 365 days;

    struct TemplateInput {
        string label;
        address quoteAsset;
        uint256 totalSupply;
        uint256 curveSupply;
        uint256 migrationSupply;
        uint256 graduationThreshold;
        uint16 feeBps;
        uint16 creatorFeeShareBps;
        uint8 dammTier;
        uint16 priceToleranceBps;
        uint16 creatorLpBps;
        uint32 creatorLockSeconds;
        uint32 protocolLockSeconds;
        address protocolFeeRecipient;
        address protocolLpRecipient;
    }

    struct Template {
        string label;
        address quoteAsset;
        uint256 totalSupply;
        uint256 curveSupply;
        uint256 migrationSupply;
        uint256 graduationThreshold;
        uint256 virtualQuote;
        uint256 virtualBase;
        uint16 feeBps;
        uint16 creatorFeeShareBps;
        uint8 dammTier;
        uint16 dammBaseFeeBps;
        uint16 dammMaxFeeBps;
        uint16 priceToleranceBps;
        uint16 creatorLpBps;
        uint32 creatorLockSeconds;
        uint32 protocolLockSeconds;
        address protocolFeeRecipient;
        address protocolLpRecipient;
    }

    AssetRegistry public immutable assets;
    DammFactory public immutable damm;

    Template[] internal _templates;
    mapping(uint256 id => bool) public enabled;

    event TemplateAdded(uint256 indexed id, string label, Template template);
    event TemplateStatus(uint256 indexed id, bool enabled);

    error InvalidTemplate(string reason);
    error UnknownTemplate(uint256 id);

    constructor(address initialOwner, AssetRegistry assets_, DammFactory damm_) Ownable(initialOwner) {
        assets = assets_;
        damm = damm_;
    }

    function addTemplate(TemplateInput calldata t, bool enable) external onlyOwner returns (uint256 id) {
        Template memory s = _build(t);
        id = _templates.length;
        _templates.push(s);
        emit TemplateAdded(id, s.label, s);
        if (enable) {
            enabled[id] = true;
            emit TemplateStatus(id, true);
        }
    }

    function setEnabled(uint256 id, bool on) external onlyOwner {
        if (id >= _templates.length) revert UnknownTemplate(id);
        enabled[id] = on;
        emit TemplateStatus(id, on);
    }

    function get(uint256 id) external view returns (Template memory) {
        if (id >= _templates.length) revert UnknownTemplate(id);
        return _templates[id];
    }

    function count() external view returns (uint256) {
        return _templates.length;
    }

    /// @notice Simulates the curve at the graduation threshold with the same integer rounding
    ///         the curve uses. Returns tokens sold, dust left in inventory, and the terminal
    ///         curve price and the migration price, both as quote per token scaled by 1e36.
    function simulate(uint256 id)
        external
        view
        returns (uint256 sold, uint256 dust, uint256 terminalPriceE36, uint256 migrationPriceE36)
    {
        if (id >= _templates.length) revert UnknownTemplate(id);
        return _simulate(_templates[id]);
    }

    function _build(TemplateInput calldata t) internal view returns (Template memory s) {
        if (bytes(t.label).length == 0 || bytes(t.label).length > 48) revert InvalidTemplate("label");
        if (!assets.isAdmitted(t.quoteAsset)) revert InvalidTemplate("quote asset not admitted");
        if (t.curveSupply + t.migrationSupply != t.totalSupply) revert InvalidTemplate("supply split");
        if (t.migrationSupply == 0 || t.migrationSupply >= t.curveSupply) revert InvalidTemplate("inventory");
        if (t.totalSupply > 1e36) revert InvalidTemplate("supply too large");
        if (t.graduationThreshold == 0 || t.graduationThreshold > 1e30) revert InvalidTemplate("threshold");
        if (t.feeBps == 0 || t.feeBps > MAX_CURVE_FEE_BPS) revert InvalidTemplate("curve fee");
        if (t.creatorFeeShareBps > BPS) revert InvalidTemplate("creator fee share");
        if (t.priceToleranceBps == 0 || t.priceToleranceBps > MAX_TOLERANCE_BPS) revert InvalidTemplate("tolerance");
        if (t.creatorLpBps > BPS) revert InvalidTemplate("creator LP share");
        if (t.creatorLockSeconds > MAX_LOCK_SECONDS || t.protocolLockSeconds > MAX_LOCK_SECONDS) {
            revert InvalidTemplate("lock");
        }
        if (t.protocolFeeRecipient == address(0) || t.protocolLpRecipient == address(0)) {
            revert InvalidTemplate("recipient");
        }
        (DammPool.FeeParams memory fp, bool tierOn) = damm.tier(t.dammTier);
        if (!tierOn) revert InvalidTemplate("DAMM tier disabled");

        s.label = t.label;
        s.quoteAsset = t.quoteAsset;
        s.totalSupply = t.totalSupply;
        s.curveSupply = t.curveSupply;
        s.migrationSupply = t.migrationSupply;
        s.graduationThreshold = t.graduationThreshold;
        s.virtualQuote = Math.mulDiv(t.migrationSupply, t.graduationThreshold, t.curveSupply - t.migrationSupply);
        s.virtualBase = Math.mulDiv(t.curveSupply, s.virtualQuote + t.graduationThreshold, t.graduationThreshold);
        if (s.virtualQuote == 0) revert InvalidTemplate("virtual quote rounds to zero");
        s.feeBps = t.feeBps;
        s.creatorFeeShareBps = t.creatorFeeShareBps;
        s.dammTier = t.dammTier;
        s.dammBaseFeeBps = fp.baseFeeBps;
        s.dammMaxFeeBps = fp.maxFeeBps;
        s.priceToleranceBps = t.priceToleranceBps;
        s.creatorLpBps = t.creatorLpBps;
        s.creatorLockSeconds = t.creatorLockSeconds;
        s.protocolLockSeconds = t.protocolLockSeconds;
        s.protocolFeeRecipient = t.protocolFeeRecipient;
        s.protocolLpRecipient = t.protocolLpRecipient;

        (uint256 sold, uint256 dust, uint256 pTerm, uint256 pMig) = _simulate(s);
        if (sold > s.curveSupply || dust > s.curveSupply / 1e6) revert InvalidTemplate("inventory rounding");
        // Terminal and migration prices must agree within a quarter of the published tolerance.
        uint256 diff = pTerm > pMig ? pTerm - pMig : pMig - pTerm;
        if (diff * BPS * 4 > pMig * s.priceToleranceBps) revert InvalidTemplate("terminal price");
    }

    function _simulate(Template memory s)
        internal
        pure
        returns (uint256 sold, uint256 dust, uint256 terminalPriceE36, uint256 migrationPriceE36)
    {
        uint256 k = s.virtualBase * s.virtualQuote;
        uint256 y = s.virtualQuote + s.graduationThreshold;
        uint256 xEnd = Math.ceilDiv(k, y);
        sold = s.virtualBase - xEnd;
        dust = sold < s.curveSupply ? s.curveSupply - sold : 0;
        terminalPriceE36 = Math.mulDiv(y, 1e36, xEnd);
        migrationPriceE36 = Math.mulDiv(s.graduationThreshold, 1e36, s.migrationSupply + dust);
    }
}
