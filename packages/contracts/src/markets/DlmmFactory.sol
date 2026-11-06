// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AssetRegistry} from "../shared/AssetRegistry.sol";
import {BinMath} from "./libraries/BinMath.sol";
import {DlmmPair} from "./DlmmPair.sol";

/// @title DlmmFactory
/// @notice Permissionless creation of DLMM pairs for admitted assets, one per (pair, bin step).
///         Each enabled bin step carries a base fee; a pair keeps the fee and protocol share it
///         was created with.
/// @dev Tokens are sorted, so tokenX is the lower address. The creator states the initial
///      active bin as the price of tokenB in tokenA; it is inverted when the sort flips them.
contract DlmmFactory is Ownable2Step {
    struct Preset {
        uint16 baseFeeBps;
        bool enabled;
    }

    uint16 public constant MAX_BASE_FEE_BPS = 1000;
    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 5000;

    AssetRegistry public immutable registry;
    address public feeTo;
    uint16 public protocolShareBps;

    mapping(uint16 binStep => Preset) public presets;
    uint16[] internal _binSteps;

    mapping(address => mapping(address => mapping(uint16 => address))) public getPair;
    mapping(address => bool) public isPool;
    address[] public allPairs;

    event PairCreated(
        address indexed tokenX,
        address indexed tokenY,
        uint16 indexed binStep,
        address pair,
        uint24 activeId,
        uint256 index
    );
    event PresetSet(uint16 indexed binStep, uint16 baseFeeBps, bool enabled);
    event FeeToSet(address feeTo);
    event ProtocolShareSet(uint16 protocolShareBps);

    error IdenticalTokens();
    error PairExists(address pair);
    error AssetNotAdmitted(address token);
    error PresetDisabled(uint16 binStep);
    error InvalidParams();
    error ZeroAddress();

    constructor(address initialOwner, AssetRegistry registry_, address feeTo_, uint16 protocolShareBps_)
        Ownable(initialOwner)
    {
        if (feeTo_ == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        if (protocolShareBps_ > MAX_PROTOCOL_SHARE_BPS) revert InvalidParams();
        registry = registry_;
        feeTo = feeTo_;
        protocolShareBps = protocolShareBps_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function binSteps() external view returns (uint16[] memory) {
        return _binSteps;
    }

    /// @param activeId Initial active bin, expressed as the price of tokenB per tokenA.
    function createPair(address tokenA, address tokenB, uint16 binStep, uint24 activeId)
        external
        returns (address pair)
    {
        if (tokenA == tokenB) revert IdenticalTokens();
        Preset memory preset = presets[binStep];
        if (!preset.enabled) revert PresetDisabled(binStep);
        (address x, address y) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (getPair[x][y][binStep] != address(0)) revert PairExists(getPair[x][y][binStep]);
        if (!registry.isAdmitted(x)) revert AssetNotAdmitted(x);
        if (!registry.isAdmitted(y)) revert AssetNotAdmitted(y);
        if (tokenA != x) {
            uint256 flipped = 2 * uint256(BinMath.CENTER) - activeId;
            if (flipped > type(uint24).max) revert InvalidParams();
            activeId = uint24(flipped);
        }
        pair = address(
            new DlmmPair{salt: keccak256(abi.encode(x, y, binStep))}(
                x, y, binStep, preset.baseFeeBps, protocolShareBps, activeId
            )
        );
        getPair[x][y][binStep] = pair;
        getPair[y][x][binStep] = pair;
        isPool[pair] = true;
        allPairs.push(pair);
        emit PairCreated(x, y, binStep, pair, activeId, allPairs.length - 1);
    }

    function setPreset(uint16 binStep, uint16 baseFeeBps, bool enabled) external onlyOwner {
        if (binStep == 0 || binStep > 200 || baseFeeBps == 0 || baseFeeBps > MAX_BASE_FEE_BPS) revert InvalidParams();
        if (presets[binStep].baseFeeBps == 0) _binSteps.push(binStep);
        presets[binStep] = Preset(baseFeeBps, enabled);
        emit PresetSet(binStep, baseFeeBps, enabled);
    }

    function setFeeTo(address feeTo_) external onlyOwner {
        if (feeTo_ == address(0)) revert ZeroAddress();
        feeTo = feeTo_;
        emit FeeToSet(feeTo_);
    }

    /// @notice Applies to pairs created after the change only.
    function setProtocolShare(uint16 bps) external onlyOwner {
        if (bps > MAX_PROTOCOL_SHARE_BPS) revert InvalidParams();
        protocolShareBps = bps;
        emit ProtocolShareSet(bps);
    }
}
