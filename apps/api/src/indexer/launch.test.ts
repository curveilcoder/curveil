import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi, type AbiEvent } from "viem";
import {
  bondingCurveAbi,
  curveMetrics,
  decodeCurveLogs,
  decodeEscrowLogs,
  decodeLaunchCreated,
  launchFactoryAbi,
  lpEscrowAbi,
  touchesTemplates,
  templateRegistryAbi,
} from "./launch";
import { ownMetadataHash, parseMetadataInput, shapeTemplate, sniffImage } from "../launch";
import type { RpcLog } from "./rpc";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const FACTORY = A(0xfac);
const ESCROW = A(0xe5c);
const REGISTRY = A(0x7e9);
const TOKEN = A(0x70c);
const CURVE = A(0xc0e);
const POOL = A(0x9001);
const ALICE = A(0xa11ce);
const BOB = A(0xb0b);

let logIndex = 0;
function log(abi: Abi, address: string, eventName: string, args: Record<string, unknown>, block = 100): RpcLog {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as any) as `0x${string}`[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as any);
  return {
    address: address.toLowerCase(),
    topics,
    data,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: `0x${(++logIndex).toString(16).padStart(64, "0")}`,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

const ts = new Map([[100, 1_700_000_000]]);

describe("launch factory", () => {
  it("decodes LaunchCreated and ignores other contracts", () => {
    const l = log(launchFactoryAbi, FACTORY, "LaunchCreated", {
      token: TOKEN,
      curve: CURVE,
      creator: ALICE,
      templateId: 1n,
      name: "Test Coin",
      symbol: "TEST",
      metadataURI: "https://api.example/v1/launches/metadata/" + "a".repeat(64),
      creatorRecipient: BOB,
    });
    const other = { ...l, address: A(0x1234).toLowerCase() };
    const rows = decodeLaunchCreated([l, other], FACTORY, ts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token: TOKEN,
      curve: CURVE,
      creator: ALICE,
      creatorRecipient: BOB,
      templateId: 1,
      name: "Test Coin",
      symbol: "TEST",
      createdBlock: 100,
      timestamp: 1_700_000_000,
    });
  });
});

describe("bonding curve", () => {
  const curves = new Map([[CURVE, { token: TOKEN, quoteDecimals: 6 }]]);

  it("decodes trades with quote value in quote units", () => {
    const buy = log(bondingCurveAbi, CURVE, "Trade", {
      trader: ALICE,
      to: ALICE,
      isBuy: true,
      quoteAmount: 250_000_000n,
      tokenAmount: 10n ** 24n,
      fee: 2_500_000n,
      reserveAfter: 247_500_000n,
      virtualBaseAfter: 10n ** 27n,
    });
    const { trades, events } = decodeCurveLogs([buy], curves, ts);
    expect(events).toHaveLength(0);
    expect(trades[0]).toMatchObject({ token: TOKEN, isBuy: true, quoteAmount: "250000000", quoteValue: 250, reserveAfter: "247500000" });
  });

  it("decodes state, graduation, fee claims and recipient changes", () => {
    const logs = [
      log(bondingCurveAbi, CURVE, "StateChanged", { state: 2 }),
      log(bondingCurveAbi, CURVE, "Graduated", {
        pool: POOL,
        tokenAmount: 2n * 10n ** 26n,
        quoteAmount: 1_000_000_000n,
        liquidity: 123n,
        creatorLockId: 4n,
        protocolLockId: 5n,
      }),
      log(bondingCurveAbi, CURVE, "FeesClaimed", { bucket: 0, recipient: BOB, amount: 77n }),
      log(bondingCurveAbi, CURVE, "CreatorRecipientSet", { recipient: ALICE }),
    ];
    const { events } = decodeCurveLogs(logs, curves, ts);
    expect(events.map((e) => e.kind)).toEqual(["state", "graduated", "fees_claimed", "recipient_set"]);
    expect(events[0]!.data).toEqual({ state: "graduation_ready" });
    expect(events[1]!.data).toMatchObject({ pool: POOL, creatorLockId: 4, protocolLockId: 5 });
    expect(events[2]!.data).toEqual({ bucket: "creator", recipient: BOB, amount: "77" });
  });

  it("ignores logs from unknown curves and removed logs", () => {
    const t = log(bondingCurveAbi, A(0xdead), "StateChanged", { state: 1 });
    const r = { ...log(bondingCurveAbi, CURVE, "StateChanged", { state: 1 }), removed: true };
    expect(decodeCurveLogs([t, r], curves, ts).events).toHaveLength(0);
  });
});

describe("lp escrow", () => {
  it("decodes the lock lifecycle", () => {
    const rows = decodeEscrowLogs(
      [
        log(lpEscrowAbi, ESCROW, "LockCreated", { id: 4n, lpToken: POOL, beneficiary: ALICE, amount: 1000n, unlockAt: 1_700_000_600n }),
        log(lpEscrowAbi, ESCROW, "LockFeesClaimed", { id: 4n, beneficiary: ALICE, to: BOB, amount0: 1n, amount1: 2n }),
        log(lpEscrowAbi, ESCROW, "BeneficiaryTransferred", { id: 4n, from: ALICE, to: BOB }),
        log(lpEscrowAbi, ESCROW, "LockClaimed", { id: 4n, beneficiary: BOB, to: BOB, amount: 1000n }),
      ],
      ESCROW,
      ts,
    );
    expect(rows.map((r) => r.kind)).toEqual(["created", "fees_claimed", "transferred", "claimed"]);
    expect(rows[0]).toMatchObject({ lockId: 4, lpToken: POOL, beneficiary: ALICE, amount: "1000", unlockAt: 1_700_000_600 });
    expect(rows[1]).toMatchObject({ amount0: "1", amount1: "2", counterparty: BOB });
    expect(rows[2]).toMatchObject({ beneficiary: BOB, counterparty: ALICE });
  });

  it("flags template registry activity", () => {
    const l = log(templateRegistryAbi, REGISTRY, "TemplateStatus", { id: 0n, enabled: true });
    expect(touchesTemplates([l], REGISTRY)).toBe(true);
    expect(touchesTemplates([l], ESCROW)).toBe(false);
  });
});

describe("curve metrics", () => {
  // Standard template: 25,000 USDG threshold, 800M curve, 200M migration.
  const vq = (200_000_000n * 10n ** 18n * 25_000_000_000n) / (600_000_000n * 10n ** 18n);
  const vb = (800_000_000n * 10n ** 18n * (vq + 25_000_000_000n)) / 25_000_000_000n;

  it("starts at the virtual price and ends at the migration price", () => {
    const base = { virtualQuote: vq, initialVirtualBase: vb, threshold: 25_000_000_000n, totalSupply: 10n ** 27n, tokenDecimals: 18, quoteDecimals: 6 };
    const start = curveMetrics({ ...base, virtualBase: vb, reserve: 0n });
    expect(start.progressBps).toBe(0);
    expect(start.price).toBeCloseTo(Number(vq) / 1e6 / (Number(vb) / 1e18), 12);
    // At the threshold, k = vb * vq so virtualBase = k / (vq + T); price = T / M.
    const end = curveMetrics({ ...base, virtualBase: (vb * vq) / (vq + 25_000_000_000n), reserve: 25_000_000_000n });
    expect(end.progressBps).toBe(10_000);
    expect(end.price).toBeCloseTo(25_000 / 200_000_000, 9);
    expect(end.marketCap).toBeCloseTo(125_000, 0);
  });
});

describe("metadata uploads", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

  it("sniffs supported images and rejects others", () => {
    expect(sniffImage(png)).toBe("image/png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("GIF89a...."))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });

  it("accepts a clean upload", () => {
    const r = parseMetadataInput({ description: " hello ", website: "https://example.com", image: `data:image/png;base64,${b64(png)}` });
    expect(r.doc).toEqual({ description: "hello", website: "https://example.com/", x: null, telegram: null });
    expect(r.imageType).toBe("image/png");
  });

  it("treats only this API's own metadata URIs as hosted", () => {
    const h = "ab".repeat(32);
    expect(ownMetadataHash(`https://api.curveil.test/v1/launches/metadata/${h}`, "https://api.curveil.test")).toBe(h);
    expect(ownMetadataHash(`https://evil.test/v1/launches/metadata/${h}`, "https://api.curveil.test")).toBeNull();
    expect(ownMetadataHash(`https://api.curveil.test/v1/launches/metadata/${h}/x`, "https://api.curveil.test")).toBeNull();
  });

  it("rejects bad input", () => {
    expect(() => parseMetadataInput({ description: "x".repeat(501) })).toThrow(/500/);
    expect(() => parseMetadataInput({ website: "http://example.com" })).toThrow(/https/);
    expect(() => parseMetadataInput({ x: "javascript:alert(1)" })).toThrow(/https/);
    expect(() => parseMetadataInput({ image: "data:image/svg+xml;base64,PHN2Zz4=" })).toThrow(/PNG/);
    // declared PNG, but the bytes are not
    expect(() => parseMetadataInput({ image: `data:image/png;base64,${btoa("<svg>hi</svg>")}` })).toThrow(/not a PNG/);
    expect(() => parseMetadataInput({ image: `data:image/png;base64,${b64(new Uint8Array(4 * 1024 * 1024 + 1))}` })).toThrow(/4 MB/);
  });
});

describe("template shape", () => {
  it("derives start and migration prices", () => {
    const t = shapeTemplate({
      id: 0,
      label: "Standard v1",
      quote_asset: A(0xb808),
      quote_symbol: "tUSDG",
      quote_decimals: 6,
      total_supply: (10n ** 27n).toString(),
      curve_supply: (8n * 10n ** 26n).toString(),
      migration_supply: (2n * 10n ** 26n).toString(),
      graduation_threshold: "25000000000",
      virtual_quote: "8333333333",
      virtual_base: "1066666666624000000000000000",
      fee_bps: 100,
      creator_fee_share_bps: 5000,
      damm_tier: 0,
      damm_base_fee_bps: 30,
      damm_max_fee_bps: 100,
      price_tolerance_bps: 200,
      creator_lp_bps: 2000,
      creator_lock_seconds: 180 * 86400,
      protocol_lock_seconds: 365 * 86400,
      protocol_fee_recipient: ALICE,
      protocol_lp_recipient: ALICE,
      enabled: 1,
    });
    expect(t.migrationPrice).toBeCloseTo(0.000125, 9);
    expect(t.startPrice).toBeCloseTo(8333.333333 / 1_066_666_666.624, 9);
    expect(t.graduationThresholdQuote).toBe(25_000);
    expect(t.migrationMarketCap).toBeCloseTo(125_000, 0);
  });
});
