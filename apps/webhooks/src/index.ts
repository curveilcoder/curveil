/**
 * Curveil webhook delivery Worker.
 *
 * The indexer (in the API Worker) writes one webhook_deliveries row per subscription and chain
 * event, then puts the delivery id on the curveil-webhooks queue. This Worker consumes the
 * queue: it signs the stored body with the subscription's secret, POSTs it, and records the
 * attempt. A failed attempt is retried through the queue with exponential backoff for 24 hours;
 * after that the delivery is marked dead and its id is sent to the dead-letter queue. A dead
 * delivery can be replayed from the API, which starts a fresh 24-hour window.
 *
 * Rows are the source of truth, so a duplicate or late message is harmless: a delivery that is
 * already delivered or dead is acknowledged without sending.
 */
import { HEADERS, signWebhook } from "@curveil/sdk/webhooks";
import { decryptSecret } from "./secrets";
import { delivered, nextDelay } from "./retry";

export interface Env {
  DB: D1Database;
  /** This Worker's own queue, for scheduling retries. */
  QUEUE: Queue<DeliveryMessage>;
  DLQ: Queue<DeadLetter>;
  NETWORK: "testnet" | "mainnet";
  WEBHOOK_MASTER_KEY: string;
  /** Per-attempt timeout. */
  TIMEOUT_MS?: string;
}

/** `attempt`: how many attempts the row had when the message was sent. A message whose count no
 *  longer matches the row is stale (a retry was already scheduled another way) and is dropped. */
export type DeliveryMessage = { delivery: string; attempt: number };
export type DeadLetter = { delivery: string; subscription: string; reason: string; at: string };

type Row = {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: "pending" | "delivered" | "failed" | "dead";
  attempts: number;
  next_attempt_ts: number | null;
  window_ts: number;
  url: string;
  secret_enc: string;
  active: number;
};

export type Outcome = { kind: "ack" } | { kind: "retry"; delaySeconds: number; attempt: number };

const now = () => Math.floor(Date.now() / 1000);

/** One delivery attempt. Exported for tests; `send` is fetch. */
export async function deliver(env: Env, msg: DeliveryMessage, send: typeof fetch = fetch): Promise<Outcome> {
  const id = msg.delivery;
  const row = await env.DB.prepare(
    `SELECT d.id, d.subscription_id, d.event_id, d.event_type, d.payload, d.status, d.attempts, d.next_attempt_ts, d.window_ts,
       s.url, s.secret_enc, s.active
     FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id WHERE d.id = ?`,
  )
    .bind(id)
    .first<Row>();
  if (!row || row.status === "delivered" || row.status === "dead") return { kind: "ack" };
  if (row.attempts !== msg.attempt) return { kind: "ack" };
  const t = now();
  if (row.active !== 1) {
    await markDead(env, row, "The subscription is disabled.");
    return { kind: "ack" };
  }

  const attempt = row.attempts + 1;
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  let response: string | null = null;
  try {
    const secret = await decryptSecret(row.secret_enc, row.subscription_id, env.WEBHOOK_MASTER_KEY);
    const signature = await signWebhook(secret, row.payload, t);
    const r = await send(row.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(Number(env.TIMEOUT_MS ?? 10_000)),
      headers: {
        "content-type": "application/json",
        "user-agent": "Curveil-Webhooks/1",
        [HEADERS.eventId]: row.event_id,
        [HEADERS.eventType]: row.event_type,
        [HEADERS.deliveryId]: row.id,
        [HEADERS.timestamp]: String(t),
        [HEADERS.signature]: signature,
      },
      body: row.payload,
    });
    status = r.status;
    response = (await r.text().catch(() => "")).slice(0, 500);
    if (!delivered(r.status)) error = r.status >= 300 && r.status < 400 ? `Redirect (${r.status}) not followed` : `HTTP ${r.status}`;
  } catch (e) {
    error = e instanceof Error ? (e.name === "TimeoutError" ? "Timed out" : e.message) : String(e);
  }
  const ms = Date.now() - started;
  const at = new Date().toISOString();
  const record = env.DB.prepare(
    "INSERT OR REPLACE INTO webhook_attempts (delivery_id, attempt, at, status, duration_ms, error, response) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, attempt, at, status, ms, error?.slice(0, 300) ?? null, response);

  if (!error) {
    await env.DB.batch([
      record,
      env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, last_attempt_at = ?, delivered_at = ?, next_attempt_ts = NULL WHERE id = ? AND attempts = ?",
      ).bind(attempt, status, at, at, row.id, row.attempts),
    ]);
    return { kind: "ack" };
  }
  const delay = nextDelay(row.window_ts, t);
  if (delay === null) {
    await env.DB.batch([
      record,
      env.DB.prepare("UPDATE webhook_deliveries SET attempts = ?, last_status = ?, last_error = ?, last_attempt_at = ? WHERE id = ? AND attempts = ?").bind(
        attempt,
        status,
        error.slice(0, 300),
        at,
        row.id,
        row.attempts,
      ),
    ]);
    await markDead(env, row, `Still failing after 24 hours: ${error}`.slice(0, 300));
    return { kind: "ack" };
  }
  await env.DB.batch([
    record,
    env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ?, last_attempt_at = ?, next_attempt_ts = ? WHERE id = ? AND attempts = ?",
    ).bind(attempt, status, error.slice(0, 300), at, t + delay, row.id, row.attempts),
  ]);
  return { kind: "retry", delaySeconds: delay, attempt };
}

async function markDead(env: Env, row: Pick<Row, "id" | "subscription_id">, reason: string) {
  await env.DB.prepare("UPDATE webhook_deliveries SET status = 'dead', last_error = ?, next_attempt_ts = NULL WHERE id = ?").bind(reason, row.id).run();
  await env.DLQ.send({ delivery: row.id, subscription: row.subscription_id, reason, at: new Date().toISOString() });
}

export default {
  async queue(batch: MessageBatch<DeliveryMessage | DeadLetter>, env: Env) {
    // The dead-letter queue has no consumer of its own here; rows already say "dead".
    await Promise.all(
      batch.messages.map(async (m) => {
        try {
          if (!("attempt" in m.body)) return m.ack(); // a dead letter: nothing to do
          const out = await deliver(env, m.body);
          if (out.kind === "retry") await env.QUEUE.send({ delivery: m.body.delivery, attempt: out.attempt }, { delaySeconds: out.delaySeconds });
          m.ack();
        } catch (e) {
          console.error("delivery failed to run", m.body.delivery, e);
          m.retry({ delaySeconds: 60 });
        }
      }),
    );
  },
  async fetch(req: Request) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return new Response("ok");
    return Response.json({ service: "curveil-webhooks", message: "Delivers Curveil webhooks. Manage subscriptions through the Curveil API." });
  },
} satisfies ExportedHandler<Env, DeliveryMessage | DeadLetter>;
