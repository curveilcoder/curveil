import { describe, expect, it } from "vitest";
import { plan, triggered, ORDER_KIND, type PlanInput } from "../src/plan";

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  now: 1_000,
  requestTimeout: 120,
  markets: [{ id: 1, feedId: "0x01", oiLong: 0n, oiShort: 0n, fundingUpdatedAt: 1_000, priceAt: 1_000 }],
  prices: new Map([[1, { price: 2_000n * 10n ** 18n, timestamp: 1_000, report: "0x" as const }]]),
  requests: [],
  positions: [],
  orders: [],
  inflight: new Set(),
  ...over,
});

describe("plan", () => {
  it("executes a request only with a price observed after it", () => {
    const req = { id: 7n, positionId: 3n, market: 1, createdAt: 1_000, kind: 1 };
    expect(plan(base({ requests: [req] }))).toEqual([]);
    const later = base({ requests: [{ ...req, createdAt: 999 }] });
    expect(plan(later).map((a) => a.key)).toEqual(["req:7"]);
  });

  it("cancels a request past its timeout instead of executing it", () => {
    const req = { id: 7n, positionId: 3n, market: 1, createdAt: 870, kind: 1 };
    expect(plan(base({ requests: [req] })).map((a) => a.kind)).toEqual(["cancel"]);
  });

  it("does not repeat an action still in flight", () => {
    const req = { id: 7n, positionId: 3n, market: 1, createdAt: 900, kind: 1 };
    expect(plan(base({ requests: [req], inflight: new Set(["req:7"]) }))).toEqual([]);
  });

  it("liquidates first and leaves that position's orders alone", () => {
    const order = {
      id: 4n, positionId: 3n, market: 1, kind: ORDER_KIND.StopLoss, isLong: true, createdAt: 900, expiresAt: 0,
      triggerPrice: 2_100n * 10n ** 18n, acceptablePrice: 0n, positionLive: true,
    };
    const actions = plan(base({ positions: [{ id: 3n, market: 1, isLong: true, liquidatable: true }], orders: [order] }));
    expect(actions.map((a) => a.key)).toEqual(["liq:3"]);
  });

  it("fills triggered orders within the acceptable price and clears dead ones", () => {
    const tp = {
      id: 1n, positionId: 3n, market: 1, kind: ORDER_KIND.TakeProfit, isLong: true, createdAt: 900, expiresAt: 0,
      triggerPrice: 1_900n * 10n ** 18n, acceptablePrice: 0n, positionLive: true,
    };
    const notYet = { ...tp, id: 2n, triggerPrice: 2_100n * 10n ** 18n };
    const tooTight = { ...tp, id: 3n, acceptablePrice: 2_050n * 10n ** 18n };
    const gone = { ...tp, id: 4n, positionLive: false };
    const expired = { ...tp, id: 5n, expiresAt: 999 };
    const sameSecond = { ...tp, id: 6n, createdAt: 1_000 };
    const keys = plan(base({ orders: [tp, notYet, tooTight, gone, expired, sameSecond] })).map((a) => a.key);
    expect(keys).toEqual(["order:1", "expire:4", "expire:5"]);
  });

  it("records a price and accrues funding only for markets with open interest", () => {
    const idle = base({ now: 5_000 });
    expect(plan(idle)).toEqual([]);
    const busy = base({ now: 5_000, markets: [{ id: 1, feedId: "0x01", oiLong: 5n, oiShort: 0n, fundingUpdatedAt: 1_000, priceAt: 4_000 }] });
    expect(plan(busy).map((a) => a.key)).toEqual(["submit:1", "funding:1"]);
    const fresh = base({ now: 5_000, markets: [{ id: 1, feedId: "0x01", oiLong: 5n, oiShort: 0n, fundingUpdatedAt: 4_000, priceAt: 4_500 }] });
    expect(plan(fresh)).toEqual([]);
  });

  it("skips the separate price record when an execution records one anyway", () => {
    const req = { id: 7n, positionId: 3n, market: 1, createdAt: 990, kind: 1 };
    const m = { id: 1, feedId: "0x01" as const, oiLong: 5n, oiShort: 0n, fundingUpdatedAt: 1_000, priceAt: 0 };
    expect(plan(base({ requests: [req], markets: [m] })).map((a) => a.key)).toEqual(["req:7"]);
  });

  it("matches OrderManager.triggered", () => {
    expect(triggered(ORDER_KIND.TakeProfit, true, 2_000n, 2_000n)).toBe(true);
    expect(triggered(ORDER_KIND.TakeProfit, true, 1_999n, 2_000n)).toBe(false);
    expect(triggered(ORDER_KIND.TakeProfit, false, 1_999n, 2_000n)).toBe(true);
    expect(triggered(ORDER_KIND.StopLoss, true, 1_999n, 2_000n)).toBe(true);
    expect(triggered(ORDER_KIND.StopLoss, false, 1_999n, 2_000n)).toBe(false);
    expect(triggered(ORDER_KIND.StopLoss, false, 2_001n, 2_000n)).toBe(true);
  });
});
