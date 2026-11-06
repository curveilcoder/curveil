import { describe, expect, it } from "vitest";
import { acceptablePrice, previewOpen, signedUsd, wad, type MarketConfig } from "./perps";

const cfg: MarketConfig = {
  feedId: "0x01",
  enabled: true,
  maxLeverageBps: 50_000,
  maintenanceMarginBps: 200,
  openFeeBps: 8,
  closeFeeBps: 8,
  liquidationFeeBps: 50,
  maxProfitBps: 10_000,
  maxOpenInterestLong: "100000000000",
  maxOpenInterestShort: "100000000000",
  minCollateral: "10000000",
  maxFundingRatePerHour: "100000000000000",
};

describe("perps arithmetic", () => {
  it("keeps 5x within the engine's cap after the open fee", () => {
    const c = 1_000_000_000n; // 1,000 USDG
    const p = previewOpen(cfg, true, c, 5, 2_000n * 10n ** 18n);
    // engine: size * BPS <= (collateral - openFee) * maxLeverageBps
    expect(p.size * 10_000n <= (c - p.openFee) * 50_000n).toBe(true);
    expect(p.size).toBeGreaterThan(4_970_000_000n);
  });

  it("puts the long liquidation price below entry and the short one above", () => {
    const entry = 2_000n * 10n ** 18n;
    const long = previewOpen(cfg, true, 1_000_000_000n, 5, entry);
    const short = previewOpen(cfg, false, 1_000_000_000n, 5, entry);
    expect(long.liquidationPrice! < entry && short.liquidationPrice! > entry).toBe(true);
    // ~ entry * (1 - 1/5 + buffer): about 1,640 for a 5x long
    expect(Number(long.liquidationPrice! / 10n ** 18n)).toBeGreaterThan(1_630);
    expect(Number(long.liquidationPrice! / 10n ** 18n)).toBeLessThan(1_650);
  });

  it("formats and limits prices", () => {
    expect(wad("2280.155")).toBe(2_280_155_000_000_000_000_000n);
    expect(acceptablePrice(2_000n * 10n ** 18n, true, 100)).toBe(2_020n * 10n ** 18n);
    expect(acceptablePrice(2_000n * 10n ** 18n, false, 100)).toBe(1_980n * 10n ** 18n);
    expect(signedUsd("-5000000")).toBe("-5.00");
    expect(signedUsd(12_345_678n)).toBe("+12.34");
  });
});
