// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BinMath
/// @notice Price of a DLMM bin: P(id) = (1 + binStep / 10_000) ^ (id - 2^23), as a 128.128 fixed-point number.
/// @dev Price is in raw token units: how many raw units of Y one raw unit of X is worth.
///      Exponentiation by squaring with floor rounding at each step. Bin ids are uint24 with
///      2^23 as price 1.
library BinMath {
    uint256 internal constant Q128 = 1 << 128;
    uint24 internal constant CENTER = 1 << 23;
    uint256 internal constant BPS = 10_000;

    error PriceOutOfRange();

    /// @dev Reverts with PriceOutOfRange instead of overflowing when |id - 2^23| is too large for
    ///      the bin step (roughly 887,000 / binStep bins either side of the center).
    function getPrice(uint24 id, uint16 binStep) internal pure returns (uint256 priceQ128) {
        uint256 absE = id >= CENTER ? id - CENTER : CENTER - id;
        uint256 base = Q128 + (uint256(binStep) * Q128) / BPS;
        uint256 result = Q128;
        while (absE != 0) {
            if (absE & 1 == 1) result = _mulQ(result, base);
            absE >>= 1;
            if (absE != 0) base = _mulQ(base, base);
        }
        if (id < CENTER) {
            // 1 / result in Q128, rounded down.
            result = Math.mulDiv(Q128, Q128, result);
        }
        if (result == 0) revert PriceOutOfRange();
        return result;
    }

    /// a * b / Q128, reverting with PriceOutOfRange when the product cannot fit.
    function _mulQ(uint256 a, uint256 b) private pure returns (uint256) {
        // a * b / 2^128 < a * ((b >> 128) + 1), so this bound is conservative and never overflows.
        if (a > type(uint256).max / ((b >> 128) + 1)) revert PriceOutOfRange();
        return Math.mulDiv(a, b, Q128);
    }

    /// @dev Value of a bin's holdings in Y units: x * P + y.
    function liquidity(uint256 x, uint256 y, uint256 priceQ128) internal pure returns (uint256) {
        return Math.mulDiv(x, priceQ128, Q128) + y;
    }
}
