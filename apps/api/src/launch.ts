/**
 * Launch API: templates, launches with curve state, trades, LP locks and token metadata.
 * Listing comes from the indexer; a single launch and escrow positions are read live from the
 * chain so a page never shows a stale state for the token someone is about to trade.
 */
import { Hono } from "hono";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress } from "viem";
import { loadManifest, type Env } from "./lib";
import { multicall, type Call } from "./indexer/rpc";
import { dammPoolAbi } from "./indexer/process";
import { bondingCurveAbi, curveMetrics, CURVE_STATES, lpEscrowAbi } from "./indexer/launch";

export const launch = new Hono<{ Bindings: Env }>();

const TOKEN_DECIMALS = 18; // CurveilLaunchToken

type TemplateRow = {
  id: number;
  label: string;
  quote_asset: string;
  quote_symbol: string;
  quote_decimals: number;
  total_supply: string;
  curve_supply: string;
  migration_supply: string;
  graduation_threshold: string;
  virtual_quote: string;
  virtual_base: string;
  fee_bps: number;
  creator_fee_share_bps: number;
  damm_tier: number;
  damm_base_fee_bps: number;
  damm_max_fee_bps: number;
  price_tolerance_bps: number;
  creator_lp_bps: number;
  creator_lock_seconds: number;
  protocol_lock_seconds: number;
  protocol_fee_recipient: string;
  protocol_lp_recipient: string;
  enabled: number;
};

export function shapeTemplate(t: TemplateRow) {
  const vq = BigInt(t.virtual_quote);
  const vb = BigInt(t.virtual_base);
  const threshold = BigInt(t.graduation_threshold);
  const migration = BigInt(t.migration_supply);
  const scale = 10 ** (TOKEN_DECIMALS - t.quote_decimals);
  const startPrice = (Number(vq) / Number(vb)) * scale;
  const migrationPrice = (Number(threshold) / Number(migration)) * scale;
  const supply = Number(BigInt(t.total_supply)) / 10 ** TOKEN_DECIMALS;
  return {
    id: t.id,
    label: t.label,
    enabled: t.enabled === 1,
    quote: { address: t.quote_asset, symbol: t.quote_symbol, decimals: t.quote_decimals },
    totalSupply: t.total_supply,
    curveSupply: t.curve_supply,
    migrationSupply: t.migration_supply,
    graduationThreshold: t.graduation_threshold,
    graduationThresholdQuote: Number(threshold) / 10 ** t.quote_decimals,
    virtualQuote: t.virtual_quote,
    virtualBase: t.virtual_base,
    feeBps: t.fee_bps,
    creatorFeeShareBps: t.creator_fee_share_bps,
    damm: { tier: t.damm_tier, baseFeeBps: t.damm_base_fee_bps, maxFeeBps: t.damm_max_fee_bps },
    priceToleranceBps: t.price_tolerance_bps,
    creatorLpBps: t.creator_lp_bps,
    creatorLockSeconds: t.creator_lock_seconds,
    protocolLockSeconds: t.protocol_lock_seconds,
    protocolFeeRecipient: t.protocol_fee_recipient,
    protocolLpRecipient: t.protocol_lp_recipient,
    startPrice,
    migrationPrice,
    startMarketCap: startPrice * supply,
    migrationMarketCap: migrationPrice * supply,
  };
}

const LAUNCH_SELECT = `
  SELECT l.*, t.label AS template_label, t.quote_asset, t.quote_symbol, t.quote_decimals, t.virtual_quote,
    t.virtual_base AS initial_virtual_base, t.graduation_threshold, t.total_supply, t.fee_bps,
    lt.reserve_after AS reserve, lt.virtual_base_after AS virtual_base,
    (SELECT json_extract(data, '$.state') FROM launch_events e WHERE e.token = l.token AND e.kind = 'state'
      ORDER BY e.block_number DESC, e.log_index DESC LIMIT 1) AS state,
    (SELECT json_extract(data, '$.pool') FROM launch_events e WHERE e.token = l.token AND e.kind = 'graduated' LIMIT 1) AS pool,
    (SELECT SUM(quote_value) FROM curve_trades c WHERE c.token = l.token AND c.timestamp > ?1) AS volume_24h,
    (SELECT COUNT(*) FROM curve_trades c WHERE c.token = l.token AND c.timestamp > ?1) AS trades_24h,
    (SELECT COUNT(*) FROM curve_trades c WHERE c.token = l.token) AS trades,
    (SELECT MAX(timestamp) FROM curve_trades c WHERE c.token = l.token) AS last_trade_at
  FROM launches l
  LEFT JOIN launch_templates t ON t.id = l.template_id
  LEFT JOIN curve_trades lt ON lt.rowid = (
    SELECT rowid FROM curve_trades c WHERE c.token = l.token ORDER BY c.block_number DESC, c.log_index DESC LIMIT 1)`;

type LaunchRowDb = {
  token: string;
  curve: string;
  creator: string;
  creator_recipient: string;
  template_id: number;
  name: string;
  symbol: string;
  metadata_uri: string;
  created_block: number;
  created_tx: string;
  timestamp: number;
  operator: string | null;
  operator_share_bps: number | null;
  template_label: string | null;
  quote_asset: string | null;
  quote_symbol: string | null;
  quote_decimals: number | null;
  virtual_quote: string | null;
  initial_virtual_base: string | null;
  graduation_threshold: string | null;
  total_supply: string | null;
  fee_bps: number | null;
  reserve: string | null;
  virtual_base: string | null;
  state: string | null;
  pool: string | null;
  volume_24h: number | null;
  trades_24h: number;
  trades: number;
  last_trade_at: number | null;
};

function shapeLaunch(r: LaunchRowDb, poolPrice: Map<string, number | null>, origin: string) {
  const quoteDecimals = r.quote_decimals ?? 6;
  const metrics =
    r.virtual_quote && r.initial_virtual_base && r.graduation_threshold && r.total_supply
      ? curveMetrics({
          virtualQuote: BigInt(r.virtual_quote),
          virtualBase: BigInt(r.virtual_base ?? r.initial_virtual_base),
          initialVirtualBase: BigInt(r.initial_virtual_base),
          reserve: BigInt(r.reserve ?? "0"),
          threshold: BigInt(r.graduation_threshold),
          totalSupply: BigInt(r.total_supply),
          tokenDecimals: TOKEN_DECIMALS,
          quoteDecimals,
        })
      : null;
  const state = (r.state ?? (r.trades > 0 ? "trading" : "created")) as (typeof CURVE_STATES)[number];
  // After graduation the market is the DAMM pool; its price replaces the curve's last price.
  const price = r.pool && poolPrice.get(r.pool) != null ? poolPrice.get(r.pool)! : (metrics?.price ?? null);
  const supply = r.total_supply ? Number(BigInt(r.total_supply)) / 10 ** TOKEN_DECIMALS : null;
  return {
    token: r.token,
    curve: r.curve,
    name: r.name,
    symbol: r.symbol,
    metadataUri: r.metadata_uri,
    image: imageFor(r.metadata_uri, origin),
    creator: r.creator,
    operator: r.operator && r.operator !== "0x0000000000000000000000000000000000000000" ? r.operator : null,
    operatorShareBps: r.operator && r.operator !== "0x0000000000000000000000000000000000000000" ? r.operator_share_bps : null,
    templateId: r.template_id,
    templateLabel: r.template_label,
    quote: r.quote_asset ? { address: r.quote_asset, symbol: r.quote_symbol, decimals: quoteDecimals } : null,
    state,
    progressBps: state === "graduated" || state === "graduation_ready" ? 10_000 : (metrics?.progressBps ?? 0),
    reserveQuote: metrics?.reserve ?? 0,
    price,
    marketCap: price !== null && supply !== null ? price * supply : null,
    pool: r.pool,
    volume24hQuote: r.volume_24h ?? 0,
    trades24h: r.trades_24h,
    trades: r.trades,
    lastTradeAt: r.last_trade_at,
    createdAt: r.timestamp,
    createdBlock: r.created_block,
    createdTx: r.created_tx,
  };
}

async function poolPrices(env: Env, rows: LaunchRowDb[]): Promise<Map<string, number | null>> {
  const pools = [...new Set(rows.map((r) => r.pool).filter((p): p is string => !!p))];
  if (pools.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT p.address, p.token0, s.price FROM pools p JOIN pool_state s ON s.pool = p.address WHERE p.address IN (${pools.map(() => "?").join(",")})`,
  )
    .bind(...pools)
    .all<{ address: string; token0: string; price: number | null }>();
  const byPool = new Map(results.map((r) => [r.address, r]));
  const out = new Map<string, number | null>();
  for (const r of rows) {
    const p = r.pool ? byPool.get(r.pool) : undefined;
    if (!p || p.price === null || p.price === 0) continue;
    // pool price is token1 per token0; we want quote per launch token
    out.set(p.address, p.token0 === r.token ? p.price : 1 / p.price);
  }
  return out;
}

const dayAgo = () => Math.floor(Date.now() / 1000) - 86_400;

launch.get("/launches", async (c) => {
  const state = c.req.query("state");
  const creator = c.req.query("creator");
  const operator = c.req.query("operator");
  const sort = c.req.query("sort") ?? "new";
  const limit = clamp(Number(c.req.query("limit") ?? 100), 1, 200);
  const where: string[] = [];
  const binds: unknown[] = [dayAgo()];
  if (creator) {
    const a = addr(creator);
    if (!a) return c.json({ error: "bad_address", message: "That creator is not a valid address." }, 400);
    binds.push(a);
    where.push(`l.creator = ?${binds.length}`);
  }
  if (operator) {
    const a = addr(operator);
    if (!a) return c.json({ error: "bad_address", message: "That operator is not a valid address." }, 400);
    binds.push(a);
    where.push(`l.operator = ?${binds.length}`);
  }
  const order =
    sort === "volume"
      ? "volume_24h DESC NULLS LAST, l.created_block DESC"
      : sort === "progress"
        ? "CAST(COALESCE(lt.reserve_after, '0') AS REAL) / CAST(t.graduation_threshold AS REAL) DESC, l.created_block DESC"
        : sort === "active"
          ? "last_trade_at DESC NULLS LAST, l.created_block DESC"
          : "l.created_block DESC";
  const sql = `${LAUNCH_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT 500`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<LaunchRowDb>();
  const prices = await poolPrices(c.env, results);
  const origin = new URL(c.req.url).origin;
  let launches = results.map((r) => shapeLaunch(r, prices, origin));
  if (state) launches = launches.filter((l) => l.state === state);
  c.header("Cache-Control", "public, max-age=4");
  return c.json({ network: c.env.NETWORK, launches: launches.slice(0, limit) });
});

launch.get("/launches/templates", async (c) => {
  const [{ results }, { manifest }] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM launch_templates ORDER BY id").all<TemplateRow>(),
    loadManifest(c.env),
  ]);
  c.header("Cache-Control", "public, max-age=30");
  return c.json({
    factory: manifest.contracts.LaunchFactory?.address ?? null,
    templates: results.map(shapeTemplate),
  });
});

// ------------------------------------------------------------------ metadata
//
// Token pages can carry a description, links and an image. On testnet they are stored in KV,
// content-addressed: the URI written on-chain names the SHA-256 of the document, so nothing a
// later upload does can change what an existing launch points at. Only images we validate
// (PNG, JPEG, WebP, GIF; no SVG) are served, from our own origin, with a locked-down CSP.

const META_PATH = /\/v1\/launches\/metadata\/([0-9a-f]{64})$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// The image arrives base64-encoded (4/3 larger) inside a small JSON body.
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

export type TokenMetadata = {
  description: string;
  website: string | null;
  x: string | null;
  telegram: string | null;
  image: { sha256: string; type: string; bytes: number } | null;
};

/** Hash of a metadata URI this API hosts; null for anything else (we never fetch other URIs). */
export function ownMetadataHash(uri: string, origin: string): string | null {
  const m = META_PATH.exec(uri);
  return m && uri.startsWith(`${origin}/v1/launches/metadata/`) ? m[1]! : null;
}

function imageFor(uri: string, origin: string): string | null {
  return ownMetadataHash(uri, origin) ? `${uri}/image` : null;
}

export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return "image/gif";
  if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

function cleanUrl(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 200) throw new BadInput(`${field} must be a link of at most 200 characters.`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new BadInput(`${field} is not a valid link.`);
  }
  if (u.protocol !== "https:") throw new BadInput(`${field} must start with https://`);
  return u.toString();
}

class BadInput extends Error {}

/** Validates an upload. Pure, so it is unit-tested. */
export function parseMetadataInput(body: unknown): { doc: Omit<TokenMetadata, "image">; image: Uint8Array | null; imageType: string | null } {
  if (!body || typeof body !== "object") throw new BadInput("Send a JSON object.");
  const b = body as Record<string, unknown>;
  const description = b.description ?? "";
  if (typeof description !== "string" || description.length > 500) throw new BadInput("The description can be at most 500 characters.");
  let image: Uint8Array | null = null;
  let imageType: string | null = null;
  if (b.image !== undefined && b.image !== null && b.image !== "") {
    const m = typeof b.image === "string" ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(b.image) : null;
    if (!m) throw new BadInput("The image must be a PNG, JPEG, WebP or GIF data URL.");
    if (m[2]!.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new BadInput("The image can be at most 4 MB.");
    try {
      image = Uint8Array.from(atob(m[2]!), (ch) => ch.charCodeAt(0));
    } catch {
      throw new BadInput("The image data is not valid base64.");
    }
    if (image.length > MAX_IMAGE_BYTES) throw new BadInput("The image can be at most 4 MB.");
    imageType = sniffImage(image);
    if (!imageType) throw new BadInput("The image file is not a PNG, JPEG, WebP or GIF.");
  }
  return {
    doc: {
      description: description.trim(),
      website: cleanUrl(b.website, "Website"),
      x: cleanUrl(b.x, "X link"),
      telegram: cleanUrl(b.telegram, "Telegram link"),
    },
    image,
    imageType,
  };
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

launch.post("/launches/metadata", async (c) => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) return c.json({ error: "too_large", message: "The upload is too large. Keep the image under 4 MB." }, 413);
  if (c.env.UPLOADS) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await c.env.UPLOADS.limit({ key: ip });
    if (!success) return c.json({ error: "rate_limited", message: "Too many uploads. Wait a minute and try again." }, 429);
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: "too_large", message: "The upload is too large. Keep the image under 4 MB." }, 413);
  let parsed;
  try {
    parsed = parseMetadataInput(JSON.parse(text));
  } catch (e) {
    const message = e instanceof BadInput ? e.message : "Send a JSON object.";
    return c.json({ error: "bad_input", message }, 400);
  }
  let image: TokenMetadata["image"] = null;
  if (parsed.image && parsed.imageType) {
    const sha = await sha256Hex(parsed.image);
    image = { sha256: sha, type: parsed.imageType, bytes: parsed.image.length };
    if ((await c.env.CONFIG.get(`img:${sha}`, "stream")) === null) {
      await c.env.CONFIG.put(`img:${sha}`, parsed.image, { metadata: { type: parsed.imageType } });
    }
  }
  const doc: TokenMetadata = { ...parsed.doc, image };
  const json = JSON.stringify(doc);
  const hash = await sha256Hex(json);
  if ((await c.env.CONFIG.get(`meta:${hash}`)) === null) await c.env.CONFIG.put(`meta:${hash}`, json);
  const origin = new URL(c.req.url).origin;
  return c.json({ uri: `${origin}/v1/launches/metadata/${hash}`, hash, metadata: doc }, 201);
});

launch.get("/launches/metadata/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: "not_found", message: "No metadata with that hash." }, 404);
  const json = await c.env.CONFIG.get(`meta:${hash}`);
  if (!json) return c.json({ error: "not_found", message: "No metadata with that hash." }, 404);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(json, 200, { "content-type": "application/json" });
});

launch.get("/launches/metadata/:hash/image", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[0-9a-f]{64}$/.test(hash)) return c.text("not found", 404);
  const json = await c.env.CONFIG.get(`meta:${hash}`);
  const doc = json ? (JSON.parse(json) as TokenMetadata) : null;
  if (!doc?.image) return c.text("not found", 404);
  const { value, metadata } = await c.env.CONFIG.getWithMetadata<{ type: string }>(`img:${doc.image.sha256}`, "arrayBuffer");
  if (!value) return c.text("not found", 404);
  return c.body(value, 200, {
    "content-type": metadata?.type ?? doc.image.type,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
  });
});

async function readMetadata(env: Env, uri: string, origin: string): Promise<TokenMetadata | null> {
  const hash = ownMetadataHash(uri, origin);
  if (!hash) return null;
  const json = await env.CONFIG.get(`meta:${hash}`);
  return json ? (JSON.parse(json) as TokenMetadata) : null;
}

// ------------------------------------------------------------------ one launch

launch.get("/launches/:token", async (c) => {
  const token = addr(c.req.param("token"));
  if (!token) return c.json({ error: "bad_address", message: "That is not a valid token address." }, 400);
  const row = await c.env.DB.prepare(`${LAUNCH_SELECT} WHERE l.token = ?2`).bind(dayAgo(), token).first<LaunchRowDb>();
  if (!row) return c.json({ error: "not_found", message: "No Curveil launch for that token on this network." }, 404);
  const [template, graduation, metadata] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM launch_templates WHERE id = ?").bind(row.template_id).first<TemplateRow>(),
    c.env.DB.prepare("SELECT data, tx_hash, timestamp FROM launch_events WHERE token = ? AND kind = 'graduated' LIMIT 1")
      .bind(token)
      .first<{ data: string; tx_hash: string; timestamp: number }>(),
    readMetadata(c.env, row.metadata_uri, new URL(c.req.url).origin),
  ]);

  // Live curve state: the page trades against it, so it must not lag the indexer.
  const fns = ["state", "reserve", "virtualBase", "creatorFees", "operatorFees", "protocolFees", "creatorRecipient", "pool"] as const;
  const res = await multicall(
    c.env.RPC_URL,
    fns.map((fn) => ({ target: row.curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: fn }) })),
  );
  const live = Object.fromEntries(
    fns.map((fn, i) => [fn, decodeFunctionResult({ abi: bondingCurveAbi, functionName: fn, data: res[i]! }) as unknown]),
  ) as Record<(typeof fns)[number], any>;
  const fixed: LaunchRowDb = {
    ...row,
    reserve: String(live.reserve),
    virtual_base: String(live.virtualBase),
    state: CURVE_STATES[Number(live.state)] ?? row.state,
    pool: live.pool !== "0x0000000000000000000000000000000000000000" ? getAddress(live.pool) : row.pool,
  };
  const prices = await poolPrices(c.env, [fixed]);
  const g = graduation ? (JSON.parse(graduation.data) as Record<string, string | number>) : null;
  const locks = g ? await readLocks(c.env, [Number(g.creatorLockId), Number(g.protocolLockId)]) : [];
  c.header("Cache-Control", "no-store");
  return c.json({
    launch: {
      ...shapeLaunch(fixed, prices, new URL(c.req.url).origin),
      creatorRecipient: getAddress(live.creatorRecipient),
      fees: { creator: String(live.creatorFees), operator: String(live.operatorFees), protocol: String(live.protocolFees) },
    },
    template: template ? shapeTemplate(template) : null,
    graduation: g && graduation ? { ...g, txHash: graduation.tx_hash, timestamp: graduation.timestamp } : null,
    locks,
    metadata,
  });
});

launch.get("/launches/:token/trades", async (c) => {
  const token = addr(c.req.param("token"));
  if (!token) return c.json({ error: "bad_address", message: "That is not a valid token address." }, 400);
  const limit = clamp(Number(c.req.query("limit") ?? 100), 1, 500);
  const [rows, tpl, fin] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM curve_trades WHERE token = ? ORDER BY block_number DESC, log_index DESC LIMIT ?").bind(token, limit).all<any>(),
    c.env.DB.prepare("SELECT t.virtual_quote, t.quote_decimals FROM launches l JOIN launch_templates t ON t.id = l.template_id WHERE l.token = ?")
      .bind(token)
      .first<{ virtual_quote: string; quote_decimals: number }>(),
    c.env.DB.prepare("SELECT finalized_block FROM indexer_state WHERE id = 1").first<{ finalized_block: number | null }>(),
  ]);
  const scale = tpl ? 10 ** (TOKEN_DECIMALS - tpl.quote_decimals) : 1;
  const vq = tpl ? BigInt(tpl.virtual_quote) : 0n;
  c.header("Cache-Control", "public, max-age=3");
  return c.json({
    trades: rows.results.map((t) => ({
      txHash: t.tx_hash,
      logIndex: t.log_index,
      blockNumber: t.block_number,
      timestamp: t.timestamp,
      trader: t.trader,
      recipient: t.recipient,
      isBuy: t.is_buy === 1,
      quoteAmount: t.quote_amount,
      tokenAmount: t.token_amount,
      fee: t.fee,
      quoteValue: t.quote_value,
      reserveAfter: t.reserve_after,
      priceAfter: tpl ? (Number(vq + BigInt(t.reserve_after)) / Number(BigInt(t.virtual_base_after))) * scale : null,
      finality: fin?.finalized_block != null && t.block_number <= fin.finalized_block ? "final" : "sequencer",
    })),
  });
});

// ------------------------------------------------------------------ LP escrow

async function readLocks(env: Env, ids: number[]) {
  if (ids.length === 0) return [];
  const { manifest } = await loadManifest(env);
  const escrow = manifest.contracts.LpEscrow?.address;
  if (!escrow) return [];
  const calls: Call[] = [];
  for (const id of ids) {
    calls.push({ target: escrow, data: encodeFunctionData({ abi: lpEscrowAbi, functionName: "getLock", args: [BigInt(id)] }) });
    calls.push({ target: escrow, data: encodeFunctionData({ abi: lpEscrowAbi, functionName: "pendingFees", args: [BigInt(id)] }) });
  }
  const res = await multicall(env.RPC_URL, calls);
  const locks = ids.map((id, i) => {
    const l = decodeFunctionResult({ abi: lpEscrowAbi, functionName: "getLock", data: res[2 * i]! }) as {
      lpToken: string;
      beneficiary: string;
      unlockAt: bigint;
      claimed: boolean;
      amount: bigint;
    };
    const [f0, f1] = decodeFunctionResult({ abi: lpEscrowAbi, functionName: "pendingFees", data: res[2 * i + 1]! }) as [bigint, bigint];
    return {
      id,
      lpToken: getAddress(l.lpToken),
      beneficiary: getAddress(l.beneficiary),
      unlockAt: Number(l.unlockAt),
      claimed: l.claimed,
      amount: l.amount.toString(),
      pendingFees0: f0.toString(),
      pendingFees1: f1.toString(),
    };
  });
  // Pair and LP value, for display.
  const lps = [...new Set(locks.map((l) => l.lpToken))];
  const { results } = await env.DB.prepare(
    `SELECT p.address, p.token0, p.token1, t0.symbol AS s0, t1.symbol AS s1, t0.decimals AS d0, t1.decimals AS d1
     FROM pools p JOIN tokens t0 ON t0.address = p.token0 JOIN tokens t1 ON t1.address = p.token1
     WHERE p.address IN (${lps.map(() => "?").join(",")})`,
  )
    .bind(...lps)
    .all<{ address: string; token0: string; token1: string; s0: string; s1: string; d0: number; d1: number }>();
  const pools = new Map(results.map((r) => [r.address, r]));
  const sres = await multicall(
    env.RPC_URL,
    lps.flatMap((p) => [
      { target: p, data: encodeFunctionData({ abi: dammPoolAbi, functionName: "getReserves" }) },
      { target: p, data: encodeFunctionData({ abi: dammPoolAbi, functionName: "totalSupply" }) },
    ]),
  );
  const state = new Map(
    lps.map((p, i) => {
      const [r0, r1] = decodeFunctionResult({ abi: dammPoolAbi, functionName: "getReserves", data: sres[2 * i]! }) as [bigint, bigint];
      const supply = decodeFunctionResult({ abi: dammPoolAbi, functionName: "totalSupply", data: sres[2 * i + 1]! }) as bigint;
      return [p, { r0, r1, supply }];
    }),
  );
  return locks.map((l) => {
    const p = pools.get(l.lpToken);
    const s = state.get(l.lpToken)!;
    const amt = l.claimed ? 0n : BigInt(l.amount);
    return {
      ...l,
      pool: p
        ? {
            token0: { address: p.token0, symbol: p.s0, decimals: p.d0 },
            token1: { address: p.token1, symbol: p.s1, decimals: p.d1 },
          }
        : null,
      underlying0: s.supply > 0n ? ((amt * s.r0) / s.supply).toString() : "0",
      underlying1: s.supply > 0n ? ((amt * s.r1) / s.supply).toString() : "0",
    };
  });
}

launch.get("/escrow/:owner", async (c) => {
  const owner = addr(c.req.param("owner"));
  if (!owner) return c.json({ error: "bad_address", message: "That is not a valid address." }, 400);
  // Any lock this address ever held; the live read below keeps the ones it holds now.
  const { results } = await c.env.DB.prepare("SELECT DISTINCT lock_id FROM escrow_events WHERE beneficiary = ? ORDER BY lock_id")
    .bind(owner)
    .all<{ lock_id: number }>();
  const locks = (await readLocks(c.env, results.map((r) => r.lock_id))).filter((l) => l.beneficiary === owner);
  // Which launch each lock came from, for labels.
  const lps = [...new Set(locks.map((l) => l.lpToken))];
  const launches = lps.length
    ? (
        await c.env.DB.prepare(
          `SELECT l.token, l.symbol, l.name, json_extract(e.data, '$.pool') AS pool FROM launch_events e JOIN launches l ON l.token = e.token
           WHERE e.kind = 'graduated' AND json_extract(e.data, '$.pool') IN (${lps.map(() => "?").join(",")})`,
        )
          .bind(...lps)
          .all<{ token: string; symbol: string; name: string; pool: string }>()
      ).results
    : [];
  const byPool = new Map(launches.map((l) => [l.pool, l]));
  c.header("Cache-Control", "no-store");
  return c.json({
    owner,
    locks: locks.map((l) => ({ ...l, launch: byPool.get(l.lpToken) ? { token: byPool.get(l.lpToken)!.token, symbol: byPool.get(l.lpToken)!.symbol } : null })),
  });
});

function addr(v: string): string | null {
  return isAddress(v, { strict: false }) ? getAddress(v) : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo;
}
