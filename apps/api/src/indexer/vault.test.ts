import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { decodeVaultLogs, liquidityAdapterAbi, shieldedPoolAbi } from "./vault";
import type { RpcLog } from "./rpc";

const POOL = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const USER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";

let logIndex = 0;
function log(eventName: string, args: Record<string, unknown>, address = POOL, block = 100, abi = shieldedPoolAbi, tx = "cd"): RpcLog {
  const ev = (abi as readonly { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean }[] }[]).find(
    (x) => x.type === "event" && x.name === eventName,
  )!;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const nonIndexed = ev.inputs!.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name]) as never);
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${tx.repeat(32)}`,
    logIndex: `0x${(logIndex++).toString(16)}`,
  };
}

describe("vault log decoding", () => {
  it("decodes commitments, nullifiers and the public side of actions", () => {
    const enc = `0x01${"aa".repeat(128)}` as Hex;
    const logs = [
      log("NoteCommitted", { leafIndex: 0n, commitment: 123n, encryptedNote: enc }),
      log("Shielded", { depositor: USER, token: TOKEN, amount: 5_000_000n, leafIndex: 0n }),
      log("NullifierSpent", { nullifier: 999n }),
      log("Transferred", { nullifier0: 1n, nullifier1: 2n, feeToken: ZERO, fee: 0n, feeRecipient: ZERO }),
      log("Transferred", { nullifier0: 3n, nullifier1: 4n, feeToken: TOKEN, fee: 7n, feeRecipient: USER }),
      log("Withdrawn", { recipient: USER, token: TOKEN, amount: 1000n, protocolFee: 1n, fee: 0n, feeRecipient: ZERO }),
      // Same event from another address is ignored.
      log("NullifierSpent", { nullifier: 5n }, "0x4444444444444444444444444444444444444444"),
    ];
    const r = decodeVaultLogs(logs, POOL, new Map([[100, 1_700_000_000]]));
    expect(r.commitments).toEqual([
      expect.objectContaining({ leafIndex: 0, commitment: "123", encryptedNote: enc, blockNumber: 100, timestamp: 1_700_000_000 }),
    ]);
    expect(r.nullifiers.map((n) => n.nullifier)).toEqual(["999"]);
    const kinds = r.activity.map((a) => [a.kind, a.token, a.fee, a.feeRecipient]);
    expect(kinds).toEqual([
      ["shield", TOKEN, null, null],
      // A transfer without a fee reveals no asset.
      ["transfer", null, null, null],
      ["transfer", TOKEN, "7", USER],
      ["withdraw", TOKEN, "0", null],
    ]);
    expect(r.activity[0]!.account).toBe(USER);
    expect(r.activity[3]!.protocolFee).toBe("1");
  });
});

describe("shielded execution decoding", () => {
  const ADAPTER = "0x5555555555555555555555555555555555555555";
  const BROADCASTER = "0x6666666666666666666666666666666666666666";
  const MARKET = "0x7777777777777777777777777777777777777777";
  const HOLDER = "0x8888888888888888888888888888888888888888";
  const MAX = (1n << 256n) - 1n;

  it("records legs, outputs and the execution with its fee recipient", () => {
    const logs = [
      log("LegSpent", { adapter: ADAPTER, token: TOKEN, resource: 11n, amount: 100n, fee: 2n }, POOL, 100, shieldedPoolAbi, "e1"),
      log("LegSpent", { adapter: ADAPTER, token: ZERO, resource: 12n, amount: 5n, fee: 0n }, POOL, 100, shieldedPoolAbi, "e1"),
      log("OutputSettled", { adapter: ADAPTER, index: 0n, token: ZERO, shareId: 42n, amount: 10n ** 18n, fee: 0n, recipient: ZERO, protocolFee: 0n, leafIndex: 9n }, POOL, 100, shieldedPoolAbi, "e1"),
      log("OutputSettled", { adapter: ADAPTER, index: 1n, token: TOKEN, shareId: 0n, amount: 50n, fee: 1n, recipient: USER, protocolFee: 1n, leafIndex: MAX }, POOL, 100, shieldedPoolAbi, "e1"),
      log("Executed", { adapter: ADAPTER, legs: 2n, outputs: 2n, feeRecipient: BROADCASTER }, POOL, 100, shieldedPoolAbi, "e1"),
      log("PositionOpened", { positionId: 42n, kind: 1, market: MARKET, holder: HOLDER, used0: 100n, used1: 7n }, ADAPTER, 100, liquidityAdapterAbi, "e1"),
      log("PositionReduced", { positionId: 42n, units: 25n * 10n ** 16n, remainingUnits: 75n * 10n ** 16n, amount0: 30n, amount1: 2n }, ADAPTER, 101, liquidityAdapterAbi, "e2"),
      // Adapter events are read only from the configured liquidity adapter.
      log("PositionReduced", { positionId: 1n, units: 1n, remainingUnits: 0n, amount0: 0n, amount1: 0n }, MARKET, 101, liquidityAdapterAbi, "e3"),
    ];
    const r = decodeVaultLogs(logs, POOL, new Map([[100, 1], [101, 2]]), ADAPTER);
    const rows = r.activity.map((a) => [a.kind, a.token, a.account, a.amount, a.fee, a.feeRecipient, a.leafIndex, a.adapter]);
    expect(rows).toEqual([
      ["exec_leg", TOKEN, null, "100", "2", BROADCASTER, null, ADAPTER],
      // A share leg reveals no token.
      ["exec_leg", null, null, "5", "0", null, null, ADAPTER],
      // A share output became note 9.
      ["exec_output", null, null, String(10n ** 18n), "0", null, 9, ADAPTER],
      // A public payout names its recipient and has no note.
      ["exec_output", TOKEN, USER, "50", "1", BROADCASTER, null, ADAPTER],
      ["execute", null, null, null, null, BROADCASTER, null, ADAPTER],
    ]);
    expect(JSON.parse(r.activity[2]!.detail!)).toEqual({ index: 0, shareId: "42" });
    expect(r.activity[3]!.protocolFee).toBe("1");
    expect(r.positions).toEqual([expect.objectContaining({ positionId: "42", kind: "damm", market: MARKET, holder: HOLDER, used0: "100", used1: "7" })]);
    expect(r.positionEvents).toEqual([expect.objectContaining({ positionId: "42", remainingUnits: String(75n * 10n ** 16n), amount0: "30" })]);
  });
});
