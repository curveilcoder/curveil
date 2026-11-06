import { describe, expect, it } from "vitest";
import { evaluate, message, plan, queuedAlert, REPEAT_MS, type Snapshot } from "../src/alerts";

const now = 1_800_000_000_000;
const base: Snapshot = {
  now,
  gasLow: false,
  gasBalanceWei: "1000000000000000000",
  minGasWei: "200000000000000",
  consecutiveErrors: 0,
  lastError: null,
  sources: { coinbase: { ok: true }, kraken: { ok: true }, bitstamp: { ok: true }, gemini: { ok: true } },
  minSources: 2,
  markets: [{ id: 1, symbol: "ETH-USD", openInterest: 0n, priceAt: 0 }],
  broadcaster: { reachable: true, health: "ok" },
};

describe("alerts", () => {
  it("is quiet when everything is fine", () => {
    expect(evaluate(base)).toEqual([]);
  });

  it("flags low gas, repeated errors, missing sources and a down broadcaster", () => {
    const got = evaluate({
      ...base,
      gasLow: true,
      gasBalanceWei: "100000000000000",
      consecutiveErrors: 3,
      lastError: "rpc timeout",
      sources: { coinbase: { ok: true }, kraken: { ok: false }, bitstamp: { ok: false }, gemini: { ok: false } },
      broadcaster: { reachable: false, health: null },
    });
    expect(got.map((a) => a.key)).toEqual(["keeper.gas", "keeper.errors", "prices.sources", "broadcaster"]);
    expect(got[0]!.detail).toContain("0.0001 ETH");
    expect(got[2]!.detail).toContain("kraken, bitstamp, gemini");
  });

  it("flags a stale price only while positions are open", () => {
    const stale = { id: 1, symbol: "ETH-USD", openInterest: 0n, priceAt: Math.floor(now / 1000) - 3600 };
    expect(evaluate({ ...base, markets: [stale] })).toEqual([]);
    const got = evaluate({ ...base, markets: [{ ...stale, openInterest: 5n }] });
    expect(got[0]!.key).toBe("prices.stale.1");
    expect(got[0]!.detail).toContain("60 minutes");
    expect(evaluate({ ...base, markets: [{ ...stale, openInterest: 5n, priceAt: Math.floor(now / 1000) - 60 }] })).toEqual([]);
  });

  it("posts a problem once, repeats it hourly, and reports when it clears", () => {
    const a = evaluate({ ...base, gasLow: true });
    const first = plan(a, {}, now);
    expect(first.post).toHaveLength(1);
    const again = plan(a, first.next, now + 60_000);
    expect(again.post).toHaveLength(0);
    const later = plan(a, again.next, now + REPEAT_MS);
    expect(later.post).toHaveLength(1);
    const cleared = plan([], later.next, now + REPEAT_MS + 1);
    expect(cleared.resolved).toEqual(["keeper.gas"]);
    expect(cleared.next).toEqual({});
  });

  it("formats for Slack and Discord", () => {
    const q = queuedAlert("mainnet", { id: "0xab.0", target: "0x1111111111111111111111111111111111111111", data: "0x8456cb59ffff", delay: 259200n, txHash: "0xdead" }, "https://explorer.example");
    expect(q.detail).toContain("72 hours");
    expect(q.detail).toContain("0x8456cb59");
    const m = message("mainnet", [q], ["keeper.gas"]);
    expect(m.text).toContain("Curveil mainnet: Admin change queued");
    expect(m.text).toContain("resolved");
    expect(m.content.length).toBeLessThanOrEqual(2000);
  });
});
