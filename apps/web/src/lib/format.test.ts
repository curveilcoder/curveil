import { describe, expect, it } from "vitest";
import { fmtAmount, fmtCompact, fmtQuote } from "./format";

describe("fmtCompact", () => {
  it("abbreviates thousands, millions and billions", () => {
    expect(fmtCompact(950)).toBe("950");
    expect(fmtCompact(1000)).toBe("1K");
    expect(fmtCompact(1800)).toBe("1.8K");
    expect(fmtCompact(72747.11)).toBe("72.7K");
    expect(fmtCompact(245_300)).toBe("245K");
    expect(fmtCompact(1_250_000)).toBe("1.25M");
    expect(fmtCompact(999_960)).toBe("1M");
    expect(fmtCompact(3_000_000_000)).toBe("3B");
    expect(fmtCompact(null)).toBe("–");
  });
  it("puts $ on dollar tokens and the symbol on others", () => {
    expect(fmtQuote(1800, "tUSDG")).toEqual({ text: "$1.8K", unit: null });
    expect(fmtQuote(1_000_000, "tWETH")).toEqual({ text: "1M", unit: "tWETH" });
  });
});

describe("fmtAmount", () => {
  it("never throws on dust, whatever the precision", () => {
    expect(fmtAmount(10n ** 17n, 18, 0)).toBe("<1");
    expect(fmtAmount(10n ** 13n, 18, 4)).toBe("<0.0001");
    expect(fmtAmount(15n * 10n ** 17n, 18, 0)).toBe("1");
    expect(fmtAmount(0n, 18, 0)).toBe("0");
  });
});
