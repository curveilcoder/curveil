import { describe, expect, it } from "vitest";
import { distribution, allocate } from "./shapes";
import { binPrice, idForPrice } from "./markets";
import { fmtAmount, parseAmount, withSlippage } from "./format";

const ONE = 10n ** 18n;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("DLMM distributions", () => {
  for (const s of ["balanced", "concentrated", "edge", "custom"] as const) {
    it(`${s}: respects bin composition and never exceeds 100%`, () => {
      const d = distribution(s, -7, 4);
      expect(d.deltaIds.length).toBe(12);
      expect(sum(d.distributionX)).toBeLessThanOrEqual(ONE);
      expect(sum(d.distributionY)).toBeLessThanOrEqual(ONE);
      expect(ONE - sum(d.distributionX)).toBeLessThan(20n);
      d.deltas.forEach((delta, i) => {
        if (delta < 0) expect(d.distributionX[i]).toBe(0n);
        if (delta > 0) expect(d.distributionY[i]).toBe(0n);
      });
    });
  }

  it("concentrated puts most weight next to the price", () => {
    const d = distribution("concentrated", -5, 5);
    const x = d.distributionX.filter((v) => v > 0n);
    expect(x[1]! > x[x.length - 1]!).toBe(true);
  });

  it("one-sided ranges send all of the other token to the active bin only", () => {
    const d = distribution("custom", 0, 5);
    const a = allocate(d, 10n ** 18n, 1_000_000n);
    expect(a[0]!.y).toBe(1_000_000n);
    expect(a.slice(1).every((b) => b.y === 0n)).toBe(true);
  });
});

describe("bin prices", () => {
  it("idForPrice returns the bin at or just below the price", () => {
    const id = idForPrice(2000, 25, 18, 6);
    expect(binPrice(id, 25, 18, 6)).toBeLessThanOrEqual(2000);
    expect(binPrice(id + 1, 25, 18, 6)).toBeGreaterThan(2000);
    expect(id).toBe(8380585);
  });
});

describe("amount formatting", () => {
  it("parses and formats without float error", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("1.1234567", 6)).toBeNull();
    expect(parseAmount("abc", 6)).toBeNull();
    expect(fmtAmount(1_234_567_890n, 6)).toBe("1,234.5678");
    expect(fmtAmount(1n, 18)).toBe("<0.0001");
    expect(withSlippage(10_000n, 50)).toBe(9_950n);
  });
});
