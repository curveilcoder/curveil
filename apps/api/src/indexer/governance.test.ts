import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { decodeGovernanceLogs, governanceContracts, timelockAbi, timelockQueue, treasuryAbi } from "./governance";
import type { RpcLog } from "./rpc";

const TL = "0x9D74Aa434b4031f4338E41465e6d076a870509E6";
const TR = "0x80b76d790755E0672aEC54f202aEED03AB73f395";
const ID = `0x${"ab".repeat(32)}` as Hex;
const entry = (address: string, deployBlock: number) => ({ address, deployBlock, deployTx: "0x", codeHash: "0x", abiHash: "0x", source: "", verified: true }) as never;
const g = governanceContracts({ CurveilTimelock: entry(TL, 10), TreasuryMarkets: entry(TR, 12), AssetRegistry: entry("0x0000000000000000000000000000000000000001", 1) })!;

function log(address: string, topics: Hex[], data: Hex, block: number, index: number): RpcLog {
  return { address, topics, data, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${index.toString(16)}`, transactionHash: `0x${block.toString(16).padStart(64, "0")}`, blockHash: `0x${"11".repeat(32)}`, removed: false } as RpcLog;
}

const scheduled = (block: number, delay: bigint) =>
  log(
    TL,
    encodeEventTopics({ abi: timelockAbi, eventName: "CallScheduled", args: { id: ID, index: 0n } }) as Hex[],
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [TR, 0n, "0x12345678", `0x${"00".repeat(32)}`, delay]),
    block,
    0,
  );

describe("governance", () => {
  it("finds only governance contracts and their earliest block", () => {
    expect([...g.byAddress.values()].sort()).toEqual(["CurveilTimelock", "TreasuryMarkets"]);
    expect(g.deployBlock).toBe(10);
  });

  it("decodes timelock and treasury events", () => {
    const released = log(
      TR,
      encodeEventTopics({ abi: treasuryAbi, eventName: "Released", args: { token: TR, to: TL } }) as Hex[],
      encodeAbiParameters([{ type: "uint256" }, { type: "string" }], [5n, "grant"]),
      21,
      1,
    );
    const rows = decodeGovernanceLogs([scheduled(20, 600n), released, log("0x0000000000000000000000000000000000000002", [], "0x", 22, 0)], g, new Map([[20, 1000]]));
    expect(rows.map((r) => [r.contract, r.kind])).toEqual([["CurveilTimelock", "CallScheduled"], ["TreasuryMarkets", "Released"]]);
    expect(rows[0]!.opId).toBe(ID);
    expect(rows[0]!.data.delay).toBe("600");
    expect(getAddress(rows[0]!.data.target!)).toBe(getAddress(TR));
    expect(rows[1]!.data).toMatchObject({ amount: "5", memo: "grant" });
  });

  it("works out each operation's state", () => {
    const [row] = decodeGovernanceLogs([scheduled(20, 600n)], g, new Map([[20, 1000]]));
    const asRow = (r: typeof row, kind = r!.kind, extra = {}) => ({ tx_hash: r!.txHash, timestamp: r!.timestamp, kind, op_id: r!.opId, data: JSON.stringify(r!.data), block_number: r!.blockNumber, log_index: r!.logIndex, ...extra });
    const base = asRow(row);
    expect(timelockQueue([base], 1500)[0]).toMatchObject({ state: "pending", readyAt: 1600, calls: [{ data: "0x12345678" }] });
    expect(timelockQueue([base], 1600)[0]!.state).toBe("ready");
    const exec = { ...base, kind: "CallExecuted", block_number: 30, timestamp: 1700, tx_hash: "0xdone" };
    expect(timelockQueue([exec, base], 1800)[0]).toMatchObject({ state: "executed", doneAt: 1700, doneTx: "0xdone" });
    expect(timelockQueue([base, { ...exec, kind: "Cancelled" }], 1800)[0]!.state).toBe("cancelled");
  });
});
