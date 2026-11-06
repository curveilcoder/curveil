// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title BinBitmap
/// @notice Three-level bitmap over 2^24 bin ids so a swap finds the next non-empty bin in a
///         handful of storage reads, however sparse liquidity is.
/// @dev Level 0: one bit per bin, words keyed by id >> 8.
///      Level 1: one bit per level-0 word, words keyed by id >> 16.
///      Level 2: one bit per level-1 word (256 bits cover the whole id space).
library BinBitmap {
    struct Tree {
        uint256 level2;
        mapping(uint256 => uint256) level1;
        mapping(uint256 => uint256) level0;
    }

    function contains(Tree storage t, uint24 id) internal view returns (bool) {
        return t.level0[id >> 8] & (uint256(1) << (id & 0xff)) != 0;
    }

    function add(Tree storage t, uint24 id) internal {
        uint256 k0 = id >> 8;
        uint256 w0 = t.level0[k0];
        uint256 bit = uint256(1) << (id & 0xff);
        if (w0 & bit != 0) return;
        t.level0[k0] = w0 | bit;
        if (w0 != 0) return;
        uint256 k1 = id >> 16;
        uint256 w1 = t.level1[k1];
        t.level1[k1] = w1 | (uint256(1) << (k0 & 0xff));
        if (w1 != 0) return;
        t.level2 |= uint256(1) << k1;
    }

    function remove(Tree storage t, uint24 id) internal {
        uint256 k0 = id >> 8;
        uint256 w0 = t.level0[k0] & ~(uint256(1) << (id & 0xff));
        t.level0[k0] = w0;
        if (w0 != 0) return;
        uint256 k1 = id >> 16;
        uint256 w1 = t.level1[k1] & ~(uint256(1) << (k0 & 0xff));
        t.level1[k1] = w1;
        if (w1 != 0) return;
        t.level2 &= ~(uint256(1) << k1);
    }

    /// @notice Highest non-empty id strictly below `id`.
    function nextBelow(Tree storage t, uint24 id) internal view returns (bool found, uint24 next) {
        uint256 k0 = id >> 8;
        uint256 w = t.level0[k0] & _below(id & 0xff);
        if (w != 0) return (true, uint24((k0 << 8) | _msb(w)));
        uint256 k1 = id >> 16;
        w = t.level1[k1] & _below(k0 & 0xff);
        if (w == 0) {
            w = t.level2 & _below(k1);
            if (w == 0) return (false, 0);
            k1 = _msb(w);
            w = t.level1[k1];
        }
        k0 = (k1 << 8) | _msb(w);
        return (true, uint24((k0 << 8) | _msb(t.level0[k0])));
    }

    /// @notice Lowest non-empty id strictly above `id`.
    function nextAbove(Tree storage t, uint24 id) internal view returns (bool found, uint24 next) {
        uint256 k0 = id >> 8;
        uint256 w = t.level0[k0] & _above(id & 0xff);
        if (w != 0) return (true, uint24((k0 << 8) | _lsb(w)));
        uint256 k1 = id >> 16;
        w = t.level1[k1] & _above(k0 & 0xff);
        if (w == 0) {
            w = t.level2 & _above(k1);
            if (w == 0) return (false, 0);
            k1 = _lsb(w);
            w = t.level1[k1];
        }
        k0 = (k1 << 8) | _lsb(w);
        return (true, uint24((k0 << 8) | _lsb(t.level0[k0])));
    }

    /// Mask of bits strictly below position `b` (0..255).
    function _below(uint256 b) private pure returns (uint256) {
        unchecked {
            return (uint256(1) << b) - 1;
        }
    }

    /// Mask of bits strictly above position `b` (0..255).
    function _above(uint256 b) private pure returns (uint256) {
        if (b == 255) return 0;
        unchecked {
            return ~((uint256(1) << (b + 1)) - 1);
        }
    }

    /// Index of the highest set bit. Callers guarantee x != 0.
    function _msb(uint256 x) private pure returns (uint256) {
        return Math.log2(x);
    }

    function _lsb(uint256 x) private pure returns (uint256) {
        unchecked {
            return _msb(x & (~x + 1));
        }
    }
}
