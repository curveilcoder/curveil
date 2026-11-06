import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseManifest, assertChain, networkOf } from "./index";

const testnet = JSON.parse(readFileSync(resolve(import.meta.dirname, "../manifests/testnet.json"), "utf8"));

describe("manifest", () => {
  it("testnet manifest is valid", () => {
    const m = parseManifest(testnet);
    expect(m.chainId).toBe(46630);
    expect(m.contracts.AssetRegistry).toBeDefined();
  });

  it("rejects a chain ID that does not match the network", () => {
    expect(() => parseManifest({ ...testnet, chainId: 4663 })).toThrow(/does not match/);
  });

  it("rejects test-only assets on mainnet", () => {
    expect(() => parseManifest({ ...testnet, network: "mainnet", chainId: 4663 })).toThrow(/test-only/);
  });

  it("pyth perps need the Pyth contract and a Pyth id per market", () => {
    // Without the Pyth contract and ids (testnet itself now has them, so they are taken off here).
    const { pyth: _pyth, ...base } = testnet.perps;
    const perps = { ...base, priceSource: "pyth", priceSigner: null, markets: base.markets.map(({ pythId: _id, ...x }: { pythId?: string }) => x) };
    const pythId = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    expect(() => parseManifest({ ...testnet, perps })).toThrow(/pyth perps need/);
    const ok = { ...perps, pyth: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a", markets: perps.markets.map((x: object) => ({ ...x, pythId })) };
    expect(parseManifest({ ...testnet, perps: ok }).perps?.pyth).toBe(ok.pyth);
  });

  it("assertChain refuses the wrong chain", () => {
    const m = parseManifest(testnet);
    expect(() => assertChain(m, 1)).toThrow(/Connected to chain 1/);
    expect(() => assertChain(m, 46630)).not.toThrow();
  });

  it("maps chain IDs to networks", () => {
    expect(networkOf(46630)).toBe("testnet");
    expect(networkOf(4663)).toBe("mainnet");
    expect(networkOf(1)).toBeNull();
  });
});
