// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PythReportVerifier} from "../../src/perps/oracle/PythReportVerifier.sol";
import {IPyth} from "../../src/perps/interfaces/IPyth.sol";

/// @notice Checks PythReportVerifier against Pyth's real contract on Robinhood Chain mainnet,
///         with a real Hermes update (ETH/USD and BTC/USD, published at 1793724528) taken from a
///         mainnet transaction. Runs only when PYTH_FORK_RPC is set, e.g.
///         PYTH_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract PythFork
contract PythForkTest is Test {
    IPyth constant PYTH = IPyth(0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a);
    bytes32 constant PYTH_ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant PYTH_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant ETH = keccak256("ETH/USD");
    bytes32 constant BTC = keccak256("BTC/USD");
    uint64 constant PUBLISHED = 1793724528;

    PythReportVerifier pv;
    bytes[] update;
    bool live;

    function setUp() public {
        string memory rpc = vm.envOr("PYTH_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc); // the public RPC keeps no old state; the update stays valid
        live = true;
        update.push(vm.parseBytes(vm.readFile("test/fixtures/pyth-update-mainnet-1793724528.hex")));
        pv = new PythReportVerifier(address(this), PYTH);
        pv.setCaller(address(this));
        pv.setFeed(ETH, PYTH_ETH, 100);
        pv.setFeed(BTC, PYTH_BTC, 100);
    }

    function test_RealUpdateVerifies() public {
        if (!live) return;
        (bytes32 feedId, uint256 price, uint256 ts) = pv.verifyReport(abi.encode(ETH, update));
        assertEq(feedId, ETH);
        assertEq(price, 228586524124 * 1e10, "ETH 2285.86524124");
        assertEq(ts, PUBLISHED);
        (, uint256 btc,) = pv.verifyReport(abi.encode(BTC, update));
        assertEq(btc, 7733348091109 * 1e10, "BTC 77333.48091109");
    }

    function test_RealUpdateIsFirstOnlyForItsOwnSecond() public {
        if (!live) return;
        bytes memory r = abi.encode(ETH, update);
        // the previous ETH update was published in the second before, so this one is the first
        // at or after PUBLISHED, and only for that start time
        (, uint256 price, uint256 ts) = pv.verifyFirstReport(r, PUBLISHED, PUBLISHED + 120);
        assertEq(price, 228586524124 * 1e10);
        assertEq(ts, PUBLISHED);
        vm.expectRevert(); // PriceFeedNotFoundWithinRange
        pv.verifyFirstReport(r, PUBLISHED + 1, PUBLISHED + 120);
        vm.expectRevert();
        pv.verifyFirstReport(r, PUBLISHED - 120, PUBLISHED - 1);
    }

    function test_TamperedUpdateRefused() public {
        if (!live) return;
        bytes memory u = update[0];
        u[u.length - 40] = bytes1(uint8(u[u.length - 40]) ^ 1);
        bytes[] memory bad = new bytes[](1);
        bad[0] = u;
        vm.expectRevert();
        pv.verifyReport(abi.encode(ETH, bad));
    }

    function test_FeeIsZeroOnRobinhoodChain() public {
        if (!live) return;
        assertEq(PYTH.getUpdateFee(update), 0);
    }
}
