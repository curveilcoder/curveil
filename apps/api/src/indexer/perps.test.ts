import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type AbiEvent, type Hex } from "viem";
import { decodePerpsLogs, oracleAdapterAbi, orderManagerAbi, perpEngineAbi, perpsAdapterAbi } from "./perps";
import type { RpcLog } from "./rpc";

const at = {
  engine: "0x1796cd1E631e8a815c9226bD36eac1D2516444eb",
  orders: "0x30b02e73dc8e8201448A5d50D62a8a52d3C055d5",
  oracle: "0xE8715a97dD9D620a5499efABEBd87D5A1Cc5Faeb",
  vault: "0xBbba08B819906Aa5391F6CE7cdb07cD100CCB600",
  adapter: "0x526F08d50853111a61B72a4979C7E60E1EE97fBC",
};
const alice = "0x00000000000000000000000000000000000A11cE";
let n = 0;

function log(address: string, abi: readonly unknown[], name: string, args: Record<string, unknown>, block = 100): RpcLog {
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
    logIndex: "0x0",
  };
}

describe("decodePerpsLogs", () => {
  it("decodes requests, settlements, orders, prices and claims", () => {
    const logs = [
      log(at.engine, perpEngineAbi, "RequestCreated", {
        requestId: 1n, positionId: 1n, owner: alice, kind: 1, market: 1, isLong: true, size: 10_000_000_000n, collateral: 2_100_000_000n,
        acceptablePrice: 2_500n * 10n ** 18n, executionFee: 200_000n,
      }),
      log(at.engine, perpEngineAbi, "RequestCancelled", { requestId: 2n, positionId: 1n, reason: 9, price: 1n, feeCharged: 200_000n, executor: alice }),
      log(at.engine, perpEngineAbi, "PositionDecreased", {
        positionId: 1n, executor: alice, version: 3,
        s: { sizeDelta: 5n, price: 2n, pnl: -3n, funding: 4n, gain: -7n, closeFee: 1n, executionFee: 2n, payout: 9n, size: 5n, collateral: 8n },
      }),
      log(at.orders, orderManagerAbi, "OrderCancelled", { orderId: 4n, positionId: 1n, reason: 3 }),
      log(at.oracle, oracleAdapterAbi, "PriceRecorded", { feedId: "0x" + "11".repeat(32), price: 2_280n * 10n ** 18n, timestamp: 1_700_000_000n }),
      log(at.adapter, perpsAdapterAbi, "ClaimOpened", { claimId: 77n, positionId: 1n, requestId: 1n }),
      log("0x0000000000000000000000000000000000000001", perpEngineAbi, "Payout", { positionId: 1n, owner: alice, amount: 5n }),
    ];
    const rows = decodePerpsLogs(logs, at, new Map([[100, 1_700_000_001]]));
    expect(rows.requests[0]).toMatchObject({ event: "created", request_id: "1", owner: alice, kind: "open", is_long: 1, size: "10000000000", timestamp: 1_700_000_001 });
    expect(rows.requests[1]).toMatchObject({ event: "cancelled", reason: "liquidatable", fee_charged: "200000", owner: null });
    expect(rows.positions[0]).toMatchObject({ event: "decreased", size_delta: "5", pnl: "-3", gain: "-7", amount: "9", version: 3 });
    expect(rows.orders[0]).toMatchObject({ event: "cancelled", reason: "position_gone" });
    expect(rows.prices[0]).toMatchObject({ price: "2280000000000000000000", report_timestamp: 1_700_000_000 });
    expect(rows.claims[0]).toMatchObject({ event: "opened", claim_id: "77", position_id: "1" });
    // A log from an unrelated address is ignored.
    expect(rows.positions).toHaveLength(1);
  });
});

import { parseCandles } from "../perps";

describe("parseCandles", () => {
  it("orders oldest first, drops bad rows and rows before the range", () => {
    const rows = [
      [300, 9, 11, 10, 10.5, 1],
      [200, 8, 10, 9, 10, 1],
      [100, 7, 9, 8, 9, 1],
      ["x", 1, 2, 3, 4, 5],
      [250, 5, 4, 4, 4, 1], // high below low
    ];
    expect(parseCandles(rows, 150)).toEqual([
      { t: 200, o: 9, h: 10, l: 8, c: 10, v: 1 },
      { t: 300, o: 10, h: 11, l: 9, c: 10.5, v: 1 },
    ]);
    expect(parseCandles({ message: "error" }, 0)).toEqual([]);
    // Volume is optional: a row without one still makes a candle.
    expect(parseCandles([[100, 7, 9, 8, 9]], 0)).toEqual([{ t: 100, o: 8, h: 9, l: 7, c: 9 }]);
  });
});
