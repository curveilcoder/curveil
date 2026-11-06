import { Hono } from "hono";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Hex } from "viem";
import { indexerStub, type Env } from "./lib";
import { multicall, type Call } from "./indexer/rpc";
import { dammPoolAbi, dlmmPairAbi } from "./indexer/process";
import { ownMetadataHash } from "./launch";

export const markets = new Hono<{ Bindings: Env }>();

type PoolRow = {
  address: string;
  kind: "damm" | "dlmm";
  factory: string;
  token0: string;
  token1: string;
  fee_tier: number | null;
  base_fee_bps: number;
  max_fee_bps: number | null;
  protocol_share_bps: number;
  bin_step: number | null;
  created_block: number;
  created_tx: string;
  creator: string | null;
  launch_token: string | null;
  reserve0: string | null;
  reserve1: string | null;
  fee_bps: number | null;
  active_id: number | null;
  total_supply: string | null;
  price: number | null;
  state_block: number | null;
  t0_symbol: string;
  t0_decimals: number;
  t0_quote: number;
  t1_symbol: string;
  t1_decimals: number;
  t1_quote: number;
  t0_name: string | null;
  t1_name: string | null;
  t0_meta: string | null;
  t1_meta: string | null;
  volume_24h: number | null;
  fees_24h: number | null;
  swaps_24h: number;
  last_swap_at: number | null;
};

const POOL_SELECT = `
  SELECT p.*, s.reserve0, s.reserve1, s.fee_bps, s.active_id, s.total_supply, s.price, s.block_number AS state_block,
    t0.symbol AS t0_symbol, t0.decimals AS t0_decimals, t0.is_quote AS t0_quote,
    t1.symbol AS t1_symbol, t1.decimals AS t1_decimals, t1.is_quote AS t1_quote,
    t0.name AS t0_name, t1.name AS t1_name, l0.metadata_uri AS t0_meta, l1.metadata_uri AS t1_meta,
    (SELECT SUM(quote_value) FROM swaps w WHERE w.pool = p.address AND w.timestamp > ?1) AS volume_24h,
    (SELECT SUM(quote_fee) FROM swaps w WHERE w.pool = p.address AND w.timestamp > ?1) AS fees_24h,
    (SELECT COUNT(*) FROM swaps w WHERE w.pool = p.address AND w.timestamp > ?1) AS swaps_24h,
    (SELECT MAX(timestamp) FROM swaps w WHERE w.pool = p.address) AS last_swap_at,
    (SELECT e.token FROM launch_events e WHERE e.kind = 'graduated' AND json_extract(e.data, '$.pool') = p.address LIMIT 1) AS launch_token
  FROM pools p
  LEFT JOIN pool_state s ON s.pool = p.address
  JOIN tokens t0 ON t0.address = p.token0
  JOIN tokens t1 ON t1.address = p.token1
  LEFT JOIN launches l0 ON l0.token = p.token0
  LEFT JOIN launches l1 ON l1.token = p.token1`;

/** A launch token's image, when its metadata is hosted here (we never point at other hosts). */
const launchImage = (uri: string | null, origin: string) => (uri && ownMetadataHash(uri, origin) ? `${uri}/image` : null);

function shapePool(r: PoolRow, origin: string) {
  const a0 = r.reserve0 ? Number(r.reserve0) / 10 ** r.t0_decimals : null;
  const a1 = r.reserve1 ? Number(r.reserve1) / 10 ** r.t1_decimals : null;
  let tvl: number | null = null;
  if (a0 !== null && a1 !== null && r.price) {
    if (r.t1_quote) tvl = a1 + a0 * r.price;
    else if (r.t0_quote) tvl = a0 + a1 / r.price;
  }
  return {
    address: r.address,
    kind: r.kind,
    factory: r.factory,
    token0: { address: r.token0, symbol: r.t0_symbol, name: r.t0_name, decimals: r.t0_decimals, isQuote: r.t0_quote === 1, image: launchImage(r.t0_meta, origin) },
    token1: { address: r.token1, symbol: r.t1_symbol, name: r.t1_name, decimals: r.t1_decimals, isQuote: r.t1_quote === 1, image: launchImage(r.t1_meta, origin) },
    fees: {
      currentBps: r.fee_bps ?? r.base_fee_bps,
      baseBps: r.base_fee_bps,
      maxBps: r.max_fee_bps,
      protocolShareBps: r.protocol_share_bps,
      tier: r.fee_tier,
    },
    binStep: r.bin_step,
    activeId: r.active_id,
    reserves: { raw0: r.reserve0, raw1: r.reserve1, amount0: a0, amount1: a1 },
    lpSupply: r.total_supply,
    price: r.price,
    tvlQuote: tvl,
    volume24hQuote: r.volume_24h ?? 0,
    fees24hQuote: r.fees_24h ?? 0,
    swaps24h: r.swaps_24h,
    lastSwapAt: r.last_swap_at,
    stateBlock: r.state_block,
    createdBlock: r.created_block,
    createdTx: r.created_tx,
    // A pool made by a launch's graduation has no creator of its own: whoever triggered it only finished the curve.
    creator: r.launch_token ? null : r.creator,
    launch: r.launch_token,
  };
}

const dayAgo = () => Math.floor(Date.now() / 1000) - 86_400;

/**
 * Pools left out of every listing. A pool cannot be deleted on chain, so one created by mistake
 * can be hidden here instead. It still answers at /markets/:pool. Addresses are checksummed.
 */
const HIDDEN_POOLS = new Set<string>([]);

async function finalizedBlock(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT finalized_block FROM indexer_state WHERE id = 1").first<{ finalized_block: number | null }>();
  return row?.finalized_block ?? null;
}

markets.get("/markets", async (c) => {
  const creator = c.req.query("creator");
  const who = creator ? addr(creator) : null;
  if (creator && !who) return c.json({ error: "bad_address", message: "That creator is not a valid address." }, 400);
  const { results } = await (who
    ? c.env.DB.prepare(`${POOL_SELECT} WHERE p.creator = ?2 ORDER BY p.created_block DESC`).bind(dayAgo(), who)
    : c.env.DB.prepare(`${POOL_SELECT} ORDER BY volume_24h DESC NULLS LAST, p.created_block`).bind(dayAgo())
  ).all<PoolRow>();
  const origin = new URL(c.req.url).origin;
  const pools = results
    .map((r) => shapePool(r, origin))
    .filter((p) => !HIDDEN_POOLS.has(getAddress(p.address)) && (!who || p.creator === who));
  c.header("Cache-Control", "public, max-age=5");
  return c.json({ network: c.env.NETWORK, pools });
});

markets.get("/markets/:pool", async (c) => {
  const pool = addr(c.req.param("pool"));
  if (!pool) return c.json({ error: "bad_address", message: "That is not a valid pool address." }, 400);
  const row = await c.env.DB.prepare(`${POOL_SELECT} WHERE p.address = ?2`).bind(dayAgo(), pool).first<PoolRow>();
  if (!row) return c.json({ error: "not_found", message: "No Curveil pool at that address on this network." }, 404);
  c.header("Cache-Control", "public, max-age=5");
  return c.json({ pool: shapePool(row, new URL(c.req.url).origin) });
});

markets.get("/markets/:pool/swaps", async (c) => {
  const pool = addr(c.req.param("pool"));
  if (!pool) return c.json({ error: "bad_address", message: "That is not a valid pool address." }, 400);
  const limit = clamp(Number(c.req.query("limit") ?? 50), 1, 200);
  const [rows, fin] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM swaps WHERE pool = ? ORDER BY block_number DESC, log_index DESC LIMIT ?").bind(pool, limit).all(),
    finalizedBlock(c.env),
  ]);
  c.header("Cache-Control", "public, max-age=3");
  return c.json({ swaps: rows.results.map((s: any) => shapeSwap(s, fin)) });
});

markets.get("/accounts/:address/activity", async (c) => {
  const account = addr(c.req.param("address"));
  if (!account) return c.json({ error: "bad_address", message: "That is not a valid address." }, 400);
  const [swaps, liq, fin] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM swaps WHERE recipient = ?1 OR sender = ?1 ORDER BY block_number DESC LIMIT 50").bind(account).all(),
    c.env.DB.prepare("SELECT * FROM liquidity_events WHERE owner = ? ORDER BY block_number DESC LIMIT 50").bind(account).all(),
    finalizedBlock(c.env),
  ]);
  const items = [
    ...swaps.results.map((s: any) => ({ type: "swap" as const, ...shapeSwap(s, fin) })),
    ...liq.results.map((l: any) => ({
      type: "liquidity" as const,
      kind: l.kind,
      txHash: l.tx_hash,
      blockNumber: l.block_number,
      timestamp: l.timestamp,
      pool: l.pool,
      amount0: l.amount0,
      amount1: l.amount1,
      shares: l.shares,
      bins: l.bins ? JSON.parse(l.bins) : null,
      finality: fin !== null && l.block_number <= fin ? "final" : "sequencer",
    })),
  ].sort((a, b) => b.blockNumber - a.blockNumber);
  c.header("Cache-Control", "no-store");
  return c.json({ account, items: items.slice(0, 50) });
});

/** Live positions, read from the chain at request time; the indexer only says where to look. */
markets.get("/accounts/:address/positions", async (c) => {
  const account = addr(c.req.param("address"));
  if (!account) return c.json({ error: "bad_address", message: "That is not a valid address." }, 400);
  const db = c.env.DB;
  const [{ results: dammPools }, { results: binRows }] = await Promise.all([
    db.prepare("SELECT address, token0, token1 FROM pools WHERE kind = 'damm'").all<{ address: string; token0: string; token1: string }>(),
    db
      .prepare("SELECT pool, bins FROM liquidity_events WHERE owner = ? AND kind IN ('add', 'transfer_in') AND bins IS NOT NULL")
      .bind(account)
      .all<{ pool: string; bins: string }>(),
  ]);
  const bins = new Map<string, Set<number>>();
  for (const r of binRows) {
    const set = bins.get(r.pool) ?? new Set<number>();
    for (const id of JSON.parse(r.bins) as number[]) set.add(id);
    bins.set(r.pool, set);
  }

  const calls: Call[] = [];
  const call = (target: string, data: Hex) => calls.push({ target, data });
  for (const p of dammPools) {
    call(p.address, encodeFunctionData({ abi: dammPoolAbi, functionName: "balanceOf", args: [account] }));
    call(p.address, encodeFunctionData({ abi: dammPoolAbi, functionName: "pendingFees", args: [account] }));
    call(p.address, encodeFunctionData({ abi: dammPoolAbi, functionName: "getReserves" }));
    call(p.address, encodeFunctionData({ abi: dammPoolAbi, functionName: "totalSupply" }));
  }
  const dlmmList = [...bins.entries()].map(([pool, ids]) => ({ pool, ids: [...ids].sort((a, b) => a - b) }));
  for (const d of dlmmList) {
    for (const id of d.ids) {
      call(d.pool, encodeFunctionData({ abi: dlmmPairAbi, functionName: "getPosition", args: [id, account] }));
      call(d.pool, encodeFunctionData({ abi: dlmmPairAbi, functionName: "getBin", args: [id] }));
    }
    call(d.pool, encodeFunctionData({ abi: dlmmPairAbi, functionName: "pendingFees", args: [account, d.ids] }));
  }
  const res = await multicall(c.env.RPC_URL, calls);
  let k = 0;
  const dec = (abi: typeof dammPoolAbi, functionName: string) =>
    decodeFunctionResult({ abi, functionName, data: res[k++]! } as any) as any;

  const damm = [];
  for (const p of dammPools) {
    const balance = dec(dammPoolAbi, "balanceOf") as bigint;
    const [fee0, fee1] = dec(dammPoolAbi, "pendingFees") as [bigint, bigint];
    const [r0, r1] = dec(dammPoolAbi, "getReserves") as [bigint, bigint];
    const supply = dec(dammPoolAbi, "totalSupply") as bigint;
    if (balance === 0n && fee0 === 0n && fee1 === 0n) continue;
    damm.push({
      pool: p.address,
      lpBalance: balance.toString(),
      shareOfPool: supply > 0n ? Number((balance * 1_000_000n) / supply) / 1_000_000 : 0,
      amount0: supply > 0n ? ((balance * r0) / supply).toString() : "0",
      amount1: supply > 0n ? ((balance * r1) / supply).toString() : "0",
      pendingFees0: fee0.toString(),
      pendingFees1: fee1.toString(),
    });
  }
  const dlmm = [];
  for (const d of dlmmList) {
    const positionBins = [];
    let x = 0n;
    let y = 0n;
    for (const id of d.ids) {
      const pos = dec(dlmmPairAbi, "getPosition") as { shares: bigint };
      const bin = dec(dlmmPairAbi, "getBin") as { x: bigint; y: bigint; shares: bigint };
      if (pos.shares === 0n) continue;
      const bx = bin.shares > 0n ? (pos.shares * bin.x) / bin.shares : 0n;
      const by = bin.shares > 0n ? (pos.shares * bin.y) / bin.shares : 0n;
      x += bx;
      y += by;
      positionBins.push({ id, shares: pos.shares.toString(), amountX: bx.toString(), amountY: by.toString() });
    }
    const [feeX, feeY] = dec(dlmmPairAbi, "pendingFees") as [bigint, bigint];
    if (positionBins.length === 0 && feeX === 0n && feeY === 0n) continue;
    dlmm.push({
      pool: d.pool,
      bins: positionBins,
      amountX: x.toString(),
      amountY: y.toString(),
      pendingFeesX: feeX.toString(),
      pendingFeesY: feeY.toString(),
      allBins: d.ids,
    });
  }
  c.header("Cache-Control", "no-store");
  return c.json({ account, damm, dlmm });
});

markets.get("/indexer", async (c) => {
  const stub = indexerStub(c.env);
  const [row, live] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM indexer_state WHERE id = 1").first(),
    stub.info().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
  ]);
  c.header("Cache-Control", "public, max-age=3");
  return c.json({ indexer: row ?? null, live });
});

function shapeSwap(s: any, finalized: number | null) {
  return {
    txHash: s.tx_hash,
    logIndex: s.log_index,
    blockNumber: s.block_number,
    timestamp: s.timestamp,
    pool: s.pool,
    sender: s.sender,
    recipient: s.recipient,
    tokenIn: s.token_in,
    tokenOut: s.token_out,
    amountIn: s.amount_in,
    amountOut: s.amount_out,
    fee: s.fee,
    protocolFee: s.protocol_fee,
    feeBps: s.fee_bps,
    quoteValue: s.quote_value,
    activeIdAfter: s.active_id_after,
    finality: finalized !== null && s.block_number <= finalized ? "final" : "sequencer",
  };
}

function addr(v: string): string | null {
  return isAddress(v, { strict: false }) ? getAddress(v) : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo;
}
