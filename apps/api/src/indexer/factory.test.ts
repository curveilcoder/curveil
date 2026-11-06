import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, getAddress, type AbiEvent, type Hex } from "viem";
import { decodeLaunchpadLogs, feeSplitterAbi, launchpadRegistryAbi, operatorPart, parseBrand, templatesOf } from "./factory";
import type { RpcLog } from "./rpc";

const registry = "0xDE74faf148b1E6a74045874EfCc846C8311B030a";
const op = "0x00000000000000000000000000000000000000c3";
const admin = "0x00000000000000000000000000000000000A11cE";
const r1 = "0x00000000000000000000000000000000000000A1";
const usdg = "0xB80877C55B95A3998412cb0ddf40E643EDa3F102";
let n = 0;

function log(address: string, abi: readonly unknown[], name: string, args: Record<string, unknown>, block = 100, index = 0): RpcLog {
  const ev = getAbiItem({ abi: abi as AbiEvent[], name }) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args: args as never }) as Hex[];
  const data = ev.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: topics as `0x${string}`[],
    data: encodeAbiParameters(data, data.map((i) => args[i.name!]) as never),
    blockNumber: `0x${block.toString(16)}`,
    blockHash: "0x" + "ab".repeat(32),
    transactionHash: "0x" + (++n).toString(16).padStart(64, "0"),
    logIndex: `0x${index.toString(16)}`,
  };
}

describe("decodeLaunchpadLogs", () => {
  it("reads registrations and follows the new splitter in the same range", () => {
    const logs = [
      log(registry, launchpadRegistryAbi, "OperatorRegistered", { operator: op, admin, slug: "petal-pad", shareBps: 4000, templateMask: 3n, brandURI: "data:application/json,{}" }, 100),
      log(op, feeSplitterAbi, "RecipientsSet", { recipients: [r1], weights: [10_000] }, 100, 1),
      log(op, feeSplitterAbi, "Distributed", { token: usdg, amount: 20_000_000n }, 105),
      log(op, feeSplitterAbi, "Released", { token: usdg, recipient: r1, amount: 20_000_000n }, 106),
      log(registry, launchpadRegistryAbi, "ShareSet", { operator: op, shareBps: 2500 }, 107),
      log(registry, launchpadRegistryAbi, "MaxShareSet", { maxShareBps: 4000 }, 108),
      // Some other contract's log with the same shape is ignored.
      log("0x0000000000000000000000000000000000000bad", feeSplitterAbi, "Distributed", { token: usdg, amount: 1n }, 109),
    ];
    const out = decodeLaunchpadLogs(logs, registry, new Set(), new Map([[100, 1_800_000_000]]));
    expect(out.registered.map((r) => r.slug)).toEqual(["petal-pad"]);
    expect(out.events.map((e) => e.kind)).toEqual(["registered", "recipients_set", "share_set", "max_share_set"]);
    expect(out.events[0]!.timestamp).toBe(1_800_000_000);
    expect(out.events[1]!.data).toEqual({ recipients: [{ address: r1, weightBps: 10_000 }] });
    expect(out.distributions.map((d) => [d.kind, d.amount, d.recipient])).toEqual([
      ["distributed", "20000000", null],
      ["released", "20000000", r1],
    ]);
    expect([...out.touched]).toEqual([getAddress(op)]);
  });
});

describe("helpers", () => {
  it("parses an inline brand and drops anything unexpected", () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Petal Pad", accent: "#FF6699", url: "javascript:alert(1)", logo: "https://x.example/l.png", evil: "<script>" }))}`;
    expect(parseBrand(uri)).toEqual({ name: "Petal Pad", accent: "#ff6699", logo: "https://x.example/l.png" });
    expect(parseBrand(`data:application/json;base64,${btoa('{"name":"B"}')}`)).toEqual({ name: "B" });
    expect(parseBrand("https://example.com/brand.json")).toBeNull();
    expect(parseBrand("data:application/json,not json")).toBeNull();
  });

  it("lists templates from a mask", () => {
    expect(templatesOf("5")).toEqual([0, 2]);
    expect(templatesOf(1n << 63n)).toEqual([63]);
  });

  it("splits a fee like BondingCurve._bookFee", () => {
    // 100 USDG fee, creator 50%, operator 40% of the rest: 20 USDG.
    expect(operatorPart(100_000_000n, 5000, 4000)).toBe(20_000_000n);
    expect(operatorPart(1n, 5000, 4000)).toBe(0n);
  });
});
