/**
 * Curveil vault broadcaster (whitepaper 15.3). It pays gas for vault transfers, withdrawals and
 * shielded executions whose fee, recipients and payload are already fixed inside the user's proof,
 * and is paid that fee in the note's asset. It never sees keys or note contents. It does see
 * request timing and network metadata, which it does not log or store.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseManifest, type Manifest } from "@curveil/manifest";
import bundledTestnet from "@curveil/manifest/manifests/testnet.json";
import { decodeFunctionResult, encodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";
import liquidityAdapterAbiJson from "@curveil/manifest/abis/ShieldedLiquidityAdapter.json";
import {
  FEE_MULTIPLIER,
  Rejected,
  isAction,
  outputPlan,
  outputTokens,
  parseExecute,
  parseFees,
  perpsOutputTokens,
  prepare,
  prepareExecute,
  type Prepared,
} from "./actions";
import type { Env } from "./env";

export { NonceManager } from "./nonces";

const app = new Hono<{ Bindings: Env }>();
const MAX_BODY = 65_536; // a DLMM entry over many bins carries long distribution arrays
const QUOTE_TTL_SECONDS = 600;

app.use("/v1/*", async (c, next) =>
  cors({
    origin: (origin) => {
      const allowed = c.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  })(c, next),
);

async function manifestOf(env: Env): Promise<Manifest> {
  const raw = await env.CONFIG.get(`manifest:${env.NETWORK}`, "json");
  const kv = raw ? parseManifest(raw) : null;
  const bundled = env.NETWORK === "testnet" ? parseManifest(bundledTestnet) : null;
  const build = (m: Manifest | null) => (m ? Number(m.version.split(".").pop()) || 0 : -1);
  const m = build(bundled) > build(kv) ? bundled : kv;
  if (!m) throw new Error(`No manifest for ${env.NETWORK}`);
  return m;
}

const marketAbi = [
  { type: "function", name: "tokens", inputs: [], outputs: [{ type: "address" }, { type: "address" }], stateMutability: "view" },
] as const satisfies Abi;

async function ethCall(env: Env, to: Address, data: Hex): Promise<Hex> {
  const r = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(8_000),
  });
  const j = (await r.json()) as { result?: Hex; error?: { message: string } };
  if (!j.result) throw new Rejected("unavailable", "Could not read the market from the network. Try again.", 503);
  return j.result;
}

async function marketTokens(env: Env, market: Address): Promise<[Address, Address]> {
  const out = await ethCall(env, market, encodeFunctionData({ abi: marketAbi, functionName: "tokens" }));
  const [a, b] = decodeFunctionResult({ abi: marketAbi, functionName: "tokens", data: out });
  return [getAddress(a), getAddress(b)];
}

/** Parses an execute submission and resolves which token each output pays in. */
async function prepareExecuteFor(env: Env, manifest: Manifest, body: unknown, me: Address): Promise<Prepared> {
  const swap = manifest.contracts.ShieldedSwapAdapter?.address;
  const liquidity = manifest.contracts.ShieldedLiquidityAdapter?.address;
  const perps = manifest.contracts.ShieldedPerpsAdapter?.address;
  const adapters = new Set([swap, liquidity, perps].filter((x): x is string => Boolean(x)).map((x) => getAddress(x)));
  const args = parseExecute(body, adapters, Math.floor(Date.now() / 1000));
  if (perps && args.adapter === getAddress(perps)) {
    const usdg = getAddress(manifest.assets.find((a) => a.label === "USDG")!.address);
    return prepareExecute(args, perpsOutputTokens(args.params, args.outputs.length, usdg), me, parseFees(env.FEES));
  }
  const plan = outputPlan(swap && args.adapter === getAddress(swap) ? "swap" : "liquidity", args.params);
  let tokens: [Address, Address] | null = null;
  if (plan.kind === "entry") tokens = await marketTokens(env, plan.market);
  if (plan.kind === "exit") {
    const abi = liquidityAdapterAbiJson as Abi;
    const out = await ethCall(env, args.adapter, encodeFunctionData({ abi, functionName: "positionOf", args: [plan.positionId] }));
    const pos = decodeFunctionResult({ abi, functionName: "positionOf", data: out }) as { market: Address; kind: number };
    if (Number(pos.kind) !== 0) tokens = await marketTokens(env, getAddress(pos.market));
  }
  return prepareExecute(args, outputTokens(plan, tokens, args.outputs.length), me, parseFees(env.FEES));
}

const nonces = (env: Env) => env.NONCES.get(env.NONCES.idFromName(`broadcaster-${env.NETWORK}`));

async function gasBalance(env: Env, address: Address): Promise<bigint | null> {
  try {
    const r = await fetch(env.RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await r.json()) as { result?: string };
    return j.result ? BigInt(j.result) : null;
  } catch {
    return null;
  }
}

const DISCLOSURE =
  "This broadcaster pays gas and submits your proof-bound transaction. It sees when you send a request and your network address. It does not log or keep them, and it cannot change recipients, amounts or fees.";

app.get("/v1/broadcast/info", async (c) => {
  const manifest = await manifestOf(c.env);
  const pool = manifest.contracts.ShieldedPool;
  // Without a key this broadcaster cannot sign, so it reports no address and is never healthy.
  const address = c.env.BROADCASTER_KEY ? getAddress(await nonces(c.env).address()) : null;
  const balance = address ? await gasBalance(c.env, address) : null;
  const fees = parseFees(c.env.FEES);
  c.header("Cache-Control", "no-store");
  return c.json({
    network: c.env.NETWORK,
    chainId: manifest.chainId,
    pool: pool?.address ?? null,
    address,
    gasBalanceWei: balance?.toString() ?? null,
    healthy: Boolean(pool) && balance !== null && balance >= BigInt(c.env.MIN_GAS_BALANCE_WEI),
    fees: [...fees].map(([token, fee]) => ({ token, fee: fee.toString(), symbol: manifest.assets.find((a) => getAddress(a.address) === token)?.symbol ?? null })),
    // Fee per action = the asset's fee above times this factor (an execution costs more gas).
    feeMultipliers: Object.fromEntries(Object.entries(FEE_MULTIPLIER).map(([k, v]) => [k, Number(v)])),
    adapters: ["ShieldedSwapAdapter", "ShieldedLiquidityAdapter", "ShieldedPerpsAdapter"].map((n) => manifest.contracts[n]?.address).filter(Boolean),
    disclosure: DISCLOSURE,
  });
});

/** Fee terms to put inside a proof. Fees are flat per asset on testnet. */
app.post("/v1/broadcast/quote", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { action?: string; token?: string } | null;
  if (!body || !isAction(body.action) || typeof body.token !== "string")
    return c.json({ error: "bad_input", message: "Expected { action: transfer | withdraw | execute, token }." }, 400);
  const action = body.action;
  let token: Address;
  try {
    token = getAddress(body.token);
  } catch {
    return c.json({ error: "bad_input", message: "token must be an address" }, 400);
  }
  const base = parseFees(c.env.FEES).get(token);
  const fee = base === undefined ? undefined : base * FEE_MULTIPLIER[action];
  if (fee === undefined) return c.json({ error: "unsupported_asset", message: "This broadcaster does not take fees in that asset." }, 400);
  const address = await nonces(c.env).address();
  const balance = await gasBalance(c.env, address);
  if (balance === null || balance < BigInt(c.env.MIN_GAS_BALANCE_WEI))
    return c.json({ error: "unavailable", message: "The broadcaster is low on gas. Submit the transaction yourself or try later." }, 503);
  c.header("Cache-Control", "no-store");
  return c.json({ action, token, fee: fee.toString(), feeRecipient: address, validUntil: Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS, disclosure: DISCLOSURE });
});

app.post("/v1/broadcast/submit", async (c) => {
  if (c.env.SUBMITS) {
    // Keyed by connecting address only to bound abuse; counters are not stored.
    const { success } = await c.env.SUBMITS.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" });
    if (!success) return c.json({ error: "rate_limited", message: "Too many submissions. Wait a minute and try again." }, 429);
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY) return c.json({ error: "too_large", message: "Request too large." }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "bad_input", message: "Body must be JSON." }, 400);
  }
  const manifest = await manifestOf(c.env);
  const pool = manifest.contracts.ShieldedPool;
  if (!pool) return c.json({ error: "not_deployed", message: "The vault is not deployed on this network." }, 404);
  const stub = nonces(c.env);
  const me = await stub.address();
  let prepared: Prepared;
  try {
    prepared =
      (body as { action?: unknown } | null)?.action === "execute"
        ? await prepareExecuteFor(c.env, manifest, body, me)
        : prepare(body, me, parseFees(c.env.FEES), Math.floor(Date.now() / 1000));
  } catch (e) {
    if (e instanceof Rejected) return c.json({ error: e.code, message: e.message }, e.status as 400);
    throw e;
  }
  const balance = await gasBalance(c.env, me);
  if (balance === null || balance < BigInt(c.env.MIN_GAS_BALANCE_WEI))
    return c.json({ error: "unavailable", message: "The broadcaster is low on gas. Submit the transaction yourself or try later." }, 503);
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await stub.send({
    id,
    action: prepared.action,
    to: getAddress(pool.address),
    data: prepared.data,
    nullifiers: prepared.nullifiers.map(String),
    chainId: manifest.chainId,
  });
  if (!r.ok) return c.json({ error: r.code, message: r.message }, r.status as 400);
  c.header("Cache-Control", "no-store");
  return c.json(r.record, 202);
});

app.get("/v1/broadcast/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: "not_found", message: "Unknown request." }, 404);
  const rec = await nonces(c.env).status(id);
  if (!rec) return c.json({ error: "not_found", message: "Unknown request." }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(rec);
});

app.get("/health", (c) => c.text("ok"));
app.notFound((c) => c.json({ error: "not_found", message: `No route for ${c.req.method} ${c.req.path}` }, 404));
app.onError((err, c) => {
  console.error("broadcaster error", err.message);
  return c.json({ error: "internal", message: "Something went wrong on the broadcaster." }, 500);
});

export default { fetch: app.fetch };
