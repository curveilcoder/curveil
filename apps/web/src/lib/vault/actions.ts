/**
 * Vault actions: pick notes, build the proof inputs, prove in the worker, then hand back
 * contract arguments for the broadcaster or for self-submission from the user's wallet.
 */
import {
  planTransfer,
  planWithdraw,
  selectNotes,
  toSolidityProof,
  type Recipient,
  type SolidityProof,
  type TransferPlan,
  type WithdrawPlan,
} from "@curveil/vault-core";
import { getAddress, zeroAddress, type Address } from "viem";
import { BROADCASTER_URL, NETWORK } from "../config";
import { prove, type ProveStage } from "./prover";
import { spendableNotes, vaultKeys, vaultTree, type VaultStatus } from "./store";
import { tNow } from "../i18n";

export const DEADLINE_SECONDS = 20 * 60;

export type BroadcasterInfo = {
  network: string;
  chainId: number;
  pool: Address | null;
  address: Address;
  gasBalanceWei: string | null;
  healthy: boolean;
  fees: { token: Address; fee: string; symbol: string | null }[];
  /** Fee per action = the asset's fee times this factor. */
  feeMultipliers?: Partial<Record<VaultActionKind, number>>;
  disclosure: string;
};

export type VaultActionKind = "transfer" | "withdraw" | "execute";

/** The broadcaster's fee for an action in an asset, or null when it does not take that asset. */
export function feeFor(info: BroadcasterInfo | null, action: VaultActionKind, token: Address | null | undefined): bigint | null {
  if (!info || !token) return null;
  const f = info.fees.find((x) => getAddress(x.token) === getAddress(token));
  if (!f) return null;
  return BigInt(f.fee) * BigInt(info.feeMultipliers?.[action] ?? 1);
}

export type Quote = { action: string; token: Address; fee: string; feeRecipient: Address; validUntil: number; disclosure: string };

async function bjson<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    // No content-type header: the JSON body goes as text/plain, so the browser sends a simple
    // request with no CORS preflight, the same way the site reaches the API.
    r = await fetch(`${BROADCASTER_URL}${path}`, { ...init, headers: { accept: "application/json" } });
  } catch {
    throw new Error(tNow("The broadcaster could not be reached. You can submit from your own wallet instead.", "无法连接广播器。你也可以改用自己的钱包提交。"));
  }
  const body = (await r.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!r.ok) throw new Error(body?.message ?? `The broadcaster answered ${r.status}.`);
  return body as T;
}

export const broadcasterInfo = () => bjson<BroadcasterInfo>("/v1/broadcast/info");
export const getQuote = (action: VaultActionKind, token: Address) =>
  bjson<Quote>("/v1/broadcast/quote", { method: "POST", body: JSON.stringify({ action, token }) });

export type BroadcastRecord = { id: string; status: "submitted" | "confirmed" | "failed" | "dropped"; txHash: string | null; blockNumber: number | null; error: string | null };

/** Sends a proof-bound call to the broadcaster: { action, ...body }. */
export function submitToBroadcaster(action: VaultActionKind, body: Record<string, unknown>) {
  return bjson<BroadcastRecord>("/v1/broadcast/submit", { method: "POST", body: JSON.stringify({ action, ...body }) });
}
export const broadcastStatus = (id: string) => bjson<BroadcastRecord>(`/v1/broadcast/${id}`);

/** Bigints to decimal strings, recursively (the broadcaster's JSON format). */
export function toJson(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v;
}

/**
 * A proven action ready to submit: what the contract must still recognise (roots), what it
 * spends (nullifiers), what it returns to this account (incoming), and the two ways to send it.
 */
export type Ready = {
  roots: bigint[];
  nullifiers: bigint[];
  incoming: { commitment: string; resource: string; amount: string }[];
  broadcast: { action: VaultActionKind; body: Record<string, unknown> };
  self: { functionName: VaultActionKind; args: readonly unknown[] };
};

export function readyTransfer(p: Prepared<TransferPlan>, incoming: Ready["incoming"]): Ready {
  return {
    roots: [p.plan.args.root],
    nullifiers: p.plan.args.nullifiers,
    incoming,
    broadcast: { action: "transfer", body: { proof: toJson(p.proof), args: toJson(p.plan.args) } as Record<string, unknown> },
    self: { functionName: "transfer", args: [p.proof, p.plan.args] },
  };
}

export function readyWithdraw(p: Prepared<WithdrawPlan>, incoming: Ready["incoming"]): Ready {
  return {
    roots: [p.plan.args.root],
    nullifiers: p.plan.args.nullifiers,
    incoming,
    broadcast: { action: "withdraw", body: { proof: toJson(p.proof), args: toJson(p.plan.args) } as Record<string, unknown> },
    self: { functionName: "withdraw", args: [p.proof, p.plan.args] },
  };
}

export function artifacts(status: VaultStatus, name: "transfer" | "withdraw") {
  const c = status.circuits.find((x) => x.name === name);
  if (!c) throw new Error(`The ${name} circuit is not published in this network's manifest.`);
  return {
    wasm: { url: `/circuits/${NETWORK}/${name}.wasm`, sha256: c.wasmHash },
    zkey: { url: `/circuits/${NETWORK}/${name}.zkey`, sha256: c.zkeyHash },
  };
}

export function ready(status: VaultStatus) {
  const keys = vaultKeys();
  const tree = vaultTree();
  if (!keys) throw new Error(tNow("Unlock the vault first.", "请先解锁金库。"));
  if (!tree) throw new Error(tNow("The vault has not synced yet.", "金库尚未同步。"));
  if (status.spendPaused) throw new Error(tNow("Vault spending is paused right now.", "金库支出目前已暂停。"));
  return { keys, tree };
}

export type Prepared<P> = { plan: P; proof: SolidityProof; ms: number; inputs: number };

export function pick(resource: string, needed: bigint) {
  const notes = spendableNotes(resource).map((n) => ({ leafIndex: n.leafIndex, resource: BigInt(n.resource), amount: n.amountBig, blinding: BigInt(n.blinding) }));
  const sel = selectNotes(notes, needed);
  if (!sel) {
    const total = notes.reduce((s, n) => s + n.amount, 0n);
    if (total < needed) throw new Error(tNow("Your spendable balance does not cover this amount and fee.", "你的可用余额不足以支付该金额和费用。"));
    throw new Error(tNow("This amount needs more than two of your notes. Combine notes first (Notes tab), then try again.", "该金额需要用到你两张以上的票据。请先合并票据（票据标签页），然后重试。"));
  }
  return sel;
}

export function checkSignals(plan: { publicSignals: bigint[] }, publicSignals: string[]) {
  if (plan.publicSignals.map(String).join() !== publicSignals.join()) throw new Error(tNow("The proof's public inputs do not match the plan. Nothing was sent.", "证明的公开输入与计划不符。没有发送任何内容。"));
}

export async function prepareTransfer(o: {
  status: VaultStatus;
  /** An asset, or null with `resource` set (a liquidity position's share notes). */
  token: Address | null;
  resource?: string;
  amount: bigint;
  to: Recipient;
  fee: bigint;
  feeRecipient: Address;
  onStage?: (s: ProveStage) => void;
}): Promise<Prepared<TransferPlan>> {
  const { keys, tree } = ready(o.status);
  const asset = o.token ? o.status.assets.find((a) => getAddress(a.address) === getAddress(o.token!)) : null;
  const resource = asset?.resource ?? o.resource;
  if (!resource) throw new Error(tNow("The vault does not hold that asset.", "金库不持有该资产。"));
  const inputs = pick(resource, o.amount + o.fee);
  const plan = planTransfer({
    spendingKey: keys.spendingKey,
    tree,
    chainId: o.status.chainId,
    pool: o.status.pool,
    domain: BigInt(o.status.noteDomain),
    resource: BigInt(resource),
    inputs,
    fee: o.fee,
    feeRecipient: o.fee > 0n ? o.feeRecipient : zeroAddress,
    deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
    to: o.to,
    amount: o.amount,
    changeTo: keys,
  });
  const r = await prove(plan.circuitInput, artifacts(o.status, "transfer"), o.onStage);
  checkSignals(plan, r.publicSignals);
  return { plan, proof: toSolidityProof(r.proof), ms: r.ms, inputs: inputs.length };
}

export async function prepareWithdraw(o: {
  status: VaultStatus;
  token: Address;
  amount: bigint;
  recipient: Address;
  fee: bigint;
  feeRecipient: Address;
  onStage?: (s: ProveStage) => void;
}): Promise<Prepared<WithdrawPlan>> {
  const { keys, tree } = ready(o.status);
  const asset = o.status.assets.find((a) => getAddress(a.address) === getAddress(o.token));
  if (!asset) throw new Error(tNow("The vault does not hold that asset.", "金库不持有该资产。"));
  const inputs = pick(asset.resource, o.amount + o.fee);
  const plan = planWithdraw({
    spendingKey: keys.spendingKey,
    tree,
    chainId: o.status.chainId,
    pool: o.status.pool,
    domain: BigInt(o.status.noteDomain),
    resource: BigInt(asset.resource),
    inputs,
    fee: o.fee,
    feeRecipient: o.fee > 0n ? o.feeRecipient : zeroAddress,
    deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
    token: asset.address,
    amount: o.amount,
    recipient: o.recipient,
    withdrawFeeBps: o.status.withdrawFeeBps,
    changeTo: keys,
  });
  const r = await prove(plan.circuitInput, artifacts(o.status, "withdraw"), o.onStage);
  checkSignals(plan, r.publicSignals);
  return { plan, proof: toSolidityProof(r.proof), ms: r.ms, inputs: inputs.length };
}

/** Combines the two largest spendable notes of an asset into one (a transfer to yourself). */
export function combineCandidates(resource: string) {
  const notes = spendableNotes(resource).sort((a, b) => (a.amountBig < b.amountBig ? 1 : -1));
  return notes.length >= 2 ? notes.slice(0, 2) : null;
}

/**
 * The asset to pay the broadcaster's fee in for an execution: the first candidate it accepts
 * whose amount comfortably covers the fee (callers list candidates by preference).
 */
export function pickFeeToken(info: BroadcasterInfo | null, candidates: { address: Address; available: bigint }[]): Address | null {
  for (const c of candidates) {
    const f = feeFor(info, "execute", c.address);
    if (f !== null && c.available >= f * 2n) return c.address;
  }
  return null;
}
