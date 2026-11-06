/**
 * Webhook subscriptions (FR-29): create, list, change, delete, rotate the signing secret, send a
 * test, read deliveries and replay them. Owned by the signed-in address; an API key of that
 * address can manage them too. Delivery itself happens in apps/webhooks.
 */
import { Hono } from "hono";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS } from "@curveil/sdk/webhooks";
import { encryptSecret, newSigningSecret } from "@curveil/webhooks/secrets";
import { indexerStub, loadManifest, type Env } from "./lib";
import { err, newId, requireAuth, type Vars } from "./auth";
import { deliveryId, eventId, payload, type ChainEvent } from "./indexer/events";
import { enqueue } from "./indexer/webhooks";

export const webhooks = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_SUBSCRIPTIONS = 10;
const TYPES = new Set<string>([...WEBHOOK_EVENTS, "*"]);

type SubRow = {
  id: string;
  owner: string;
  url: string;
  events: string;
  filters: string | null;
  description: string | null;
  secret_hint: string;
  active: number;
  created_at: string;
  updated_at: string;
};

const shape = (r: SubRow, stats?: { delivered: number; failing: number; dead: number }) => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events) as string[],
  filters: r.filters ? JSON.parse(r.filters) : null,
  description: r.description,
  secretHint: `whsec_…${r.secret_hint}`,
  active: r.active === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(stats ? { deliveries: stats } : {}),
});

function checkUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function checkEvents(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const list = [...new Set(raw.map(String))];
  return list.every((e) => TYPES.has(e)) ? list : null;
}

function checkFilters(raw: unknown): { addresses: string[] } | null | "bad" {
  if (raw === undefined || raw === null) return null;
  const a = (raw as { addresses?: unknown }).addresses;
  if (a === undefined) return null;
  if (!Array.isArray(a) || a.length > 50 || !a.every((x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x))) return "bad";
  return a.length ? { addresses: [...new Set(a.map((x: string) => x.toLowerCase()))] } : null;
}

async function owned(env: Env, id: string, owner: string) {
  return env.DB.prepare("SELECT * FROM webhook_subscriptions WHERE id = ? AND owner = ?").bind(id, owner).first<SubRow>();
}

function changed(env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(indexerStub(env).webhooksChanged().catch(() => undefined));
}

webhooks.get("/webhooks/events", (c) => {
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ events: WEBHOOK_EVENTS.map((type) => ({ type, description: WEBHOOK_EVENT_DESCRIPTIONS[type] })) });
});

webhooks.get("/webhooks", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const { results } = await c.env.DB.prepare("SELECT * FROM webhook_subscriptions WHERE owner = ? ORDER BY created_at DESC").bind(a.address).all<SubRow>();
  const { results: stats } = await c.env.DB.prepare(
    `SELECT subscription_id, SUM(status = 'delivered') AS delivered, SUM(status = 'failed') AS failing, SUM(status = 'dead') AS dead
     FROM webhook_deliveries WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE owner = ?) GROUP BY subscription_id`,
  )
    .bind(a.address)
    .all<{ subscription_id: string; delivered: number; failing: number; dead: number }>();
  const by = new Map(stats.map((s) => [s.subscription_id, { delivered: s.delivered, failing: s.failing, dead: s.dead }]));
  c.header("Cache-Control", "no-store");
  return c.json({ webhooks: results.map((r) => shape(r, by.get(r.id) ?? { delivered: 0, failing: 0, dead: 0 })) });
});

webhooks.post("/webhooks", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  if (!c.env.WEBHOOK_MASTER_KEY) return err(c, 503, "webhooks_unavailable", "Webhooks are not configured on this network yet.");
  const body = (await c.req.json().catch(() => null)) as { url?: unknown; events?: unknown; filters?: unknown; description?: unknown } | null;
  const url = checkUrl(body?.url);
  if (!url) return err(c, 400, "bad_url", "Use a public https URL on the default port, for example https://example.com/curveil.");
  const events = checkEvents(body?.events);
  if (!events) return err(c, 400, "bad_events", `Pick one or more of: ${WEBHOOK_EVENTS.join(", ")} (or "*").`);
  const filters = checkFilters(body?.filters);
  if (filters === "bad") return err(c, 400, "bad_filters", "filters.addresses must be a list of up to 50 addresses.");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE owner = ?").bind(a.address).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SUBSCRIPTIONS) return err(c, 409, "too_many_webhooks", `You can have ${MAX_SUBSCRIPTIONS} webhooks. Delete one first.`);

  const id = newId("whk_");
  const secret = newSigningSecret();
  const now = new Date();
  const row: SubRow = {
    id,
    owner: a.address,
    url,
    events: JSON.stringify(events),
    filters: filters ? JSON.stringify(filters) : null,
    description: typeof body?.description === "string" ? body.description.trim().slice(0, 120) || null : null,
    secret_hint: secret.slice(-4),
    active: 1,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await c.env.DB.prepare(
    `INSERT INTO webhook_subscriptions (id, owner, url, events, filters, description, secret_enc, secret_hint, active, created_at, created_ts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, a.address, url, row.events, row.filters, row.description, await encryptSecret(secret, id, c.env.WEBHOOK_MASTER_KEY), row.secret_hint, row.created_at, Math.floor(now.getTime() / 1000), row.updated_at)
    .run();
  changed(c.env, c.executionCtx as ExecutionContext);
  c.header("Cache-Control", "no-store");
  return c.json({ webhook: shape(row), secret, notice: "Copy the signing secret now. It is shown once; rotate it if it is lost." }, 201);
});

webhooks.get("/webhooks/:id", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  c.header("Cache-Control", "no-store");
  return c.json({ webhook: shape(row) });
});

webhooks.patch("/webhooks/:id", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; events?: unknown; filters?: unknown; description?: unknown; active?: unknown };
  const next = { ...row };
  if (body.url !== undefined) {
    const url = checkUrl(body.url);
    if (!url) return err(c, 400, "bad_url", "Use a public https URL on the default port.");
    next.url = url;
  }
  if (body.events !== undefined) {
    const events = checkEvents(body.events);
    if (!events) return err(c, 400, "bad_events", `Pick one or more of: ${WEBHOOK_EVENTS.join(", ")} (or "*").`);
    next.events = JSON.stringify(events);
  }
  if (body.filters !== undefined) {
    const f = checkFilters(body.filters);
    if (f === "bad") return err(c, 400, "bad_filters", "filters.addresses must be a list of up to 50 addresses.");
    next.filters = f ? JSON.stringify(f) : null;
  }
  if (body.description !== undefined) next.description = typeof body.description === "string" ? body.description.trim().slice(0, 120) || null : null;
  if (body.active !== undefined) next.active = body.active ? 1 : 0;
  next.updated_at = new Date().toISOString();
  await c.env.DB.prepare("UPDATE webhook_subscriptions SET url = ?, events = ?, filters = ?, description = ?, active = ?, updated_at = ? WHERE id = ?")
    .bind(next.url, next.events, next.filters, next.description, next.active, next.updated_at, row.id)
    .run();
  changed(c.env, c.executionCtx as ExecutionContext);
  return c.json({ webhook: shape(next) });
});

webhooks.delete("/webhooks/:id", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE subscription_id = ?)").bind(row.id),
    c.env.DB.prepare("DELETE FROM webhook_deliveries WHERE subscription_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").bind(row.id),
  ]);
  changed(c.env, c.executionCtx as ExecutionContext);
  return c.json({ ok: true });
});

webhooks.post("/webhooks/:id/rotate-secret", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  if (!c.env.WEBHOOK_MASTER_KEY) return err(c, 503, "webhooks_unavailable", "Webhooks are not configured on this network yet.");
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  const secret = newSigningSecret();
  await c.env.DB.prepare("UPDATE webhook_subscriptions SET secret_enc = ?, secret_hint = ?, updated_at = ? WHERE id = ?")
    .bind(await encryptSecret(secret, row.id, c.env.WEBHOOK_MASTER_KEY), secret.slice(-4), new Date().toISOString(), row.id)
    .run();
  c.header("Cache-Control", "no-store");
  return c.json({ secret, notice: "Deliveries are signed with the new secret from now on, including retries of older ones." });
});

/** Sends a sample event, marked test: true, through the normal delivery path. */
webhooks.post("/webhooks/:id/test", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  if (!c.env.WEBHOOKS) return err(c, 503, "webhooks_unavailable", "Webhook delivery is not configured on this network yet.");
  const body = (await c.req.json().catch(() => ({}))) as { type?: string };
  const type = body.type && (WEBHOOK_EVENTS as readonly string[]).includes(body.type) ? body.type : "webhook.test";
  const { manifest } = await loadManifest(c.env);
  const now = new Date();
  const key = `${row.id}:${now.getTime()}:${crypto.randomUUID()}`;
  const event: ChainEvent = {
    id: eventId("test", key),
    type: type as ChainEvent["type"],
    createdAt: now.toISOString(),
    block: null,
    transactionHash: null,
    logIndex: null,
    finality: "sequencer",
    data: sample(type),
    addresses: [],
  };
  const id = deliveryId(row.id, event.id);
  const ts = Math.floor(now.getTime() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_ts, window_ts, created_at, created_ts)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
  )
    .bind(id, row.id, event.id, type, payload(event, manifest.network, manifest.chainId, true), ts, ts, now.toISOString(), ts)
    .run();
  await enqueue(c.env, [{ delivery: id, attempt: 0 }]);
  return c.json({ delivery: id, eventId: event.id, type, message: "Queued. It usually arrives within a few seconds; check the deliveries list for the result." }, 202);
});

webhooks.get("/webhooks/:id/deliveries", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  const status = c.req.query("status");
  const before = Number(c.req.query("before") ?? 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
  const where = ["subscription_id = ?"];
  const binds: unknown[] = [row.id];
  if (status) {
    if (!["pending", "delivered", "failed", "dead"].includes(status)) return err(c, 400, "bad_status", "status is pending, delivered, failed or dead.");
    where.push("status = ?");
    binds.push(status);
  }
  if (before > 0) {
    where.push("created_ts < ?");
    binds.push(before);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, event_id, event_type, status, attempts, next_attempt_ts, last_status, last_error, last_attempt_at, created_at, created_ts, delivered_at, payload
     FROM webhook_deliveries WHERE ${where.join(" AND ")} ORDER BY created_ts DESC, id LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<Record<string, any>>();
  const ids = results.map((r) => r.id as string);
  const attempts = ids.length
    ? (
        await c.env.DB.prepare(`SELECT delivery_id, attempt, at, status, duration_ms, error FROM webhook_attempts WHERE delivery_id IN (${ids.map(() => "?").join(",")}) ORDER BY attempt`)
          .bind(...ids)
          .all<{ delivery_id: string; attempt: number; at: string; status: number | null; duration_ms: number; error: string | null }>()
      ).results
    : [];
  c.header("Cache-Control", "no-store");
  return c.json({
    deliveries: results.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      type: r.event_type,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_ts && r.status !== "delivered" && r.status !== "dead" ? new Date(r.next_attempt_ts * 1000).toISOString() : null,
      lastStatus: r.last_status,
      lastError: r.last_error,
      lastAttemptAt: r.last_attempt_at,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
      payload: JSON.parse(r.payload),
      history: attempts.filter((x) => x.delivery_id === r.id).map(({ delivery_id: _d, ...x }) => ({ ...x, durationMs: x.duration_ms, duration_ms: undefined })),
    })),
    next: results.length === limit ? results[results.length - 1]!.created_ts : null,
  });
});

/**
 * Sends deliveries again with a fresh 24-hour retry window: the ones named, or every dead (or
 * failing) one. The body and event id stay the same, so receivers can still de-duplicate.
 */
webhooks.post("/webhooks/:id/replay", async (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  const row = await owned(c.env, c.req.param("id"), a.address);
  if (!row) return err(c, 404, "not_found", "No webhook with that id on your account.");
  if (row.active !== 1) return err(c, 409, "disabled", "Enable the webhook before replaying deliveries.");
  const body = (await c.req.json().catch(() => ({}))) as { deliveries?: unknown; status?: unknown };
  const ts = Math.floor(Date.now() / 1000);
  let picked: { id: string; attempts: number }[];
  if (Array.isArray(body.deliveries) && body.deliveries.length > 0) {
    const ids = body.deliveries.slice(0, 100).map(String);
    picked = (
      await c.env.DB.prepare(`SELECT id, attempts FROM webhook_deliveries WHERE subscription_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
        .bind(row.id, ...ids)
        .all<{ id: string; attempts: number }>()
    ).results;
  } else {
    const status = body.status === "failed" ? "failed" : "dead";
    picked = (
      await c.env.DB.prepare("SELECT id, attempts FROM webhook_deliveries WHERE subscription_id = ? AND status = ? ORDER BY created_ts LIMIT 100")
        .bind(row.id, status)
        .all<{ id: string; attempts: number }>()
    ).results;
  }
  if (picked.length === 0) return c.json({ replayed: 0 });
  await c.env.DB.batch(
    picked.map((p) =>
      c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', next_attempt_ts = ?, window_ts = ?, delivered_at = NULL WHERE id = ?").bind(ts, ts, p.id),
    ),
  );
  await enqueue(c.env, picked.map((p) => ({ delivery: p.id, attempt: p.attempts })));
  return c.json({ replayed: picked.length, deliveries: picked.map((p) => p.id) });
});

const Z = "0x0000000000000000000000000000000000000000";
function sample(type: string): Record<string, unknown> {
  switch (type) {
    case "swap":
      return { venue: "damm", pool: Z, sender: Z, recipient: Z, tokenIn: Z, tokenOut: Z, amountIn: "1000000", amountOut: "490000000000000", fee: "3000", feeBps: 30 };
    case "liquidity.changed":
      return { pool: Z, kind: "add", owner: Z, counterparty: null, amount0: "1000000", amount1: "500000000000000", shares: "1000", bins: null };
    case "launch.created":
      return { token: Z, curve: Z, creator: Z, creatorRecipient: Z, templateId: 0, name: "Test Coin", symbol: "TEST", metadataURI: "", operator: null, operatorShareBps: null };
    case "launch.progress":
      return { token: Z, curve: Z, operator: null, progressPercent: 50, previousPercent: 40, reserve: "12500000000", graduationThreshold: "25000000000" };
    case "launch.graduated":
      return { token: Z, curve: Z, operator: null, pool: Z };
    case "escrow.unlocked":
      return { lockId: 1, lpToken: Z, beneficiary: Z, unlockAt: Math.floor(Date.now() / 1000) };
    case "perps.liquidation":
      return { positionId: "1", owner: Z, marketId: 1, isLong: true, liquidator: Z, price: "1867000000000000000000", pnl: "-97000000", funding: "0", fee: "2490000", toVault: "97110000" };
    case "operator.fee_paid":
      return { operator: Z, token: Z, recipient: Z, amount: "1000000" };
    default:
      return { message: "This is a test delivery from Curveil. Verify the Curveil-Signature header against your signing secret." };
  }
}
