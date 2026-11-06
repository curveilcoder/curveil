// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {SignedReportVerifier} from "../../src/perps/oracle/SignedReportVerifier.sol";
import {OracleAdapter} from "../../src/perps/OracleAdapter.sol";
import {PerpLiquidityVault} from "../../src/perps/PerpLiquidityVault.sol";
import {PerpEngine} from "../../src/perps/PerpEngine.sol";
import {OrderManager} from "../../src/perps/OrderManager.sol";
import {PerpLens} from "../../src/perps/PerpLens.sol";

/// @notice A mock Chainlink feed (reference price or sequencer uptime).
contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}

abstract contract PerpsBase is Test {
    bytes32 constant ETH = keccak256("ETH/USD");
    bytes32 constant BTC = keccak256("BTC/USD");
    uint32 constant M_ETH = 1;
    uint32 constant M_BTC = 2;
    uint256 constant USD = 1e6;
    uint256 constant PRICE = 2000e18;
    uint128 constant EXEC_FEE = 200_000; // 0.2 USDG

    address admin = makeAddr("admin");
    address treasury = makeAddr("treasury");
    address keeper = makeAddr("keeper");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 signerPk = 0xA11CE;
    address signer;

    TestToken usdg;
    SignedReportVerifier verifier;
    OracleAdapter oracle;
    PerpLiquidityVault vault;
    PerpEngine engine;
    OrderManager orders;
    PerpLens lens;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        signer = vm.addr(signerPk);
        usdg = new TestToken("Test USDG", "tUSDG", 6, admin);
        verifier = new SignedReportVerifier(admin, signer);
        oracle = new OracleAdapter(admin, verifier);
        vault = new PerpLiquidityVault(usdg, admin, 8_000, 1 hours, 0);
        engine = new PerpEngine(usdg, oracle, vault, admin, treasury, 2_000, EXEC_FEE, 120, 300);
        orders = new OrderManager(engine);
        lens = new PerpLens(engine);
        vm.startPrank(admin);
        vault.setEngine(engine);
        engine.setOrderManager(address(orders));
        oracle.setFeed(ETH, true, 60, address(0), 0, 0);
        oracle.setFeed(BTC, true, 60, address(0), 0, 0);
        engine.setMarket(M_ETH, _config(ETH));
        engine.setMarket(M_BTC, _config(BTC));
        vm.stopPrank();

        _fund(lp, 1_000_000 * USD);
        _fund(alice, 100_000 * USD);
        _fund(bob, 100_000 * USD);
        vm.prank(lp);
        vault.deposit(500_000 * USD, 0);
    }

    function _config(bytes32 feedId) internal pure returns (PerpEngine.MarketConfig memory) {
        return PerpEngine.MarketConfig({
            feedId: feedId,
            enabled: true,
            maxLeverageBps: 50_000,
            maintenanceMarginBps: 200,
            openFeeBps: 8,
            closeFeeBps: 8,
            liquidationFeeBps: 50,
            maxProfitBps: 10_000,
            maxOpenInterestLong: uint128(1_000_000 * USD),
            maxOpenInterestShort: uint128(1_000_000 * USD),
            minCollateral: uint128(10 * USD),
            maxFundingRatePerHour: 1e14 // 0.01% per hour at full skew
        });
    }

    function _fund(address who, uint256 amount) internal {
        vm.prank(admin);
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(engine), type(uint256).max);
        usdg.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _report(bytes32 feedId, uint256 price, uint256 ts) internal view returns (bytes memory) {
        bytes32 digest = verifier.reportDigest(feedId, price, uint64(ts));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encode(feedId, price, uint64(ts), abi.encodePacked(r, s, v));
    }

    /// @dev Moves time forward one second and returns a report observed then.
    function _fresh(bytes32 feedId, uint256 price) internal returns (bytes memory) {
        vm.warp(block.timestamp + 1);
        return _report(feedId, price, block.timestamp);
    }

    function _requestOpen(address who, uint32 market, bool isLong, uint256 size, uint256 collateral)
        internal
        returns (uint256 requestId, uint256 positionId)
    {
        vm.prank(who);
        return engine.requestOpen(
            market, isLong, uint128(size), uint128(collateral), isLong ? type(uint256).max : 0, EXEC_FEE
        );
    }

    function _open(address who, uint32 market, bool isLong, uint256 size, uint256 collateral, uint256 price)
        internal
        returns (uint256 positionId)
    {
        uint256 requestId;
        (requestId, positionId) = _requestOpen(who, market, isLong, size, collateral);
        bytes memory report = _fresh(market == M_ETH ? ETH : BTC, price);
        vm.prank(keeper);
        engine.executeRequest(requestId, report);
        assertEq(uint8(engine.position(positionId).status), uint8(PerpEngine.Status.Open), "opened");
    }

    function _close(address who, uint256 positionId, uint256 size, uint256 price) internal returns (uint256 requestId) {
        PerpEngine.Position memory p = engine.position(positionId);
        vm.prank(who);
        requestId = engine.requestClose(positionId, uint128(size), p.isLong ? 0 : type(uint256).max, EXEC_FEE);
        bytes memory report = _fresh(p.market == M_ETH ? ETH : BTC, price);
        vm.prank(keeper);
        engine.executeRequest(requestId, report);
    }

    function _submit(bytes32 feedId, uint256 price) internal {
        oracle.submit(_fresh(feedId, price));
    }

    /// @dev The engine holds exactly the collateral of open positions plus pending escrow, and
    ///      the vault holds at least what is reserved.
    function _checkSolvency() internal view {
        assertEq(usdg.balanceOf(address(engine)), engine.totalCollateral(), "engine holds collateral exactly");
        assertGe(usdg.balanceOf(address(vault)), engine.totalReserved(), "vault covers reserves");
    }
}
