import { describe, expect, it } from "vitest";
import { tradeCandles } from "./candles";

describe("tradeCandles", () => {
  it("groups trades into candles that open at the previous close", () => {
    const c = tradeCandles([
      { t: 0, price: 1 },
      { t: 30, price: 1.2 },
      { t: 50, price: 1.1 },
      { t: 3000, price: 0.9 },
    ]);
    expect(c[0]).toEqual({ t: 0, o: 1, h: 1.2, l: 1, c: 1.1 });
    expect(c[c.length - 1]).toEqual({ t: 3000, o: 1.1, h: 1.1, l: 0.9, c: 0.9 });
    // Quiet minutes in between are flat candles at the last price, so time stays even.
    expect(c.length).toBe(51);
    expect(c[1]).toEqual({ t: 60, o: 1.1, h: 1.1, l: 1.1, c: 1.1 });
  });
  it("keeps at most the requested number of candles", () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ t: i * 600, price: 1 + i / 100 }));
    expect(tradeCandles(pts, 60).length).toBeLessThanOrEqual(60);
    expect(tradeCandles(pts, 60, 500 * 600 + 86_400).length).toBeLessThanOrEqual(60);
  });
  it("carries the last price up to `until`", () => {
    const c = tradeCandles([{ t: 0, price: 2 }, { t: 100, price: 3 }], 60, 3_000);
    expect(c[c.length - 1]).toEqual({ t: 3_000, o: 3, h: 3, l: 3, c: 3 });
    expect(new Set(c.slice(1).map((x, i) => x.t - c[i]!.t))).toEqual(new Set([60]));
  });
});
