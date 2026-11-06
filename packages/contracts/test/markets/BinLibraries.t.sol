// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BinMath} from "../../src/markets/libraries/BinMath.sol";
import {BinBitmap} from "../../src/markets/libraries/BinBitmap.sol";

contract BinMathTest is Test {
    uint256 internal constant Q128 = 1 << 128;

    function test_centerIsOne() public pure {
        assertEq(BinMath.getPrice(BinMath.CENTER, 10), Q128);
    }

    function test_oneStepUp() public pure {
        // (1 + 10 bps) in Q128, within rounding.
        assertApproxEqAbs(BinMath.getPrice(BinMath.CENTER + 1, 10), Q128 + Q128 / 1000, 1);
    }

    function testFuzz_monotonic(uint24 delta, uint8 stepPick) public pure {
        uint16[4] memory steps = [uint16(1), 10, 25, 100];
        uint16 step = steps[stepPick % 4];
        uint256 limit = step == 100 ? 8_000 : step == 25 ? 30_000 : 80_000;
        uint256 d = bound(delta, 0, limit);
        uint24 id = uint24(BinMath.CENTER - limit + d);
        assertLt(BinMath.getPrice(id, step), BinMath.getPrice(id + 1, step));
    }

    function testFuzz_symmetric(uint24 k) public pure {
        uint256 d = bound(k, 1, 20_000);
        uint256 up = BinMath.getPrice(uint24(BinMath.CENTER + d), 10);
        uint256 down = BinMath.getPrice(uint24(BinMath.CENTER - d), 10);
        // up * down ≈ 1 (relative error from rounding stays tiny).
        uint256 prod = (up / 2 ** 64) * (down / 2 ** 64);
        assertApproxEqRel(prod, Q128, 1e9);
    }

    function test_revertWhen_tooFar() public {
        BinMathCaller c = new BinMathCaller();
        vm.expectRevert();
        c.price(uint24(BinMath.CENTER + 500_000), 10);
    }
}

contract BinMathCaller {
    function price(uint24 id, uint16 step) external pure returns (uint256) {
        return BinMath.getPrice(id, step);
    }
}

contract BitmapHarness {
    using BinBitmap for BinBitmap.Tree;

    BinBitmap.Tree internal t;

    function add(uint24 id) external {
        t.add(id);
    }

    function remove(uint24 id) external {
        t.remove(id);
    }

    function contains(uint24 id) external view returns (bool) {
        return t.contains(id);
    }

    function below(uint24 id) external view returns (bool, uint24) {
        return t.nextBelow(id);
    }

    function above(uint24 id) external view returns (bool, uint24) {
        return t.nextAbove(id);
    }
}

contract BinBitmapTest is Test {
    BitmapHarness internal h;

    function setUp() public {
        h = new BitmapHarness();
    }

    function test_findsAcrossWordsAndLevels() public {
        h.add(5);
        h.add(300);
        h.add(70_000);
        h.add(16_000_000);

        _eqBelow(301, true, 300);
        _eqBelow(300, true, 5);
        _eqBelow(5, false, 0);
        _eqBelow(type(uint24).max, true, 16_000_000);
        _eqAbove(5, true, 300);
        _eqAbove(300, true, 70_000);
        _eqAbove(70_000, true, 16_000_000);
        _eqAbove(16_000_000, false, 0);

        h.remove(300);
        _eqAbove(5, true, 70_000);
        h.remove(70_000);
        _eqBelow(16_000_000, true, 5);
    }

    function testFuzz_matchesLinearScan(uint24[8] memory ids, uint24 probe) public {
        for (uint256 i; i < ids.length; ++i) {
            h.add(ids[i]);
        }
        bool foundB;
        uint24 bestB;
        bool foundA;
        uint24 bestA;
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] < probe && (!foundB || ids[i] > bestB)) (foundB, bestB) = (true, ids[i]);
            if (ids[i] > probe && (!foundA || ids[i] < bestA)) (foundA, bestA) = (true, ids[i]);
        }
        _eqBelow(probe, foundB, bestB);
        _eqAbove(probe, foundA, bestA);
    }

    function _eqBelow(uint24 id, bool found, uint24 next) internal view {
        (bool f, uint24 n) = h.below(id);
        assertEq(f, found);
        if (found) assertEq(n, next);
    }

    function _eqAbove(uint24 id, bool found, uint24 next) internal view {
        (bool f, uint24 n) = h.above(id);
        assertEq(f, found);
        if (found) assertEq(n, next);
    }
}
