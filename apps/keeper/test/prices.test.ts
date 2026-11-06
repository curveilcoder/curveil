import { describe, expect, it } from "vitest";
import { aggregate, fetchQuotes, median, toWad } from "../src/prices";

const w = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n;

describe("prices", () => {
  it("parses decimal strings into 18 decimals", () => {
    expect(toWad("3456.78")).toBe(3_456_780_000_000_000_000_000n);
    expect(toWad("0.000000000000000000001")).toBe(null); // rounds to zero
    expect(toWad("1e3")).toBe(null);
    expect(toWad("-1")).toBe(null);
    expect(toWad(undefined)).toBe(null);
  });

  it("takes the median and drops an outlier", () => {
    expect(median([w(3), w(1), w(2)])).toBe(w(2));
    expect(median([w(1), w(2), w(3), w(4)])).toBe(w(2.5));
    const a = aggregate(
      [
        { source: "a", price: w(2000) },
        { source: "b", price: w(2001) },
        { source: "c", price: w(2002) },
        { source: "d", price: w(2300) },
      ],
      2,
      100,
    );
    expect(a.ok && a.price).toBe(w(2001));
    expect(a.ok && a.dropped).toEqual(["d"]);
  });

  it("refuses too few or disagreeing quotes", () => {
    expect(aggregate([{ source: "a", price: w(2000) }], 2, 100).ok).toBe(false);
    expect(aggregate([{ source: "a", price: w(2000) }, { source: "b", price: w(2200) }], 2, 100).ok).toBe(false);
  });

  it("keeps quotes from sources that answer when others fail", async () => {
    const { quotes, health } = await fetchQuotes(["ETH"], {
      good: async () => ({ ETH: w(2000) }),
      bad: async () => {
        throw new Error("blocked");
      },
    });
    expect(quotes.ETH).toEqual([{ source: "good", price: w(2000) }]);
    expect(health.bad).toEqual({ ok: false, error: "blocked" });
  });
});
