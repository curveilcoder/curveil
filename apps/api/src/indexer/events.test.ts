import { describe, expect, it } from "vitest";
import { chainEvents, deliveryId, matches, payload, progressStep } from "./events";
import type { CurveTradeRow } from "./launch";

const meta = (block: number, index = 0) => ({ txHash: "0x" + block.toString(16).padStart(64, "0"), logIndex: index, blockNumber: block, blockHash: "0x" + "cd".repeat(32), timestamp: 1_800_000_000 + block });
const token = "0x00000000000000000000000000000000000000A1";
const curve = "0x00000000000000000000000000000000000000C1";
const op = "0x00000000000000000000000000000000000000c3";
const trade = (block: number, reserve: string): CurveTradeRow => ({
  ...meta(block),
  token,
  trader: "0x00000000000000000000000000000000000A11cE",
  recipient: "0x00000000000000000000000000000000000A11cE",
  isBuy: true,
  quoteAmount: "1",
  tokenAmount: "1",
  fee: "0",
  reserveAfter: reserve,
  virtualBaseAfter: "1",
  quoteValue: 1,
});

describe("chainEvents", () => {
  it("emits a progress event only when the reserve reaches the next 10% step", () => {
    const events = chainEvents({
      trades: [trade(10, "900"), trade(11, "1500"), trade(12, "2100"), trade(13, "2050"), trade(14, "4100")],
      launchContext: new Map([[token, { curve, operator: op, threshold: 10_000n, prevReserve: 800n }]]),
    });
    const progress = events.filter((e) => e.type === "launch.progress").map((e) => [e.data.previousPercent, e.data.progressPercent]);
    expect(progress).toEqual([
      [0, 10],
      [10, 20],
      [20, 40],
    ]);
    expect(events.filter((e) => e.type === "swap")).toHaveLength(5);
    expect(events.find((e) => e.type === "swap")!.addresses).toContain(op.toLowerCase());
  });

  it("gives the same id to the same chain event every time", () => {
    const a = chainEvents({ trades: [trade(10, "1")] })[0]!;
    const b = chainEvents({ trades: [trade(10, "1")] })[0]!;
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(deliveryId("whk_1", a.id)).not.toBe(deliveryId("whk_2", a.id));
  });

  it("emits fee payouts and time-based unlocks", () => {
    const events = chainEvents({
      distributions: [
        { ...meta(20), operator: op, kind: "distributed", token, recipient: null, amount: "5" },
        { ...meta(21), operator: op, kind: "released", token, recipient: curve, amount: "5" },
      ],
      unlocks: [{ lockId: 7, lpToken: token, beneficiary: curve, unlockAt: 1_800_000_500 }],
      at: { number: 30, hash: "0xaa", timestamp: 1_800_000_600 },
    });
    expect(events.map((e) => e.type)).toEqual(["operator.fee_paid", "escrow.unlocked"]);
    expect(events[1]!.data.lockId).toBe(7);
  });
});

describe("matches and payload", () => {
  const e = chainEvents({ trades: [trade(10, "1")] })[0]!;
  it("filters by type, age and address", () => {
    const base = { id: "whk_1", events: ["swap"], addresses: null, createdTs: 0 };
    expect(matches(base, e)).toBe(true);
    expect(matches({ ...base, events: ["launch.created"] }, e)).toBe(false);
    expect(matches({ ...base, events: ["*"] }, e)).toBe(true);
    expect(matches({ ...base, createdTs: 1_900_000_000 }, e)).toBe(false);
    expect(matches({ ...base, addresses: [token.toLowerCase()] }, e)).toBe(true);
    expect(matches({ ...base, addresses: ["0x0000000000000000000000000000000000000001"] }, e)).toBe(false);
  });
  it("leaves the filter addresses out of the body", () => {
    const body = JSON.parse(payload(e, "testnet", 46630));
    expect(body.addresses).toBeUndefined();
    expect(Object.keys(body).slice(0, 4)).toEqual(["id", "type", "network", "chainId"]);
  });
  it("steps", () => {
    expect(progressStep(0n, 100n)).toBe(0);
    expect(progressStep(99n, 100n)).toBe(90);
    expect(progressStep(250n, 100n)).toBe(100);
  });
});
