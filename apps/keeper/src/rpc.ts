/** Minimal JSON-RPC client for Workers: batched calls, one subrequest per batch (shared with the API indexer). */
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";

export type RpcCall = { method: string; params: unknown[] };

export class RpcError extends Error {}

const RETRY_DELAYS_MS = [400, 1200, 3000];

export async function rpcBatch<T = unknown>(url: string, calls: RpcCall[], timeoutMs = 10_000): Promise<T[]> {
  if (calls.length === 0) return [];
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })));
  let r: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Public RPCs rate-limit bursts; back off and retry a few times.
      if ((r.status === 429 || r.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      break;
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length) throw new RpcError(e instanceof Error ? e.message : "RPC unreachable");
      await new Promise((res) => setTimeout(res, RETRY_DELAYS_MS[attempt]));
    }
  }
  if (!r.ok) throw new RpcError(`RPC answered ${r.status}`);
  const out = (await r.json()) as { id: number; result?: T; error?: { message: string } }[] | { error?: { message: string } };
  if (!Array.isArray(out)) throw new RpcError(out.error?.message ?? "RPC returned a non-batch answer");
  const byId = new Map(out.map((x) => [x.id, x]));
  return calls.map((c, i) => {
    const x = byId.get(i);
    if (!x) throw new RpcError(`RPC dropped ${c.method}`);
    if (x.error) throw new RpcError(`${c.method}: ${x.error.message}`);
    return x.result as T;
  });
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const [r] = await rpcBatch<T>(url, [{ method, params }]);
  return r as T;
}

export const hex = (n: number | bigint) => `0x${n.toString(16)}`;

export type RpcLog = {
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
};

export type RpcBlock = { number: string; hash: string; parentHash: string; timestamp: string };

/** Multicall3 is at the same address on Robinhood Chain testnet and mainnet. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const multicallAbi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export type Call = { target: string; data: Hex };

/** Runs many view calls as a few eth_calls to Multicall3 (one HTTP request). Throws if any call fails. */
export async function multicall(url: string, calls: Call[], blockTag = "latest"): Promise<Hex[]> {
  if (calls.length === 0) return [];
  const chunks: Call[][] = [];
  for (let i = 0; i < calls.length; i += 150) chunks.push(calls.slice(i, i + 150));
  const raw = await rpcBatch<Hex>(
    url,
    chunks.map((chunk) => ({
      method: "eth_call",
      params: [
        {
          to: MULTICALL3,
          data: encodeFunctionData({
            abi: multicallAbi,
            functionName: "aggregate3",
            args: [chunk.map((c) => ({ target: c.target as Hex, allowFailure: true, callData: c.data }))],
          }),
        },
        blockTag,
      ],
    })),
  );
  const out: Hex[] = [];
  raw.forEach((data, i) => {
    const results = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data }) as readonly {
      success: boolean;
      returnData: Hex;
    }[];
    results.forEach((r, j) => {
      if (!r.success) throw new RpcError(`call to ${chunks[i]![j]!.target} reverted`);
      out.push(r.returnData);
    });
  });
  return out;
}

/** Like multicall, but a failing call comes back as null instead of failing the batch. */
export async function multicallSettled(url: string, calls: Call[], blockTag = "latest"): Promise<(Hex | null)[]> {
  if (calls.length === 0) return [];
  const chunks: Call[][] = [];
  for (let i = 0; i < calls.length; i += 150) chunks.push(calls.slice(i, i + 150));
  const raw = await rpcBatch<Hex>(
    url,
    chunks.map((chunk) => ({
      method: "eth_call",
      params: [
        {
          to: MULTICALL3,
          data: encodeFunctionData({
            abi: multicallAbi,
            functionName: "aggregate3",
            args: [chunk.map((c) => ({ target: c.target as Hex, allowFailure: true, callData: c.data }))],
          }),
        },
        blockTag,
      ],
    })),
  );
  return raw.flatMap((data) =>
    (decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data }) as readonly { success: boolean; returnData: Hex }[]).map((r) =>
      r.success ? r.returnData : null,
    ),
  );
}

export type Settled<T> = { ok: true; result: T } | { ok: false; message: string; data: Hex | null };

/** A batch where each call succeeds or fails on its own (for gas estimates that may revert). */
export async function rpcBatchSettled<T = unknown>(url: string, calls: RpcCall[], timeoutMs = 10_000): Promise<Settled<T>[]> {
  if (calls.length === 0) return [];
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })));
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new RpcError(`RPC answered ${r.status}`);
  const out = (await r.json()) as { id: number; result?: T; error?: { message: string; data?: unknown } }[];
  if (!Array.isArray(out)) throw new RpcError("RPC returned a non-batch answer");
  const byId = new Map(out.map((x) => [x.id, x]));
  return calls.map((_, i) => {
    const x = byId.get(i);
    if (!x) return { ok: false, message: "dropped", data: null };
    if (x.error) {
      const d = x.error.data;
      const data = typeof d === "string" && d.startsWith("0x") ? (d as Hex) : null;
      return { ok: false, message: x.error.message, data };
    }
    return { ok: true, result: x.result as T };
  });
}
