/**
 * NonceManager: one Durable Object per network serialises every transaction the broadcaster
 * signs, so nonces never collide. It simulates each call first (the broadcaster only pays gas
 * for calls that verify), refuses a second submission that spends a note already in flight,
 * tracks receipts on an alarm, and re-sends a transaction the network seems to have dropped.
 * Records keep only public data (transaction hash, status) and expire after seven days.
 */
import { DurableObject } from "cloudflare:workers";
import { decodeErrorResult, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Rejected, revertAbi } from "./actions";
import type { Env } from "./env";

export type RequestStatus = "submitted" | "confirmed" | "failed" | "dropped";
export type RequestRecord = {
  id: string;
  action: string;
  status: RequestStatus;
  txHash: Hex | null;
  nonce: number;
  blockNumber: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};
export type SendInput = { id: string; action: string; to: Address; data: Hex; nullifiers: string[]; chainId: number };
type Stored = RequestRecord & { raw: Hex; nullifiers: string[]; lastSentAt: number };

const POLL_MS = 2_000;
const RESEND_AFTER_MS = 45_000;
const DROP_AFTER_MS = 15 * 60_000;
const KEEP_MS = 7 * 24 * 3600_000;

const FRIENDLY: Record<string, string> = {
  NullifierAlreadySpent: "One of these notes has already been spent.",
  DuplicateNullifier: "The same note appears twice.",
  UnknownRoot: "The proof was built on an old view of the vault. Resync and prove again.",
  InvalidProof: "The proof does not verify against these arguments.",
  Expired: "The proof's deadline has passed. Make a new proof.",
  SpendingPaused: "Vault spending is paused right now.",
  BadFeeTerms: "The fee terms are not valid.",
  UnknownAsset: "The vault does not hold that asset.",
  UnknownResource: "The vault does not recognise the fee asset.",
  BadCiphertext: "A note ciphertext has the wrong length.",
  NotAFieldElement: "An argument is out of range.",
  AdapterNotEnabled: "The vault does not allow that market action.",
  AdapterExitOnly: "New positions and swaps through this adapter are paused; exits still work.",
  AssetNotShieldable: "The vault is not taking new deposits of that asset right now.",
  FeeExceedsOutput: "The output is smaller than the fee taken from it.",
  Undercollateralised: "The market action did not deliver what it reported.",
  NotAdapterShare: "That position belongs to a different adapter.",
  Slippage: "The market moved past your minimum. Make a new proof with a fresh quote.",
  InsufficientOutput: "The swap would return less than your minimum. Make a new proof with a fresh quote.",
  ActiveIdSlippage: "The market's active bin moved past your tolerance. Make a new proof.",
  PositionExists: "That position id is already taken. Try again.",
  UnknownPosition: "That position does not exist.",
  ClaimExists: "That claim id is already taken. Try again.",
  UnknownClaim: "That perps claim does not exist.",
  NotThisPosition: "That order belongs to a different position.",
  KeepMismatch: "The claim must be dropped once its position is closed (or kept while it is live). Refresh and try again.",
  BadInputs: "The notes sent do not match the perps action.",
  MarketClosed: "That market is not taking new positions right now.",
  FeeTooLow: "The execution fee is below the minimum.",
  BelowMinCollateral: "The collateral is below the market's minimum.",
  LeverageTooHigh: "The leverage is above the market's maximum.",
  NotOpen: "That position is not open.",
  RequestPending: "That position already has a close request waiting.",
  TooManyOrders: "That position already has the most orders allowed.",
};

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`RPC answered ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string; data?: unknown } };
  if (j.error) {
    const e = new Error(j.error.message) as Error & { data?: unknown };
    e.data = j.error.data;
    throw e;
  }
  return j.result as T;
}

function revertReason(e: unknown): string {
  const data = (e as { data?: unknown }).data;
  const hex = typeof data === "string" ? data : typeof (data as { data?: unknown })?.data === "string" ? (data as { data: string }).data : null;
  if (hex && hex.startsWith("0x") && hex.length >= 10) {
    try {
      const { errorName } = decodeErrorResult({ abi: revertAbi, data: hex as Hex });
      return FRIENDLY[errorName] ?? errorName;
    } catch {
      /* not a pool error */
    }
  }
  return e instanceof Error ? e.message.slice(0, 200) : "The call would revert.";
}

export class NonceManager extends DurableObject<Env> {
  private get account() {
    return privateKeyToAccount(this.env.BROADCASTER_KEY as Hex);
  }

  address(): Address {
    return this.account.address;
  }

  /** Errors do not survive the Durable Object RPC boundary intact, so failures come back as data. */
  async send(input: SendInput): Promise<{ ok: true; record: RequestRecord } | { ok: false; code: string; message: string; status: number }> {
    try {
      return { ok: true, record: await this.sendInner(input) };
    } catch (e) {
      if (e instanceof Rejected) return { ok: false, code: e.code, message: e.message, status: e.status };
      return { ok: false, code: "internal", message: e instanceof Error ? e.message.slice(0, 200) : "Unexpected error", status: 500 };
    }
  }

  private async sendInner(input: SendInput): Promise<RequestRecord> {
    const env = this.env;
    const me = this.account;
    for (const n of input.nullifiers) {
      if (await this.ctx.storage.get(`inflight:${n}`)) throw new Rejected("in_flight", "A transaction spending one of these notes is already pending.", 409);
    }

    // Simulate against the latest state; the broadcaster pays only for calls that succeed.
    let gas: bigint;
    try {
      gas = BigInt(await rpc<string>(env.RPC_URL, "eth_estimateGas", [{ from: me.address, to: input.to, data: input.data }]));
    } catch (e) {
      throw new Rejected("would_revert", revertReason(e), 422);
    }
    const gasPrice = BigInt(await rpc<string>(env.RPC_URL, "eth_gasPrice", []));

    let nonce = (await this.ctx.storage.get<number>("nonce")) ?? Number(BigInt(await rpc<string>(env.RPC_URL, "eth_getTransactionCount", [me.address, "pending"])));
    let raw: Hex | null = null;
    let hash: Hex | null = null;
    for (let attempt = 0; attempt < 2 && !hash; attempt++) {
      raw = await me.signTransaction({
        type: "eip1559",
        chainId: input.chainId,
        nonce,
        to: input.to,
        data: input.data,
        gas: (gas * 12n) / 10n,
        maxFeePerGas: gasPrice * 2n,
        maxPriorityFeePerGas: 0n,
        value: 0n,
      });
      try {
        hash = await rpc<Hex>(env.RPC_URL, "eth_sendRawTransaction", [raw]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/nonce/i.test(msg) && attempt === 0) {
          nonce = Number(BigInt(await rpc<string>(env.RPC_URL, "eth_getTransactionCount", [me.address, "pending"])));
          continue;
        }
        throw new Rejected("send_failed", `The network did not accept the transaction: ${msg.slice(0, 160)}`, 502);
      }
    }
    if (!hash || !raw) throw new Rejected("send_failed", "The network did not accept the transaction.", 502);

    const now = Date.now();
    const rec: Stored = {
      id: input.id,
      action: input.action,
      status: "submitted",
      txHash: hash,
      nonce,
      blockNumber: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      raw,
      nullifiers: input.nullifiers,
      lastSentAt: now,
    };
    await this.ctx.storage.put({ nonce: nonce + 1, [`req:${input.id}`]: rec, ...Object.fromEntries(input.nullifiers.map((n) => [`inflight:${n}`, input.id])) });
    await this.ensureAlarm();
    return publicView(rec);
  }

  async status(id: string): Promise<RequestRecord | null> {
    const rec = await this.ctx.storage.get<Stored>(`req:${id}`);
    return rec ? publicView(rec) : null;
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
  }

  async alarm(): Promise<void> {
    const env = this.env;
    const all = await this.ctx.storage.list<Stored>({ prefix: "req:" });
    let pending = 0;
    let resync = false;
    const now = Date.now();
    for (const [key, rec] of all) {
      if (rec.status !== "submitted") {
        if (now - rec.updatedAt > KEEP_MS) await this.ctx.storage.delete(key);
        continue;
      }
      try {
        const receipt = await rpc<{ status: string; blockNumber: string } | null>(env.RPC_URL, "eth_getTransactionReceipt", [rec.txHash]);
        if (receipt) {
          rec.status = receipt.status === "0x1" ? "confirmed" : "failed";
          rec.blockNumber = Number(BigInt(receipt.blockNumber));
          rec.error = receipt.status === "0x1" ? null : "The transaction reverted on-chain. The notes were not spent.";
        } else if (now - rec.createdAt > DROP_AFTER_MS) {
          rec.status = "dropped";
          rec.error = "The network dropped the transaction. The notes were not spent; try again.";
          resync = true;
        } else if (now - rec.lastSentAt > RESEND_AFTER_MS) {
          rec.lastSentAt = now;
          await rpc(env.RPC_URL, "eth_sendRawTransaction", [rec.raw]).catch(() => undefined);
        }
      } catch {
        /* RPC hiccup: try again next round */
      }
      if (rec.status !== "submitted") {
        rec.updatedAt = now;
        await this.ctx.storage.delete(rec.nullifiers.map((n) => `inflight:${n}`));
      } else {
        pending++;
      }
      await this.ctx.storage.put(key, rec);
    }
    if (resync) await this.ctx.storage.delete("nonce");
    if (pending > 0) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
  }
}

function publicView(r: Stored): RequestRecord {
  return {
    id: r.id,
    action: r.action,
    status: r.status,
    txHash: r.txHash,
    nonce: r.nonce,
    blockNumber: r.blockNumber,
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
