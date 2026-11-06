/**
 * Governance records (Phase 7): events of the timelock, the protocol treasuries and the buyback
 * burner, decoded into `governance_events`. Decoding is pure; see governance.test.ts. All public
 * chain data. Rows carry block_number and block_hash, so a reorg deletes rows above the ancestor.
 */
import { decodeEventLog, getAddress, type Abi, type Hex } from "viem";
import type { ContractEntry } from "@curveil/manifest";
import timelockAbiJson from "@curveil/manifest/abis/CurveilTimelock.json";
import treasuryAbiJson from "@curveil/manifest/abis/ProtocolTreasury.json";
import burnerAbiJson from "@curveil/manifest/abis/BuybackBurner.json";
import type { RpcLog } from "./rpc";

export const timelockAbi = timelockAbiJson as Abi;
export const treasuryAbi = treasuryAbiJson as Abi;
export const burnerAbi = burnerAbiJson as Abi;

/** Manifest name to address, for every governance contract deployed. */
export type GovernanceContracts = { byAddress: Map<string, string>; deployBlock: number };

export function governanceContracts(contracts: Record<string, ContractEntry | undefined>): GovernanceContracts | null {
  const byAddress = new Map<string, string>();
  let deployBlock = Infinity;
  for (const [name, c] of Object.entries(contracts)) {
    if (!c || !(name === "CurveilTimelock" || name === "BuybackBurner" || name.startsWith("Treasury"))) continue;
    byAddress.set(getAddress(c.address), name);
    deployBlock = Math.min(deployBlock, c.deployBlock);
  }
  return byAddress.size ? { byAddress, deployBlock } : null;
}

export type GovernanceRow = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  contract: string;
  kind: string;
  opId: string | null;
  data: Record<string, string>;
};

const num = (h: string) => Number(BigInt(h));
const abiFor = (name: string) => (name === "CurveilTimelock" ? timelockAbi : name === "BuybackBurner" ? burnerAbi : treasuryAbi);

function plain(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) out[k] = typeof v === "bigint" ? v.toString() : String(v);
  return out;
}

export function decodeGovernanceLogs(logs: RpcLog[], g: GovernanceContracts, timestamps: Map<number, number>): GovernanceRow[] {
  const out: GovernanceRow[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    const name = g.byAddress.get(getAddress(log.address));
    if (!name) continue;
    let ev: { eventName: string; args: unknown };
    try {
      ev = decodeEventLog({ abi: abiFor(name), data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }) as typeof ev;
    } catch {
      continue;
    }
    const data = plain(ev.args);
    const blockNumber = num(log.blockNumber);
    out.push({
      txHash: log.transactionHash,
      logIndex: num(log.logIndex),
      blockNumber,
      blockHash: log.blockHash,
      timestamp: timestamps.get(blockNumber) ?? 0,
      contract: name,
      kind: ev.eventName,
      opId: name === "CurveilTimelock" && data.id ? data.id : null,
      data,
    });
  }
  return out;
}

export function governanceStatements(db: D1Database, rows: GovernanceRow[]): D1PreparedStatement[] {
  return rows.map((r) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO governance_events (tx_hash, log_index, block_number, block_hash, timestamp, contract, kind, op_id, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.txHash, r.logIndex, r.blockNumber, r.blockHash, r.timestamp, r.contract, r.kind, r.opId, JSON.stringify(r.data)),
  );
}

export type QueueItem = {
  id: string;
  calls: { index: number; target: string; value: string; data: string }[];
  delaySeconds: number;
  scheduledAt: number;
  readyAt: number;
  scheduledTx: string;
  state: "pending" | "ready" | "executed" | "cancelled";
  doneAt: number | null;
  doneTx: string | null;
};

type EventRow = { tx_hash: string; timestamp: number; kind: string; op_id: string | null; data: string; block_number: number; log_index: number };

/** Timelock operations, newest first, with their state at `now` (seconds). Pure. */
export function timelockQueue(rows: EventRow[], now: number): QueueItem[] {
  const ops = new Map<string, QueueItem>();
  const sorted = [...rows].sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);
  for (const r of sorted) {
    if (!r.op_id) continue;
    const d = JSON.parse(r.data) as Record<string, string>;
    if (r.kind === "CallScheduled") {
      const delay = Number(d.delay ?? 0);
      const op = ops.get(r.op_id) ?? { id: r.op_id, calls: [], delaySeconds: delay, scheduledAt: r.timestamp, readyAt: r.timestamp + delay, scheduledTx: r.tx_hash, state: "pending", doneAt: null, doneTx: null };
      op.calls.push({ index: Number(d.index ?? 0), target: d.target ?? "", value: d.value ?? "0", data: d.data ?? "0x" });
      ops.set(r.op_id, op);
    } else if (r.kind === "CallExecuted" || r.kind === "Cancelled") {
      const op = ops.get(r.op_id);
      if (!op) continue;
      op.state = r.kind === "CallExecuted" ? "executed" : "cancelled";
      op.doneAt = r.timestamp;
      op.doneTx = r.tx_hash;
    }
  }
  for (const op of ops.values()) if (op.state === "pending" && now >= op.readyAt) op.state = "ready";
  return [...ops.values()].sort((a, b) => b.scheduledAt - a.scheduledAt);
}
