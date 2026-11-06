// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

interface ILaunchFactory {
    function isLaunchToken(address token) external view returns (bool);
    function isCurve(address curve) external view returns (bool);
}

interface IGraduationMigrator {
    function migrate(uint256 tokenAmount, uint256 quoteAmount)
        external
        returns (address pool, uint256 liquidity, uint256 creatorLockId, uint256 protocolLockId);
}
