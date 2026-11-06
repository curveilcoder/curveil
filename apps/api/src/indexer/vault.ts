/**
 * Pure decoding of ShieldedPool and ShieldedLiquidityAdapter events into database rows (no I/O; see vault.test.ts).
 * Everything here is public chain data: commitments and ciphertexts, nullifiers, and the
 * public side of each action. The server never learns which notes belong to whom.
 */
import { decodeEventLog, getAddress, type Abi, type Hex } from "viem";
import shieldedPoolAbiJson from "@curveil/manifest/abis/ShieldedPool.json";
import liquidityAdapterAbiJson from "@curveil/manifest/abis/ShieldedLiquidityAdapter.json";
import type { RpcLog } from "./rpc";

export const shieldedPoolAbi = shieldedPoolAbiJson as Abi;
export const liquidityAdapterAbi = liquidityAdapterAbiJson as Abi;

type Meta = { txHash: string; logIndex: number; blockNumber: number; blockHash: string; timestamp: number };

export type CommitmentRow = Meta & { leafIndex: number; commitment: string; encryptedNote: string };
export type NullifierRow = Meta & { nullifier: string };
export type VaultActivityRow = Meta & {
  /**
   * execute: one shielded execution (adapter, leg and output counts, fee recipient).
   * exec_leg: what one leg sent to the adapter. exec_output: one settled output (a note when
   * leafIndex is set, a public payout when account is set). Share legs and outputs have no token.
   */
  kind: "shield" | "transfer" | "withdraw" | "fees_claimed" | "execute" | "exec_leg" | "exec_output";
  token: string | null;
  account: string | null;
  amount: string | null;
  fee: string | null;
  protocolFee: string | null;
  feeRecipient: string | null;
  leafIndex: number | null;
  adapter: string | null;
  /** JSON with action-specific public fields (resource, shareId, output index, counts). */
  detail: string | null;
};

/** A shielded liquidity position as opened (public: market, holder contract, amounts). */
export type PositionRow = Meta & {
  positionId: string;
  adapter: string;
  kind: "damm" | "dlmm";
  market: string;
  holder: string;
  used0: string;
  used1: string;
};

/** A partial or full exit from a position. */
export type PositionEventRow = Meta & {
  positionId: string;
  adapter: string;
  units: string;
  remainingUnits: string;
  amount0: string;
  amount1: string;
};

const MAX_UINT = (1n << 256n) - 1n;
const ZERO = "0x0000000000000000000000000000000000000000";

function meta(log: RpcLog, timestamps: Map<number, number>): Meta {
  const blockNumber = Number(BigInt(log.blockNumber));
  return {
    txHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber,
    blockHash: log.blockHash,
    timestamp: timestamps.get(blockNumber) ?? 0,
  };
}

export function decodeVaultLogs(logs: RpcLog[], pool: string, timestamps: Map<number, number>, liquidityAdapter?: string | null) {
  const commitments: CommitmentRow[] = [];
  const nullifiers: NullifierRow[] = [];
  const activity: VaultActivityRow[] = [];
  const positions: PositionRow[] = [];
  const positionEvents: PositionEventRow[] = [];
  const p = getAddress(pool);
  const la = liquidityAdapter ? getAddress(liquidityAdapter) : null;
  for (const log of logs) {
    if (log.removed) continue;
    const from = getAddress(log.address);
    if (la && from === la) {
      decodeAdapterLog(log, la, meta(log, timestamps), positions, positionEvents);
      continue;
    }
    if (from !== p) continue;
    let ev: { eventName: string; args: unknown };
    try {
      ev = decodeEventLog({ abi: shieldedPoolAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as Record<string, unknown>;
    const m = meta(log, timestamps);
    const none = { token: null, account: null, amount: null, fee: null, protocolFee: null, feeRecipient: null, leafIndex: null, adapter: null, detail: null };
    switch (ev.eventName) {
      case "NoteCommitted":
        commitments.push({ ...m, leafIndex: Number(a.leafIndex), commitment: String(a.commitment), encryptedNote: String(a.encryptedNote).toLowerCase() });
        break;
      case "NullifierSpent":
        nullifiers.push({ ...m, nullifier: String(a.nullifier) });
        break;
      case "Shielded":
        activity.push({ ...m, ...none, kind: "shield", token: getAddress(a.token as string), account: getAddress(a.depositor as string), amount: String(a.amount), leafIndex: Number(a.leafIndex) });
        break;
      case "Transferred": {
        const feeToken = getAddress(a.feeToken as string);
        const fee = BigInt(a.fee as bigint);
        activity.push({
          ...m,
          ...none,
          kind: "transfer",
          token: feeToken === ZERO ? null : feeToken,
          fee: fee === 0n ? null : fee.toString(),
          feeRecipient: fee === 0n ? null : getAddress(a.feeRecipient as string),
        });
        break;
      }
      case "Withdrawn": {
        const fee = BigInt(a.fee as bigint);
        activity.push({
          ...m,
          ...none,
          kind: "withdraw",
          token: getAddress(a.token as string),
          account: getAddress(a.recipient as string),
          amount: String(a.amount),
          fee: fee.toString(),
          protocolFee: String(a.protocolFee),
          feeRecipient: fee === 0n ? null : getAddress(a.feeRecipient as string),
        });
        break;
      }
      case "ProtocolFeesClaimed":
        activity.push({ ...m, ...none, kind: "fees_claimed", token: getAddress(a.token as string), account: getAddress(a.recipient as string), amount: String(a.amount) });
        break;
      case "LegSpent": {
        const token = getAddress(a.token as string);
        activity.push({
          ...m,
          ...none,
          kind: "exec_leg",
          adapter: getAddress(a.adapter as string),
          token: token === ZERO ? null : token,
          amount: String(a.amount),
          fee: String(a.fee),
          detail: JSON.stringify({ resource: String(a.resource) }),
        });
        break;
      }
      case "OutputSettled": {
        const token = getAddress(a.token as string);
        const recipient = getAddress(a.recipient as string);
        const leaf = BigInt(a.leafIndex as bigint);
        activity.push({
          ...m,
          ...none,
          kind: "exec_output",
          adapter: getAddress(a.adapter as string),
          token: token === ZERO ? null : token,
          account: recipient === ZERO ? null : recipient,
          amount: String(a.amount),
          fee: String(a.fee),
          protocolFee: String(a.protocolFee),
          leafIndex: leaf === MAX_UINT ? null : Number(leaf),
          detail: JSON.stringify({ index: Number(a.index), shareId: token === ZERO ? String(a.shareId) : null }),
        });
        break;
      }
      case "Executed": {
        const feeRecipient = getAddress(a.feeRecipient as string);
        activity.push({
          ...m,
          ...none,
          kind: "execute",
          adapter: getAddress(a.adapter as string),
          feeRecipient: feeRecipient === ZERO ? null : feeRecipient,
          detail: JSON.stringify({ legs: Number(a.legs), outputs: Number(a.outputs) }),
        });
        break;
      }
    }
  }
  // Leg and output fees go to the execution's fee recipient, which Executed reports once per tx.
  const feeTo = new Map(activity.filter((r) => r.kind === "execute").map((r) => [r.txHash, r.feeRecipient]));
  for (const r of activity) {
    if ((r.kind === "exec_leg" || r.kind === "exec_output") && r.fee && r.fee !== "0") r.feeRecipient = feeTo.get(r.txHash) ?? null;
  }
  return { commitments, nullifiers, activity, positions, positionEvents };
}

function decodeAdapterLog(log: RpcLog, adapter: string, m: Meta, positions: PositionRow[], events: PositionEventRow[]) {
  let ev: { eventName: string; args: unknown };
  try {
    ev = decodeEventLog({ abi: liquidityAdapterAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
  } catch {
    return;
  }
  const a = ev.args as Record<string, unknown>;
  if (ev.eventName === "PositionOpened") {
    positions.push({
      ...m,
      positionId: String(a.positionId),
      adapter,
      kind: Number(a.kind) === 1 ? "damm" : "dlmm",
      market: getAddress(a.market as string),
      holder: getAddress(a.holder as string),
      used0: String(a.used0),
      used1: String(a.used1),
    });
  } else if (ev.eventName === "PositionReduced") {
    events.push({
      ...m,
      positionId: String(a.positionId),
      adapter,
      units: String(a.units),
      remainingUnits: String(a.remainingUnits),
      amount0: String(a.amount0),
      amount1: String(a.amount1),
    });
  }
}

export function vaultStatements(db: D1Database, rows: ReturnType<typeof decodeVaultLogs>): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const c of rows.commitments) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO vault_commitments (leaf_index, commitment, encrypted_note, block_number, block_hash, tx_hash, log_index, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(c.leafIndex, c.commitment, c.encryptedNote, c.blockNumber, c.blockHash, c.txHash, c.logIndex, c.timestamp),
    );
  }
  for (const n of rows.nullifiers) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO vault_nullifiers (nullifier, block_number, block_hash, tx_hash, log_index, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(n.nullifier, n.blockNumber, n.blockHash, n.txHash, n.logIndex, n.timestamp),
    );
  }
  for (const r of rows.activity) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO vault_activity (tx_hash, log_index, block_number, block_hash, timestamp, kind, token, account, amount, fee,
           protocol_fee, fee_recipient, leaf_index, adapter, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(r.txHash, r.logIndex, r.blockNumber, r.blockHash, r.timestamp, r.kind, r.token, r.account, r.amount, r.fee, r.protocolFee, r.feeRecipient, r.leafIndex, r.adapter, r.detail),
    );
  }
  for (const p of rows.positions) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO vault_positions (position_id, adapter, kind, market, holder, used0, used1, block_number, block_hash, tx_hash, log_index, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(p.positionId, p.adapter, p.kind, p.market, p.holder, p.used0, p.used1, p.blockNumber, p.blockHash, p.txHash, p.logIndex, p.timestamp),
    );
  }
  for (const e of rows.positionEvents) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO vault_position_events (tx_hash, log_index, position_id, adapter, units, remaining_units, amount0, amount1, block_number, block_hash, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(e.txHash, e.logIndex, e.positionId, e.adapter, e.units, e.remainingUnits, e.amount0, e.amount1, e.blockNumber, e.blockHash, e.timestamp),
    );
  }
  return stmts;
}
