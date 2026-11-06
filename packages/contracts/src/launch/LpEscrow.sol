// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {DammPool} from "../markets/DammPool.sol";

/// @title LpEscrow
/// @notice Holds DAMM LP shares created at graduation (whitepaper 11). Each lock has one
///         beneficiary and an unlock time fixed when it is created. Only the beneficiary can
///         claim, and only after the unlock time. Trading fees earned by locked shares keep
///         flowing to the beneficiaries while the shares are locked.
/// @dev Lockers (the graduation migrator) can only create locks backed by LP shares this
///      contract has actually received. The owner can add or remove lockers but has no way
///      to change, shorten or withdraw an existing lock.
contract LpEscrow is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant Q128 = 1 << 128;

    struct Lock {
        address lpToken;
        address beneficiary;
        uint64 unlockAt;
        bool claimed;
        uint256 amount;
        uint256 debt0;
        uint256 debt1;
    }

    struct PoolAcc {
        uint256 accounted; // LP shares held for locks
        uint256 acc0; // fees per locked share, Q128
        uint256 acc1;
    }

    mapping(address => bool) public isLocker;
    mapping(address lpToken => PoolAcc) public pools;
    Lock[] internal _locks;
    mapping(address beneficiary => uint256[]) internal _byBeneficiary;

    event LockerSet(address indexed locker, bool allowed);
    event LockCreated(
        uint256 indexed id, address indexed lpToken, address indexed beneficiary, uint256 amount, uint64 unlockAt
    );
    event LockClaimed(uint256 indexed id, address indexed beneficiary, address to, uint256 amount);
    event LockFeesClaimed(
        uint256 indexed id, address indexed beneficiary, address to, uint256 amount0, uint256 amount1
    );
    event BeneficiaryTransferred(uint256 indexed id, address indexed from, address indexed to);

    error NotLocker();
    error NotBeneficiary();
    error StillLocked(uint64 unlockAt);
    error AlreadyClaimed();
    error Unbacked(uint256 needed, uint256 held);
    error LengthMismatch();
    error ZeroAddress();
    error UnknownLock(uint256 id);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setLocker(address locker, bool allowed) external onlyOwner {
        isLocker[locker] = allowed;
        emit LockerSet(locker, allowed);
    }

    // ------------------------------------------------------------------ locking

    /// @notice Records locks for LP shares already transferred (or minted) to this contract.
    function createLocks(
        address lpToken,
        address[] calldata beneficiaries,
        uint256[] calldata amounts,
        uint64[] calldata unlockAts
    ) external nonReentrant returns (uint256[] memory ids) {
        if (!isLocker[msg.sender]) revert NotLocker();
        uint256 n = beneficiaries.length;
        if (n == 0 || amounts.length != n || unlockAts.length != n) revert LengthMismatch();
        _harvest(lpToken);
        PoolAcc storage p = pools[lpToken];
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += amounts[i];
        }
        uint256 held = IERC20(lpToken).balanceOf(address(this));
        if (p.accounted + total > held) revert Unbacked(p.accounted + total, held);
        p.accounted += total;
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            if (beneficiaries[i] == address(0)) revert ZeroAddress();
            ids[i] = _locks.length;
            _locks.push(
                Lock({
                    lpToken: lpToken,
                    beneficiary: beneficiaries[i],
                    unlockAt: unlockAts[i],
                    claimed: false,
                    amount: amounts[i],
                    debt0: Math.mulDiv(amounts[i], p.acc0, Q128),
                    debt1: Math.mulDiv(amounts[i], p.acc1, Q128)
                })
            );
            _byBeneficiary[beneficiaries[i]].push(ids[i]);
            emit LockCreated(ids[i], lpToken, beneficiaries[i], amounts[i], unlockAts[i]);
        }
    }

    // ------------------------------------------------------------------ beneficiary actions

    /// @notice Releases the LP shares of an unlocked lock, with any fees still owed.
    function claim(uint256 id, address to) external nonReentrant {
        Lock storage l = _lock(id);
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (l.claimed) revert AlreadyClaimed();
        if (block.timestamp < l.unlockAt) revert StillLocked(l.unlockAt);
        if (to == address(0)) revert ZeroAddress();
        _harvest(l.lpToken);
        _payFees(id, l, to);
        l.claimed = true;
        pools[l.lpToken].accounted -= l.amount;
        IERC20(l.lpToken).safeTransfer(to, l.amount);
        emit LockClaimed(id, l.beneficiary, to, l.amount);
    }

    /// @notice Pays the trading fees earned so far by a lock's shares. Works while locked.
    function claimFees(uint256 id, address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Lock storage l = _lock(id);
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (l.claimed) revert AlreadyClaimed();
        if (to == address(0)) revert ZeroAddress();
        _harvest(l.lpToken);
        return _payFees(id, l, to);
    }

    /// @notice A beneficiary may hand the lock, including fees not yet claimed, to another address.
    function transferBeneficiary(uint256 id, address to) external {
        Lock storage l = _lock(id);
        if (msg.sender != l.beneficiary) revert NotBeneficiary();
        if (to == address(0)) revert ZeroAddress();
        l.beneficiary = to;
        _byBeneficiary[to].push(id);
        emit BeneficiaryTransferred(id, msg.sender, to);
    }

    /// @notice Pulls the fees owed to this contract's locked shares from the pool.
    function harvest(address lpToken) external nonReentrant {
        _harvest(lpToken);
    }

    // ------------------------------------------------------------------ views

    function getLock(uint256 id) external view returns (Lock memory) {
        if (id >= _locks.length) revert UnknownLock(id);
        return _locks[id];
    }

    function lockCount() external view returns (uint256) {
        return _locks.length;
    }

    /// Lock ids ever held by `beneficiary` (check `beneficiary` on each; transferred locks stay listed).
    function locksOf(address beneficiary) external view returns (uint256[] memory) {
        return _byBeneficiary[beneficiary];
    }

    function pendingFees(uint256 id) external view returns (uint256 amount0, uint256 amount1) {
        if (id >= _locks.length) revert UnknownLock(id);
        Lock memory l = _locks[id];
        if (l.claimed) return (0, 0);
        PoolAcc memory p = pools[l.lpToken];
        uint256 acc0 = p.acc0;
        uint256 acc1 = p.acc1;
        if (p.accounted > 0) {
            (uint256 f0, uint256 f1) = DammPool(l.lpToken).pendingFees(address(this));
            acc0 += Math.mulDiv(f0, Q128, p.accounted);
            acc1 += Math.mulDiv(f1, Q128, p.accounted);
        }
        amount0 = Math.mulDiv(l.amount, acc0, Q128) - l.debt0;
        amount1 = Math.mulDiv(l.amount, acc1, Q128) - l.debt1;
    }

    // ------------------------------------------------------------------ internal

    function _lock(uint256 id) internal view returns (Lock storage) {
        if (id >= _locks.length) revert UnknownLock(id);
        return _locks[id];
    }

    function _harvest(address lpToken) internal {
        PoolAcc storage p = pools[lpToken];
        if (p.accounted == 0) return;
        (uint256 f0, uint256 f1) = DammPool(lpToken).claimFees(address(this));
        if (f0 > 0) p.acc0 += Math.mulDiv(f0, Q128, p.accounted);
        if (f1 > 0) p.acc1 += Math.mulDiv(f1, Q128, p.accounted);
    }

    function _payFees(uint256 id, Lock storage l, address to) internal returns (uint256 amount0, uint256 amount1) {
        PoolAcc storage p = pools[l.lpToken];
        uint256 owed0 = Math.mulDiv(l.amount, p.acc0, Q128);
        uint256 owed1 = Math.mulDiv(l.amount, p.acc1, Q128);
        amount0 = owed0 - l.debt0;
        amount1 = owed1 - l.debt1;
        l.debt0 = owed0;
        l.debt1 = owed1;
        (address t0, address t1) = DammPool(l.lpToken).tokens();
        if (amount0 > 0) IERC20(t0).safeTransfer(to, amount0);
        if (amount1 > 0) IERC20(t1).safeTransfer(to, amount1);
        emit LockFeesClaimed(id, l.beneficiary, to, amount0, amount1);
    }
}
