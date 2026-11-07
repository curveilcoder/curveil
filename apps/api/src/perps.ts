/**
 * Perps API. Live state (markets, positions, the liquidity vault) is read from the chain on each
 * request; the indexer's tables supply ownership, history, funding and price charts. Prices with
 * signed reports come from the keeper, which anyone may replace with their own.
 */
import { Hono } from "hono";
import { decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, isAddress, type Abi, type Hex } from "viem";
import lensAbiJson from "@curveil/manifest/abis/PerpLens.json";
import type { Manifest } from "@curveil/manifest";
import { loadManifest, type Env } from "./lib";
import { multicallSettled, type Call } from "./indexer/rpc";
import { oracleAdapterAbi, orderManagerAbi, perpEngineAbi, perpVaultAbi } from "./indexer/perps";

export const perps = new Hono<{ Bindings: Env }>();

const lensAbi = lensAbiJson as Abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;
const STATUS = ["none", "pending", "open", "closed", "liquidated", "cancelled"] as const;
const ORDER_STATUS = ["none", "active", "filled", "cancelled"] as const;

const notDeployed = { error: "not_deployed", message: "Perps are not deployed on this network yet." } as const;

/** JSON with bigints as strings. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const call = (target: string, abi: Abi, functionName: string, args: unknown[] = []): Call => ({
  target,
  data: encodeFunctionData({ abi, functionName, args } as never),
});
const read = <T>(abi: Abi, functionName: string, data: Hex | null | undefined): T | null =>
  data ? (decodeFunctionResult({ abi, functionName, data } as never) as T) : null;

type Perps = {
  manifest: Manifest;
  engine: string;
  orders: string;
  oracle: string;
  vault: string;
  lens: string;
  adapter: string | null;
  usdg: string;
  markets: NonNullable<Manifest["perps"]>["markets"];
};

async function perpsOf(env: Env): Promise<Perps | null> {
  const { manifest } = await loadManifest(env);
  const c = manifest.contracts;
  if (!manifest.perps || !c.PerpEngine || !c.OrderManager || !c.OracleAdapter || !c.PerpLiquidityVault || !c.PerpLens) return null;
  return {
    manifest,
    engine: c.PerpEngine.address,
    orders: c.OrderManager.address,
    oracle: c.OracleAdapter.address,
    vault: c.PerpLiquidityVault.address,
    lens: c.PerpLens.address,
    adapter: c.ShieldedPerpsAdapter?.address ?? null,
    usdg: manifest.assets.find((a) => a.label === "USDG")!.address,
    markets: manifest.perps.markets,
  };
}

type KeeperPrice = { market: number; price: string | null; priceWad: string | null; timestamp: number | null; sources: string[]; report: Hex | null; error?: string };

/** Current mark prices from the keeper (Pyth, or the testnet signer). Null when the keeper is unreachable. */
async function keeperPrices(env: Env): Promise<{ reports: KeeperPrice[]; signer: string | null; verifier: string } | null> {
  if (!env.KEEPER) return null;
  try {
    const r = await env.KEEPER.fetch("https://keeper/v1/prices", { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    return (await r.json()) as { reports: KeeperPrice[]; signer: string | null; verifier: string };
  } catch {
    return null;
  }
}

const fmt = (v: bigint | null | undefined, decimals: number) => (v === null || v === undefined ? null : formatUnits(v, decimals));

perps.get("/perps/markets", async (c) => {
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const scalars = ["minExecutionFee", "requestTimeout", "navMaxAge", "protocolShareBps", "totalReserved", "totalCollateral", "counts"];
  const vaultScalars = ["totalAssets", "freeLiquidity", "capacity", "totalSupply", "maxUtilizationBps", "lockSeconds", "depositCap"];
  const calls: Call[] = [
    ...scalars.map((f) => call(p.engine, perpEngineAbi, f)),
    ...vaultScalars.map((f) => call(p.vault, perpVaultAbi, f)),
    call(p.usdg, erc20Abi as unknown as Abi, "balanceOf", [p.vault]),
    ...p.markets.flatMap((m) => [
      call(p.engine, perpEngineAbi, "marketConfig", [m.id]),
      call(p.engine, perpEngineAbi, "marketState", [m.id]),
      call(p.oracle, oracleAdapterAbi, "latestPrice", [m.feedId]),
    ]),
  ];
  const since = Math.floor(Date.now() / 1000) - 86_400;
  const [results, keeper, volume] = await Promise.all([
    multicallSettled(c.env.RPC_URL, calls),
    keeperPrices(c.env),
    c.env.DB.prepare(
      `SELECT r.market_id AS market, COUNT(*) AS trades,
              SUM(CAST(CASE WHEN p.event = 'opened' THEN p.size ELSE p.size_delta END AS REAL)) AS volume
       FROM perp_positions p JOIN perp_requests r ON r.position_id = p.position_id AND r.event = 'created' AND r.kind = 'open'
       WHERE p.event IN ('opened', 'decreased') AND p.timestamp >= ? GROUP BY r.market_id`,
    )
      .bind(since)
      .all<{ market: number; trades: number; volume: number | null }>()
      .catch(() => ({ results: [] as { market: number; trades: number; volume: number | null }[] })),
  ]);
  const e = scalars.map((f, i) => read<unknown>(perpEngineAbi, f, results[i]));
  const vs = vaultScalars.map((f, i) => read<unknown>(perpVaultAbi, f, results[scalars.length + i]));
  const vaultBalance = read<bigint>(erc20Abi as unknown as Abi, "balanceOf", results[scalars.length + vaultScalars.length]);
  const base = scalars.length + vaultScalars.length + 1;
  const now = Math.floor(Date.now() / 1000);
  const navMaxAge = Number(e[2] ?? 0n);
  const markets = p.markets.map((m, i) => {
    const cfg = read<Record<string, unknown>>(perpEngineAbi, "marketConfig", results[base + i * 3]);
    const st = read<Record<string, bigint | number>>(perpEngineAbi, "marketState", results[base + i * 3 + 1]);
    const lp = read<readonly [bigint, bigint]>(oracleAdapterAbi, "latestPrice", results[base + i * 3 + 2]);
    const mark = keeper?.reports.find((r) => r.market === m.id);
    const stats = volume.results.find((v) => v.market === m.id);
    const rate = st ? BigInt(st.fundingRate as bigint) : 0n;
    return {
      ...m,
      config: cfg,
      state: st,
      openInterest: st ? { long: fmt(st.oiLong as bigint, 6), short: fmt(st.oiShort as bigint, 6) } : null,
      // Per hour, as a fraction of size: positive means longs pay shorts.
      fundingRatePerHour: formatUnits(rate * 3600n, 18),
      markPrice: mark?.price ?? null,
      markSources: mark?.sources ?? [],
      // Pyth refuses this feed for the keeper's API key (its plan does not cover it), so the market
      // cannot be priced until the plan changes. The site hides such markets.
      priceFeedDenied: Boolean(mark?.error?.startsWith("Hermes answered 403")),
      recordedPrice: lp ? { price: formatUnits(lp[0], 18), priceWad: lp[0].toString(), timestamp: Number(lp[1]), ageSeconds: lp[1] ? now - Number(lp[1]) : null } : null,
      volume24h: stats?.volume ? (stats.volume / 1e6).toFixed(2) : "0",
      trades24h: stats?.trades ?? 0,
    };
  });
  const counts = e[6] as readonly [bigint, bigint] | null;
  c.header("Cache-Control", "public, max-age=3");
  return c.json(
    plain({
      network: c.env.NETWORK,
      collateral: { address: p.usdg, decimals: 6 },
      priceSource: p.manifest.perps!.priceSource,
      priceSigner: p.manifest.perps!.priceSigner,
      contracts: { engine: p.engine, orderManager: p.orders, oracle: p.oracle, vault: p.vault, lens: p.lens, adapter: p.adapter },
      params: {
        minExecutionFee: e[0],
        requestTimeout: e[1],
        navMaxAge,
        protocolShareBps: e[3],
        totalReserved: e[4],
        totalCollateral: e[5],
        pendingRequests: counts?.[0] ?? null,
        openPositions: counts?.[1] ?? null,
      },
      vault: {
        address: p.vault,
        // Null when a market with open interest has no recent recorded price (the keeper records one every ~10 min).
        totalAssets: vs[0],
        freeLiquidity: vs[1],
        capacity: vs[2],
        totalSupply: vs[3],
        maxUtilizationBps: vs[4],
        lockSeconds: vs[5],
        depositCap: vs[6],
        balance: vaultBalance,
        // USDG per share (assets have 6 decimals, shares 18).
        sharePrice: vs[0] !== null && vs[3] ? Number(formatUnits(vs[0] as bigint, 6)) / Number(formatUnits(vs[3] as bigint, 18)) : null,
      },
      markets,
    }),
  );
});

perps.get("/perps/markets/:id/funding", async (c) => {
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const id = Number(c.req.param("id"));
  if (!p.markets.some((x) => x.id === id)) return c.json({ error: "unknown_market", message: "No such perps market." }, 404);
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
  const { results } = await c.env.DB.prepare(
    `SELECT rate, funding_long, funding_short, oi_long, oi_short, block_number, timestamp, tx_hash
     FROM funding_updates WHERE market_id = ? ORDER BY block_number DESC, log_index DESC LIMIT ?`,
  )
    .bind(id, limit)
    .all();
  c.header("Cache-Control", "public, max-age=10");
  return c.json({ market: id, updates: results });
});

perps.get("/perps/markets/:id/prices", async (c) => {
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const m = p.markets.find((x) => x.id === Number(c.req.param("id")));
  if (!m) return c.json({ error: "unknown_market", message: "No such perps market." }, 404);
  const since = Math.floor(Date.now() / 1000) - Math.min(Number(c.req.query("seconds") ?? 86_400) || 86_400, 30 * 86_400);
  const { results } = await c.env.DB.prepare(
    "SELECT price, report_timestamp AS timestamp FROM oracle_prices WHERE feed_id = ? AND report_timestamp >= ? ORDER BY report_timestamp LIMIT 5000",
  )
    .bind(m.feedId, since)
    .all<{ price: string; timestamp: number }>();
  c.header("Cache-Control", "public, max-age=15");
  return c.json({ market: m.id, feed: m.feed, prices: results.map((r) => ({ price: formatUnits(BigInt(r.price), 18), timestamp: r.timestamp })) });
});

// Reference candles for the chart: Coinbase's public candles, fetched here so browsers do not call
// an exchange directly. Trades settle at the oracle price (Pyth), not these. Cached at the edge for a minute.
// Coinbase sends at most 300 candles per request (and refuses a range that needs more), so each range fits.
const CANDLE_RANGES: Record<string, { granularity: number; seconds: number }> = {
  "5h": { granularity: 60, seconds: 5 * 3_600 },
  "1d": { granularity: 300, seconds: 86_400 },
  "3d": { granularity: 900, seconds: 3 * 86_400 },
  "1w": { granularity: 3_600, seconds: 7 * 86_400 },
  "12d": { granularity: 3_600, seconds: 12 * 86_400 },
  "1m": { granularity: 21_600, seconds: 30 * 86_400 },
  "75d": { granularity: 21_600, seconds: 75 * 86_400 },
  "290d": { granularity: 86_400, seconds: 290 * 86_400 },
};

/** Coinbase rows are [time, low, high, open, close, volume], newest first. Pure, so it is unit-tested. */
export function parseCandles(rows: unknown, since: number): { t: number; o: number; h: number; l: number; c: number; v?: number }[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is number[] => Array.isArray(r) && r.length >= 5 && r.slice(0, 5).every((x) => typeof x === "number" && Number.isFinite(x)))
    .map(([t, l, h, o, cl, v]) => ({ t: t!, o: o!, h: h!, l: l!, c: cl!, ...(typeof v === "number" && Number.isFinite(v) && v >= 0 ? { v } : {}) }))
    .filter((x) => x.t >= since && x.h >= x.l && x.l > 0)
    .sort((a, b) => a.t - b.t);
}

perps.get("/perps/markets/:id/candles", async (c) => {
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const m = p.markets.find((x) => x.id === Number(c.req.param("id")));
  if (!m) return c.json({ error: "unknown_market", message: "No such perps market." }, 404);
  const rangeKey = c.req.query("range") ?? "1d";
  const range = CANDLE_RANGES[rangeKey];
  if (!range) return c.json({ error: "bad_range", message: `Use range=${Object.keys(CANDLE_RANGES).join(", ")}.` }, 400);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(`https://cache.curveil/candles/${m.base}/${rangeKey}`);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return new Response(hit.body, hit);
  const now = Math.floor(Date.now() / 1000);
  const url = `https://api.exchange.coinbase.com/products/${m.base}-USD/candles?granularity=${range.granularity}&start=${new Date((now - range.seconds) * 1000).toISOString()}&end=${new Date(now * 1000).toISOString()}`;
  const ask = () => fetch(url, { headers: { "user-agent": "curveil-api/1.0 (+https://curveil.xyz)", accept: "application/json" }, signal: AbortSignal.timeout(6_000) }).catch(() => null);
  let r = await ask();
  // Coinbase rate-limits busy IPs now and then (429) or hiccups (5xx): try once more.
  if (!r || r.status === 429 || r.status >= 500) {
    await new Promise((ok) => setTimeout(ok, 400));
    r = await ask();
  }
  // A last good copy, kept for hours, so the chart still draws while Coinbase refuses.
  const staleKey = new Request(`https://cache.curveil/candles-stale/${m.base}/${rangeKey}`);
  if (!r || !r.ok) {
    const stale = cache ? await cache.match(staleKey) : undefined;
    if (stale) return new Response(stale.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=15", "x-candles-stale": "1" } });
    return c.json({ error: "unavailable", message: "Reference prices are unavailable right now.", upstream: r ? r.status : "no answer" }, 503);
  }
  const candles = parseCandles(await r.json().catch(() => null), now - range.seconds);
  const body = JSON.stringify({ market: m.id, source: "coinbase", pair: `${m.base}-USD`, granularity: range.granularity, candles });
  const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
  if (cache && candles.length) {
    c.executionCtx.waitUntil(cache.put(key, res.clone()));
    c.executionCtx.waitUntil(cache.put(staleKey, new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=21600" } })));
  }
  return res;
});

perps.get("/perps/markets/:id/activity", async (c) => {
  const id = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (SELECT p.event, p.position_id, p.price, p.size, p.size_delta, p.pnl, r.is_long, p.timestamp, p.tx_hash
     FROM perp_positions p JOIN perp_requests r ON r.position_id = p.position_id AND r.event = 'created' AND r.kind = 'open'
     WHERE r.market_id = ? AND p.event IN ('opened', 'decreased')
     UNION ALL
     SELECT 'liquidated', l.position_id, l.price, NULL, NULL, l.pnl, r.is_long, l.timestamp, l.tx_hash
     FROM liquidations l JOIN perp_requests r ON r.position_id = l.position_id AND r.event = 'created' AND r.kind = 'open'
     WHERE r.market_id = ?)
     ORDER BY timestamp DESC LIMIT 50`,
  )
    .bind(id, id)
    .all();
  c.header("Cache-Control", "public, max-age=5");
  return c.json({ market: id, activity: results });
});

/** Live view of positions by id, valued at the keeper's mark price (or the last recorded price). */
async function livePositions(env: Env, p: Perps, ids: string[]) {
  if (ids.length === 0) return [];
  const keeper = await keeperPrices(env);
  const calls: Call[] = ids.flatMap((id) => [call(p.engine, perpEngineAbi, "position", [BigInt(id)]), call(p.engine, perpEngineAbi, "paidOut", [BigInt(id)])]);
  calls.push(...p.markets.map((m) => call(p.oracle, oracleAdapterAbi, "latestPrice", [m.feedId])));
  const first = await multicallSettled(env.RPC_URL, calls);
  const recorded = new Map(p.markets.map((m, i) => [m.id, read<readonly [bigint, bigint]>(oracleAdapterAbi, "latestPrice", first[ids.length * 2 + i])?.[0] ?? 0n]));
  const markOf = (market: number) => {
    const k = keeper?.reports.find((r) => r.market === market)?.priceWad;
    return k ? BigInt(k) : recorded.get(market) ?? 0n;
  };
  const positions = ids.map((id, i) => {
    const pos = read<Record<string, any>>(perpEngineAbi, "position", first[i * 2]);
    return { id, pos, paidOut: read<bigint>(perpEngineAbi, "paidOut", first[i * 2 + 1]) ?? 0n };
  });
  const open = positions.filter((x) => x.pos && Number(x.pos.status) === 2);
  const vals = await multicallSettled(
    env.RPC_URL,
    open.map((x) => call(p.lens, lensAbi, "valuation", [BigInt(x.id), markOf(Number(x.pos!.market))])),
  );
  const valuation = new Map(open.map((x, i) => [x.id, read<Record<string, any>>(lensAbi, "valuation", vals[i])]));
  return positions
    .filter((x) => x.pos && Number(x.pos.status) !== 0)
    .map(({ id, pos, paidOut }) => {
      const market = Number(pos!.market);
      const v = valuation.get(id) ?? null;
      const mk = p.markets.find((m) => m.id === market);
      return {
        id,
        owner: pos!.owner,
        market,
        symbol: mk?.symbol ?? null,
        isLong: pos!.isLong,
        status: STATUS[Number(pos!.status)] ?? "unknown",
        version: Number(pos!.version),
        openedAt: Number(pos!.openedAt),
        size: pos!.size,
        collateral: pos!.collateral,
        reserve: pos!.reserve,
        entryPrice: pos!.entryPrice,
        pendingClose: pos!.pendingClose,
        paidOut,
        markPrice: v ? markOf(market) : null,
        valuation: v
          ? { pnl: v.pnl, funding: v.funding, equity: v.equity, liquidatable: v.liquidatable, liquidationPrice: v.liquidationPrice }
          : null,
      };
    });
}

perps.get("/perps/positions/:owner", async (c) => {
  const owner = c.req.param("owner");
  if (!isAddress(owner)) return c.json({ error: "bad_address", message: "Owner must be an address." }, 400);
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const who = getAddress(owner);
  const [{ results: ids }, { results: requests }] = await Promise.all([
    c.env.DB.prepare(
      "SELECT position_id FROM perp_requests WHERE owner = ? AND event = 'created' AND kind = 'open' ORDER BY block_number DESC LIMIT 100",
    )
      .bind(who)
      .all<{ position_id: string }>(),
    c.env.DB.prepare(
      `SELECT c.request_id, c.position_id, c.kind, c.market_id, c.is_long, c.size, c.collateral, c.acceptable_price, c.execution_fee,
              c.timestamp AS created_at, c.tx_hash, x.event AS outcome, x.price, x.reason, x.fee_charged, x.timestamp AS settled_at
       FROM perp_requests c LEFT JOIN perp_requests x ON x.request_id = c.request_id AND x.event != 'created'
       WHERE c.owner = ? AND c.event = 'created' ORDER BY c.block_number DESC LIMIT 100`,
    )
      .bind(who)
      .all(),
  ]);
  const positions = await livePositions(c.env, p, ids.map((r) => r.position_id));
  c.header("Cache-Control", "no-store");
  return c.json(plain({ owner: who, positions, requests }));
});

/** One position by id, with its full event history (used for shielded claims, owned by the adapter). */
perps.get("/perps/position/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d{1,78}$/.test(id)) return c.json({ error: "bad_id", message: "Position id must be a number." }, 400);
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const [[position], events, requests, liquidation, orders] = await Promise.all([
    livePositions(c.env, p, [id]),
    c.env.DB.prepare("SELECT * FROM perp_positions WHERE position_id = ? ORDER BY block_number, log_index").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM perp_requests WHERE position_id = ? ORDER BY block_number, log_index").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM liquidations WHERE position_id = ?").bind(id).first(),
    orderRows(c.env, p, "position_id", id),
  ]);
  if (!position) return c.json({ error: "unknown_position", message: "No such position." }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(plain({ position, events: events.results, requests: requests.results, liquidation, orders }));
});

/** Orders placed with their outcome, plus live status so a fill moments ago shows before the indexer catches up. */
async function orderRows(env: Env, p: NonNullable<Awaited<ReturnType<typeof perpsOf>>>, column: "owner" | "position_id", value: string) {
  const { results } = await env.DB.prepare(
    `SELECT o.order_id, o.position_id, o.kind, o.trigger_price, o.size, o.acceptable_price, o.execution_fee, o.expires_at,
            o.timestamp AS placed_at, o.tx_hash, x.event AS outcome, x.price, x.size_closed, x.reason, x.timestamp AS settled_at
     FROM perp_orders o LEFT JOIN perp_orders x ON x.order_id = o.order_id AND x.event != 'placed'
     WHERE o.${column} = ? AND o.event = 'placed' ORDER BY o.block_number DESC LIMIT 100`,
  )
    .bind(value)
    .all<Record<string, unknown> & { order_id: string }>();
  const live = await multicallSettled(env.RPC_URL, results.map((r) => call(p.orders, orderManagerAbi, "order", [BigInt(r.order_id)])));
  return results.map((r, i) => {
    const o = read<{ status: number }>(orderManagerAbi, "order", live[i]);
    return { ...r, status: o ? ORDER_STATUS[Number(o.status)] : null };
  });
}

perps.get("/perps/orders/:owner", async (c) => {
  const owner = c.req.param("owner");
  if (!isAddress(owner)) return c.json({ error: "bad_address", message: "Owner must be an address." }, 400);
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const orders = await orderRows(c.env, p, "owner", getAddress(owner));
  c.header("Cache-Control", "no-store");
  return c.json({ owner: getAddress(owner), orders });
});

perps.get("/perps/vault/:account", async (c) => {
  const account = c.req.param("account");
  if (!isAddress(account)) return c.json({ error: "bad_address", message: "Account must be an address." }, 400);
  const p = await perpsOf(c.env);
  if (!p) return c.json(notDeployed, 404);
  const who = getAddress(account);
  const [res, history] = await Promise.all([
    multicallSettled(c.env.RPC_URL, [
      call(p.vault, perpVaultAbi, "balanceOf", [who]),
      call(p.vault, perpVaultAbi, "unlockAt", [who]),
    ]),
    c.env.DB.prepare("SELECT event, assets, shares, nav_before, timestamp, tx_hash FROM perp_vault_events WHERE account = ? ORDER BY block_number DESC LIMIT 50")
      .bind(who)
      .all(),
  ]);
  const shares = read<bigint>(perpVaultAbi, "balanceOf", res[0]) ?? 0n;
  const [value] = shares > 0n ? await multicallSettled(c.env.RPC_URL, [call(p.vault, perpVaultAbi, "previewRedeem", [shares])]) : [null];
  c.header("Cache-Control", "no-store");
  return c.json(
    plain({
      account: who,
      shares,
      value: read<bigint>(perpVaultAbi, "previewRedeem", value),
      unlockAt: Number(read<bigint>(perpVaultAbi, "unlockAt", res[1]) ?? 0n),
      history: history.results,
    }),
  );
});

/**
 * Every private perps claim opened through the shielded adapter (public: claim id, position,
 * request). A browser matches its own claim notes to these locally; nothing here is per user.
 */
perps.get("/perps/claims", async (c) => {
  const p = await perpsOf(c.env);
  if (!p?.adapter) return c.json(notDeployed, 404);
  const fromBlock = Math.max(0, Number(c.req.query("fromBlock") ?? 0) || 0);
  const limit = 1000;
  const { results } = await c.env.DB.prepare(
    `SELECT claim_id, position_id, request_id, block_number, timestamp, tx_hash FROM perp_claims
     WHERE event = 'opened' AND block_number >= ? ORDER BY block_number, log_index LIMIT ?`,
  )
    .bind(fromBlock, limit)
    .all<{ claim_id: string; position_id: string; request_id: string; block_number: number; timestamp: number; tx_hash: string }>();
  c.header("Cache-Control", "public, max-age=3");
  return c.json({
    adapter: p.adapter,
    items: results.map((r) => ({ claimId: r.claim_id, positionId: r.position_id, requestId: r.request_id, blockNumber: r.block_number, timestamp: r.timestamp, txHash: r.tx_hash })),
    done: results.length < limit,
  });
});

/** Prices with signed reports, relayed from the keeper. Anyone may submit these reports. */
perps.get("/perps/prices", async (c) => {
  if (!c.env.KEEPER) return c.json({ error: "unavailable", message: "The price service is not connected." }, 503);
  const r = await c.env.KEEPER.fetch("https://keeper/v1/prices", { signal: AbortSignal.timeout(5_000) }).catch(() => null);
  if (!r) return c.json({ error: "unavailable", message: "The price service did not answer." }, 503);
  // Pass the keeper's answer through only when it is JSON; anything else (a proxy error page,
  // an empty body) becomes a JSON 503 so clients always get a parseable error.
  if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
    return c.json({ error: "unavailable", message: "The price service is not ready." }, 503);
  }
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

/** Wakes the keeper after a request is submitted, so it executes within seconds. */
perps.post("/perps/kick", async (c) => {
  if (!c.env.KEEPER) return c.json({ scheduled: false });
  const r = await c.env.KEEPER.fetch("https://keeper/v1/kick", { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => null);
  return c.json(r?.ok ? await r.json().catch(() => ({ scheduled: false })) : { scheduled: false });
});

export type KeeperHealth = { health: string; secondsSinceTick: number | null; gasLow: boolean; signing: boolean; lastError: string | null } | null;

/** Keeper health and oracle freshness for /v1/status. */
export async function perpsHealth(env: Env): Promise<unknown> {
  const p = await perpsOf(env).catch(() => null);
  if (!p) return null;
  const keeper = env.KEEPER
    ? await env.KEEPER.fetch("https://keeper/v1/status", { signal: AbortSignal.timeout(4_000) })
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, any>>) : null))
        .catch(() => null)
    : null;
  const res = await multicallSettled(env.RPC_URL, [
    call(p.engine, perpEngineAbi, "navMaxAge"),
    ...p.markets.flatMap((m) => [call(p.oracle, oracleAdapterAbi, "latestPrice", [m.feedId]), call(p.engine, perpEngineAbi, "marketState", [m.id])]),
  ]).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const navMaxAge = Number(read<bigint>(perpEngineAbi, "navMaxAge", res?.[0]) ?? 0n);
  const oracle = p.markets.map((m, i) => {
    const lp = read<readonly [bigint, bigint]>(oracleAdapterAbi, "latestPrice", res?.[1 + i * 2]);
    const st = read<{ oiLong: bigint; oiShort: bigint }>(perpEngineAbi, "marketState", res?.[2 + i * 2]);
    const age = lp && lp[1] > 0n ? now - Number(lp[1]) : null;
    const interest = st ? st.oiLong + st.oiShort > 0n : false;
    // Stale matters only with open interest: the vault cannot price its shares until a new price is recorded.
    return { market: m.id, symbol: m.symbol, recordedAgeSeconds: age, hasOpenInterest: interest, status: !interest ? "idle" : age !== null && age <= navMaxAge ? "fresh" : "stale" };
  });
  return {
    priceSource: p.manifest.perps!.priceSource,
    keeper: keeper
      ? {
          health: keeper.health,
          secondsSinceTick: keeper.secondsSinceTick,
          gasLow: keeper.gasLow,
          signing: keeper.signing,
          watching: keeper.watching,
          sources: keeper.sources,
          lastError: keeper.lastError,
        }
      : { health: "unreachable" },
    oracle,
  };
}
