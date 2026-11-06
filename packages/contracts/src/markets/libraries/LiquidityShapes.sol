// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {BinMath} from "./BinMath.sol";

/// @title LiquidityShapes
/// @notice Reference implementation of the DLMM allocation strategies (whitepaper 5.2), used by
///         scripts and tests. The web app and SDK implement the same formulas in TypeScript.
/// @dev The range is [active - k, active + k]. Bins below the active bin receive Y only, bins
///      above receive X only, and the active bin takes half weight on each side, so each side's
///      distribution sums to at most 1e18. Weights:
///        Balanced      w = 1
///        Concentrated  w = k + 1 - |d|
///        EdgeWeighted  w = 1 + |d|
library LiquidityShapes {
    enum Shape {
        Balanced,
        Concentrated,
        EdgeWeighted
    }

    uint256 internal constant PRECISION = 1e18;

    function distribution(Shape shape, uint256 k)
        internal
        pure
        returns (int256[] memory ids, uint256[] memory dx, uint256[] memory dy)
    {
        uint256 n = 2 * k + 1;
        ids = new int256[](n);
        dx = new uint256[](n);
        dy = new uint256[](n);
        uint256[] memory w = new uint256[](n);
        uint256 totalX;
        uint256 totalY;
        for (uint256 i; i < n; ++i) {
            int256 d = int256(i) - int256(k);
            ids[i] = d;
            uint256 ad = d < 0 ? uint256(-d) : uint256(d);
            // Doubled so the active bin's half weight stays an integer.
            if (shape == Shape.Balanced) w[i] = 2;
            else if (shape == Shape.Concentrated) w[i] = 2 * (k + 1 - ad);
            else w[i] = 2 * (1 + ad);
            uint256 side = d == 0 ? w[i] / 2 : w[i];
            if (d >= 0) totalX += side;
            if (d <= 0) totalY += side;
        }
        for (uint256 i; i < n; ++i) {
            int256 d = ids[i];
            uint256 side = d == 0 ? w[i] / 2 : w[i];
            if (d >= 0) dx[i] = (side * PRECISION) / totalX;
            if (d <= 0) dy[i] = (side * PRECISION) / totalY;
        }
    }

    /// @notice Bin whose price is the largest one not above `priceQ128` (raw Y per raw X, Q128).
    function idForPrice(uint256 priceQ128, uint16 binStep) internal pure returns (uint24) {
        uint256 lim = 880_000 / binStep;
        uint256 lo = BinMath.CENTER - lim;
        uint256 hi = BinMath.CENTER + lim;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (BinMath.getPrice(uint24(mid), binStep) <= priceQ128) lo = mid;
            else hi = mid - 1;
        }
        return uint24(lo);
    }
}
