// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PerpEngine} from "./PerpEngine.sol";

/// @title PerpLens
/// @notice Read-only helpers for keepers and the website, kept out of the engine (contract size).
///         Uses the engine's own rules: funding accrued to now, gain capped at the reserve,
///         maintenance margin and the close fee.
contract PerpLens {
    uint256 public constant BPS = 10_000;
    uint256 private constant TOKENS = 1e36;
    uint256 private constant ONE = 1e18;

    struct Valuation {
        int256 pnl;
        int256 funding;
        int256 equity;
        bool liquidatable;
        uint256 liquidationPrice;
    }

    PerpEngine public immutable engine;

    constructor(PerpEngine engine_) {
        engine = engine_;
    }

    /// @notice A position's price result at `price`, funding owed (accrued to now), equity,
    ///         whether it can be liquidated at that price, and the price at which it could be
    ///         (an estimate: funding keeps moving it).
    function valuation(uint256 positionId, uint256 price) public view returns (Valuation memory v) {
        PerpEngine.Position memory p = engine.position(positionId);
        if (p.status != PerpEngine.Status.Open) return v;
        PerpEngine.MarketConfig memory m = engine.marketConfig(p.market);
        PerpEngine.MarketState memory s = engine.marketState(p.market);
        int256 d = int256(s.fundingRate) * int256(block.timestamp - s.fundingUpdatedAt);
        int256 index = p.isLong ? s.fundingLong + d : s.fundingShort - d;
        int256 value = int256(Math.mulDiv(p.tokens, price, TOKENS));
        v.pnl = p.isLong ? value - int256(uint256(p.size)) : int256(uint256(p.size)) - value;
        v.funding = (int256(uint256(p.size)) * (index - p.entryFunding)) / int256(ONE);
        int256 gain = v.pnl - v.funding;
        if (gain > int256(uint256(p.reserve))) gain = int256(uint256(p.reserve));
        uint256 buffer = (uint256(p.size) * (uint256(m.closeFeeBps) + m.maintenanceMarginBps)) / BPS;
        v.equity = int256(uint256(p.collateral)) + gain - int256((uint256(p.size) * m.closeFeeBps) / BPS);
        v.liquidatable = v.equity < int256((uint256(p.size) * m.maintenanceMarginBps) / BPS);
        // equity(P) = maintenance, ignoring the profit cap (it never binds near liquidation).
        int256 target = p.isLong
            ? int256(uint256(p.size) + buffer) + v.funding - int256(uint256(p.collateral))
            : int256(uint256(p.collateral) + p.size) - int256(buffer) - v.funding;
        v.liquidationPrice = target > 0 ? Math.mulDiv(uint256(target), TOKENS, p.tokens) : 0;
    }

    /// @notice Which of `ids` can be liquidated at `price`.
    function liquidatable(uint256[] calldata ids, uint256 price) external view returns (bool[] memory out) {
        out = new bool[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = valuation(ids[i], price).liquidatable;
        }
    }
}
