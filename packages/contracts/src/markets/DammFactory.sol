// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {AssetRegistry} from "../shared/AssetRegistry.sol";
import {DammPool} from "./DammPool.sol";

/// @title DammFactory
/// @notice Permissionless creation of one DAMM pool per pair of admitted assets.
///         The creator picks one of the enabled fee tiers. A pool keeps the tier's parameters
///         from creation; later tier changes apply only to new pools.
/// @dev Creating a pool is not an endorsement of either asset.
contract DammFactory is Ownable2Step {
    uint16 public constant MAX_FEE_BPS = 1000; // 10% hard ceiling for any tier
    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 5000;

    AssetRegistry public immutable registry;
    address public feeTo;

    mapping(uint8 tier => DammPool.FeeParams) internal _tiers;
    mapping(uint8 tier => bool) public tierEnabled;

    mapping(address => mapping(address => address)) public getPool;
    mapping(address => bool) public isPool;
    address[] public allPools;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        address pool,
        uint8 tier,
        uint256 index,
        DammPool.FeeParams params
    );
    event FeeToSet(address feeTo);
    event TierSet(uint8 indexed tier, bool enabled, DammPool.FeeParams params);

    error IdenticalTokens();
    error PoolExists(address pool);
    error AssetNotAdmitted(address token);
    error TierDisabled(uint8 tier);
    error InvalidParams();
    error ZeroAddress();

    constructor(address initialOwner, AssetRegistry registry_, address feeTo_) Ownable(initialOwner) {
        if (feeTo_ == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        registry = registry_;
        feeTo = feeTo_;
    }

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    function tier(uint8 id) external view returns (DammPool.FeeParams memory params, bool enabled) {
        return (_tiers[id], tierEnabled[id]);
    }

    function createPool(address tokenA, address tokenB, uint8 tierId) external returns (address pool) {
        if (tokenA == tokenB) revert IdenticalTokens();
        if (!tierEnabled[tierId]) revert TierDisabled(tierId);
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (getPool[t0][t1] != address(0)) revert PoolExists(getPool[t0][t1]);
        if (!registry.isAdmitted(t0)) revert AssetNotAdmitted(t0);
        if (!registry.isAdmitted(t1)) revert AssetNotAdmitted(t1);
        DammPool.FeeParams memory params = _tiers[tierId];
        pool = address(new DammPool{salt: keccak256(abi.encode(t0, t1))}(t0, t1, params));
        getPool[t0][t1] = pool;
        getPool[t1][t0] = pool;
        isPool[pool] = true;
        allPools.push(pool);
        emit PoolCreated(t0, t1, pool, tierId, allPools.length - 1, params);
    }

    function setFeeTo(address feeTo_) external onlyOwner {
        if (feeTo_ == address(0)) revert ZeroAddress();
        feeTo = feeTo_;
        emit FeeToSet(feeTo_);
    }

    function setTier(uint8 id, DammPool.FeeParams calldata p, bool enabled) external onlyOwner {
        if (
            p.baseFeeBps == 0 || p.baseFeeBps > p.maxFeeBps || p.maxFeeBps > MAX_FEE_BPS
                || p.protocolShareBps > MAX_PROTOCOL_SHARE_BPS || p.reductionBps > 10_000
                || p.filterPeriod >= p.decayPeriod
        ) revert InvalidParams();
        _tiers[id] = p;
        tierEnabled[id] = enabled;
        emit TierSet(id, enabled, p);
    }
}
