/**
 * Launchpad operators (FR-27, FR-28): listing, one operator, its revenue, and the off-chain
 * profile (custom domain) its admin manages after signing in. On-chain terms come from the
 * indexer; revenue balances are read live so an operator sees exactly what it can collect.
 */
import { Hono } from "hono";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Hex } from "viem";
import { loadManifest, type Env } from "./lib";
import { multicall, type Call } from "./indexer/rpc";
import { bondingCurveAbi } from "./indexer/launch";
import { feeSplitterAbi, launchpadRegistryAbi, parseBrand, readOperators, templatesOf, ZERO_ADDRESS } from "./indexer/factory";
import { err, requireAuth, type Vars } from "./auth";

export const operators = new Hono<{ Bindings: Env; Variables: Vars }>();

type OperatorRow = {
  address: string;
  slug: string;
  admin: string;
  pending_admin: string | null;
  share_bps: number;
  active: number;
  suspended: number;
  template_mask: string;
  brand_uri: string;
  brand: string | null;
  recipients: string;
  created_block: number;
  created_tx: string;
  created_at: number;
  domain: string | null;
  domain_verified_at: string | null;
  description: string | null;
  contact: string | null;
  launches: number;
  volume: number | null;
};

const SELECT = `
  SELECT o.*, p.domain, p.domain_verified_at, p.description, p.contact,
    (SELECT COUNT(*) FROM launches l WHERE l.operator = o.address) AS launches,
    (SELECT SUM(c.quote_value) FROM curve_trades c JOIN launches l ON l.token = c.token WHERE l.operator = o.address) AS volume
  FROM operators o LEFT JOIN operator_profiles p ON p.operator = o.address`;

async function maxShare(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT data FROM operator_events WHERE kind = 'max_share_set' ORDER BY block_number DESC, log_index DESC LIMIT 1").first<{
    data: string;
  }>();
  return row ? Number(JSON.parse(row.data).maxShareBps) : 0;
}

function shape(r: OperatorRow, cap: number) {
  const brand = r.brand ? JSON.parse(r.brand) : parseBrand(r.brand_uri);
  return {
    address: r.address,
    slug: r.slug,
    admin: r.admin,
    pendingAdmin: r.pending_admin,
    shareBps: r.share_bps,
    effectiveShareBps: Math.min(r.share_bps, cap),
    active: r.active === 1,
    suspended: r.suspended === 1,
    acceptingLaunches: r.active === 1 && r.suspended === 0,
    templates: templatesOf(r.template_mask),
    brand,
    brandURI: r.brand_uri.startsWith("data:") ? null : r.brand_uri,
    recipients: JSON.parse(r.recipients) as { address: string; weightBps: number }[],
    domain: r.domain_verified_at ? r.domain : null,
    description: r.description,
    contact: r.contact,
    launches: r.launches,
    volumeQuote: r.volume ?? 0,
    createdAt: r.created_at,
    createdBlock: r.created_block,
    createdTx: r.created_tx,
  };
}

/** By address or slug. */
async function find(env: Env, id: string): Promise<OperatorRow | null> {
  if (isAddress(id)) return env.DB.prepare(`${SELECT} WHERE o.address = ?`).bind(getAddress(id)).first<OperatorRow>();
  return env.DB.prepare(`${SELECT} WHERE o.slug = ?`).bind(id.toLowerCase()).first<OperatorRow>();
}

operators.get("/operators", async (c) => {
  const admin = c.req.query("admin");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 200);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (admin) {
    if (!isAddress(admin)) return err(c, 400, "bad_address", "That admin is not a valid address.");
    where.push("o.admin = ?");
    binds.push(getAddress(admin));
  }
  const [{ results }, cap, { manifest }] = await Promise.all([
    c.env.DB.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.created_block DESC LIMIT ?`)
      .bind(...binds, limit)
      .all<OperatorRow>(),
    maxShare(c.env),
    loadManifest(c.env),
  ]);
  c.header("Cache-Control", "public, max-age=5");
  return c.json({
    network: c.env.NETWORK,
    registry: manifest.contracts.LaunchpadRegistry?.address ?? null,
    maxShareBps: cap,
    operators: results.map((r) => shape(r, cap)),
  });
});

/** The operator serving a verified custom domain (for branded frontends on their own domain). */
operators.get("/operators/by-domain/:domain", async (c) => {
  const domain = normaliseDomain(c.req.param("domain"));
  if (!domain) return err(c, 400, "bad_domain", "That is not a valid domain.");
  const row = await c.env.DB.prepare(`${SELECT} WHERE p.domain = ? AND p.domain_verified_at IS NOT NULL`).bind(domain).first<OperatorRow>();
  if (!row) return err(c, 404, "not_found", "No launchpad has verified that domain.");
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ operator: shape(row, await maxShare(c.env)) });
});

operators.get("/operators/:id", async (c) => {
  const [row, cap] = await Promise.all([find(c.env, c.req.param("id")), maxShare(c.env)]);
  if (!row) return err(c, 404, "not_found", "No launchpad with that address or name on this network.");
  const profile = await c.env.DB.prepare("SELECT domain, domain_verified_at FROM operator_profiles WHERE operator = ?")
    .bind(row.address)
    .first<{ domain: string | null; domain_verified_at: string | null }>();
  c.header("Cache-Control", "public, max-age=5");
  return c.json({
    operator: shape(row, cap),
    maxShareBps: cap,
    domainSetup: profile?.domain
      ? { domain: profile.domain, verified: Boolean(profile.domain_verified_at), record: txtRecord(profile.domain, row.address) }
      : null,
  });
});

operators.get("/operators/:id/revenue", async (c) => {
  const row = await find(c.env, c.req.param("id"));
  if (!row) return err(c, 404, "not_found", "No launchpad with that address or name on this network.");
  const op = row.address;
  const db = c.env.DB;
  const [{ results: curves }, { results: history }, { results: daily }, { results: pastRecipients }, { manifest }] = await Promise.all([
    db
      .prepare(
        `SELECT l.token, l.curve, l.operator_share_bps, t.quote_asset, t.quote_symbol, t.quote_decimals, t.creator_fee_share_bps
         FROM launches l LEFT JOIN launch_templates t ON t.id = l.template_id WHERE l.operator = ?`,
      )
      .bind(op)
      .all<{ token: string; curve: string; operator_share_bps: number; quote_asset: string; quote_symbol: string; quote_decimals: number; creator_fee_share_bps: number }>(),
    db
      .prepare(
        `SELECT * FROM (
           SELECT 'distributed' AS kind, token, NULL AS recipient, NULL AS launch, amount, tx_hash, block_number, log_index, timestamp FROM fee_distributions WHERE operator = ?1 AND kind = 'distributed'
           UNION ALL SELECT 'released', token, recipient, NULL, amount, tx_hash, block_number, log_index, timestamp FROM fee_distributions WHERE operator = ?1 AND kind = 'released'
           UNION ALL SELECT 'collected', t.quote_asset, NULL, e.token, json_extract(e.data, '$.amount'), e.tx_hash, e.block_number, e.log_index, e.timestamp
             FROM launch_events e JOIN launches l ON l.token = e.token LEFT JOIN launch_templates t ON t.id = l.template_id
             WHERE l.operator = ?1 AND e.kind = 'fees_claimed' AND json_extract(e.data, '$.bucket') = 'operator'
         ) ORDER BY block_number DESC, log_index DESC LIMIT 50`,
      )
      .bind(op)
      .all<{ kind: string; token: string | null; recipient: string | null; launch: string | null; amount: string; tx_hash: string; block_number: number; timestamp: number }>(),
    // Estimated operator fees per day from curve trades (exact totals come from the contracts).
    db
      .prepare(
        `SELECT CAST(c.timestamp / 86400 AS INTEGER) * 86400 AS day, t.quote_decimals AS decimals, COUNT(*) AS trades, SUM(c.quote_value) AS volume,
           SUM(CAST(c.fee AS REAL) * (10000 - t.creator_fee_share_bps) / 10000.0 * l.operator_share_bps / 10000.0) AS fees
         FROM curve_trades c JOIN launches l ON l.token = c.token JOIN launch_templates t ON t.id = l.template_id
         WHERE l.operator = ? AND c.timestamp > ? GROUP BY day, t.quote_decimals ORDER BY day`,
      )
      .bind(op, Math.floor(Date.now() / 1000) - 30 * 86_400)
      .all<{ day: number; decimals: number; trades: number; volume: number; fees: number }>(),
    db
      .prepare("SELECT data FROM operator_events WHERE operator = ? AND kind = 'recipients_set'")
      .bind(op)
      .all<{ data: string }>(),
    loadManifest(c.env),
  ]);

  // Every address that is or was a recipient: one replaced earlier may still have fees to pull.
  const recipients = JSON.parse(row.recipients) as { address: string; weightBps: number }[];
  const everyone = new Set<string>(recipients.map((r) => r.address));
  for (const p of pastRecipients) for (const r of JSON.parse(p.data).recipients as { address: string }[]) everyone.add(r.address);
  const usdg = manifest.assets.find((a) => a.label === "USDG");
  const tokenInfo = new Map<string, { symbol: string; decimals: number }>();
  if (usdg) tokenInfo.set(getAddress(usdg.address), { symbol: usdg.symbol, decimals: usdg.decimals });
  for (const x of curves) if (x.quote_asset) tokenInfo.set(getAddress(x.quote_asset), { symbol: x.quote_symbol, decimals: x.quote_decimals });
  const tokens = [...tokenInfo.keys()];
  const people = [...everyone];

  // Live: fees waiting in each curve, and the splitter's books per token and recipient.
  const calls: Call[] = curves.map((x) => ({ target: x.curve, data: encodeFunctionData({ abi: bondingCurveAbi, functionName: "operatorFees" }) }));
  for (const t of tokens) {
    for (const fn of ["pending", "unpaid", "totalDistributed"] as const) {
      calls.push({ target: op, data: encodeFunctionData({ abi: feeSplitterAbi, functionName: fn, args: [t as Hex] }) });
    }
    for (const p of people) {
      calls.push({ target: op, data: encodeFunctionData({ abi: feeSplitterAbi, functionName: "owed", args: [t as Hex, p as Hex] }) });
      calls.push({ target: op, data: encodeFunctionData({ abi: feeSplitterAbi, functionName: "released", args: [t as Hex, p as Hex] }) });
    }
  }
  const res = await multicall(c.env.RPC_URL, calls);
  let k = 0;
  const big = (fn: string, data: Hex, abi = feeSplitterAbi) => decodeFunctionResult({ abi, functionName: fn, data }) as bigint;
  const inCurves = new Map<string, bigint>();
  const perCurve = curves.map((x) => {
    const v = big("operatorFees", res[k++]!, bondingCurveAbi);
    const q = getAddress(x.quote_asset);
    inCurves.set(q, (inCurves.get(q) ?? 0n) + v);
    return { token: x.token, curve: x.curve, quote: q, uncollected: v.toString() };
  });
  const byToken = tokens.map((t) => {
    const pending = big("pending", res[k++]!);
    const unpaid = big("unpaid", res[k++]!);
    const distributed = big("totalDistributed", res[k++]!);
    const rows = people.map((p) => {
      const owed = big("owed", res[k++]!);
      const released = big("released", res[k++]!);
      const current = recipients.find((r) => r.address === p);
      return { address: p, weightBps: current?.weightBps ?? 0, current: Boolean(current), owed: owed.toString(), released: released.toString() };
    });
    const info = tokenInfo.get(t)!;
    const uncollected = inCurves.get(t) ?? 0n;
    return {
      token: t,
      symbol: info.symbol,
      decimals: info.decimals,
      // Earned = still in curves + arrived but not allocated + everything allocated so far.
      earned: (uncollected + pending + distributed).toString(),
      uncollected: uncollected.toString(),
      pending: pending.toString(),
      unpaid: unpaid.toString(),
      distributed: distributed.toString(),
      recipients: rows.filter((r) => r.current || r.owed !== "0" || r.released !== "0"),
    };
  });
  c.header("Cache-Control", "no-store");
  return c.json({
    operator: op,
    slug: row.slug,
    launches: curves.length,
    tokens: byToken,
    curves: perCurve.filter((x) => x.uncollected !== "0"),
    daily: Object.values(
      daily.reduce<Record<number, { day: string; trades: number; volumeQuote: number; estimatedFees: number }>>((acc, d) => {
        const x = (acc[d.day] ??= { day: new Date(d.day * 1000).toISOString().slice(0, 10), trades: 0, volumeQuote: 0, estimatedFees: 0 });
        x.trades += d.trades;
        x.volumeQuote += d.volume;
        x.estimatedFees += d.fees / 10 ** d.decimals;
        return acc;
      }, {}),
    ),
    history: history.map((h) => ({ kind: h.kind, token: h.token, recipient: h.recipient, launch: h.launch, amount: h.amount, txHash: h.tx_hash, block: h.block_number, timestamp: h.timestamp })),
    howToCollect:
      "Call collect(curves, token) on the operator address to pull fees from its launches and allocate them, then release(token, recipient) for each recipient. Anyone may call both; funds only ever go to the recipients.",
  });
});

// ------------------------------------------------------------------ off-chain profile

function normaliseDomain(d: string): string | null {
  const s = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}
const txtRecord = (domain: string, operator: string) => ({ type: "TXT", name: `_curveil.${domain}`, value: `curveil-operator=${operator.toLowerCase()}` });

/** The admin, read from the chain when the indexer has not caught up with a new registration. */
async function adminOf(env: Env, operator: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT admin FROM operators WHERE address = ?").bind(operator).first<{ admin: string }>();
  if (row) return row.admin;
  const { manifest } = await loadManifest(env);
  const reg = manifest.contracts.LaunchpadRegistry?.address;
  if (!reg) return null;
  const [state] = await readOperators(env.RPC_URL, reg, [operator]).catch(() => []);
  return state && state.admin !== ZERO_ADDRESS ? state.admin : null;
}

operators.post("/operators", async (c) => {
  const a = requireAuth(c, true);
  if (a instanceof Response) return a;
  const body = (await c.req.json().catch(() => null)) as { operator?: string; domain?: string | null; description?: string | null; contact?: string | null } | null;
  if (!body?.operator || !isAddress(body.operator)) return err(c, 400, "bad_request", "Send the launchpad's operator address.");
  const op = getAddress(body.operator);
  const admin = await adminOf(c.env, op);
  if (!admin) return err(c, 404, "not_found", "That address is not a registered launchpad. Register it on chain first.");
  if (admin !== a.address) return err(c, 403, "not_admin", "Only the launchpad's admin can change its settings.");
  // Partial update: a field left out keeps its current value; null or "" clears it.
  const prev = await c.env.DB.prepare("SELECT domain, domain_verified_at, description, contact FROM operator_profiles WHERE operator = ?")
    .bind(op)
    .first<{ domain: string | null; domain_verified_at: string | null; description: string | null; contact: string | null }>();
  let domain: string | null = body.domain === undefined ? (prev?.domain ?? null) : null;
  if (body.domain) {
    domain = normaliseDomain(body.domain);
    if (!domain) return err(c, 400, "bad_domain", "That is not a valid domain, for example launch.example.com.");
    const taken = await c.env.DB.prepare("SELECT operator FROM operator_profiles WHERE domain = ? AND operator != ?").bind(domain, op).first();
    if (taken) return err(c, 409, "domain_taken", "Another launchpad already uses that domain.");
  }
  const verifiedAt = prev && prev.domain === domain ? prev.domain_verified_at : null;
  const description = body.description === undefined ? (prev?.description ?? null) : body.description?.trim().slice(0, 280) || null;
  const contact = body.contact === undefined ? (prev?.contact ?? null) : body.contact?.trim().slice(0, 120) || null;
  await c.env.DB.prepare(
    `INSERT INTO operator_profiles (operator, domain, domain_token, domain_verified_at, description, contact, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (operator) DO UPDATE SET domain = excluded.domain, domain_token = excluded.domain_token,
       domain_verified_at = excluded.domain_verified_at, description = excluded.description, contact = excluded.contact,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(op, domain, domain ? txtRecord(domain, op).value : null, verifiedAt, description, contact, a.address, new Date().toISOString())
    .run();
  return c.json({
    ok: true,
    operator: op,
    domain: domain ? { domain, verified: Boolean(verifiedAt), record: txtRecord(domain, op) } : null,
    next: domain && !verifiedAt ? "Add the TXT record at your DNS provider, then call POST /v1/operators/:id/domain/verify." : null,
  });
});

operators.post("/operators/:id/domain/verify", async (c) => {
  const a = requireAuth(c, true);
  if (a instanceof Response) return a;
  const id = c.req.param("id");
  if (!isAddress(id)) return err(c, 400, "bad_address", "Use the launchpad's operator address.");
  const op = getAddress(id);
  if ((await adminOf(c.env, op)) !== a.address) return err(c, 403, "not_admin", "Only the launchpad's admin can verify its domain.");
  const p = await c.env.DB.prepare("SELECT domain FROM operator_profiles WHERE operator = ?").bind(op).first<{ domain: string | null }>();
  if (!p?.domain) return err(c, 400, "no_domain", "Set a domain first.");
  const record = txtRecord(p.domain, op);
  // DNS over HTTPS (public resolver), so verification needs no DNS library in the Worker.
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(record.name)}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!r?.ok) return err(c, 503, "dns_unavailable", "Could not look up DNS right now. Try again in a minute.");
  const j = (await r.json()) as { Answer?: { data: string }[] };
  const found = (j.Answer ?? []).some((x) => x.data.replace(/^"|"$/g, "").replace(/" "/g, "") === record.value);
  if (!found) return c.json({ verified: false, record, message: "The TXT record was not found yet. DNS changes can take a few minutes to appear." });
  const at = new Date().toISOString();
  await c.env.DB.prepare("UPDATE operator_profiles SET domain_verified_at = ? WHERE operator = ?").bind(at, op).run();
  return c.json({ verified: true, domain: p.domain, verifiedAt: at });
});

/** Max share and registry address, for clients that want them without the full manifest. */
operators.get("/factory", async (c) => {
  const { manifest } = await loadManifest(c.env);
  const reg = manifest.contracts.LaunchpadRegistry ?? null;
  let live: { maxShareBps: number; operatorCount: number } | null = null;
  if (reg) {
    const res = await multicall(c.env.RPC_URL, [
      { target: reg.address, data: encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "maxShareBps" }) },
      { target: reg.address, data: encodeFunctionData({ abi: launchpadRegistryAbi, functionName: "operatorCount" }) },
    ]).catch(() => null);
    if (res) {
      live = {
        maxShareBps: Number(decodeFunctionResult({ abi: launchpadRegistryAbi, functionName: "maxShareBps", data: res[0]! })),
        operatorCount: Number(decodeFunctionResult({ abi: launchpadRegistryAbi, functionName: "operatorCount", data: res[1]! })),
      };
    }
  }
  c.header("Cache-Control", "public, max-age=15");
  return c.json({
    network: c.env.NETWORK,
    registry: reg?.address ?? null,
    feeSplitterImplementation: manifest.contracts.FeeSplitter?.address ?? null,
    launchFactory: manifest.contracts.LaunchFactory?.address ?? null,
    ...live,
    slugRules: "3 to 32 characters: a-z, 0-9 and '-', not starting or ending with '-'.",
    maxRecipients: 8,
    brandURIMaxBytes: 2048,
  });
});

