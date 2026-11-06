/**
 * Webhook production inside the indexer: matches the events of a range against active
 * subscriptions, writes one webhook_deliveries row per match and queues the new ones for the
 * delivery Worker (apps/webhooks). Delivery ids are derived from (subscription, event), so a
 * re-indexed range inserts nothing new and queues nothing twice.
 */
import type { Env } from "../lib";
import { deliveryId, matches, payload, type ChainEvent, type Subscription } from "./events";

const CACHE_MS = 20_000;

export class WebhookProducer {
  private subs: Subscription[] | null = null;
  private loadedAt = 0;

  constructor(private env: Env) {}

  /** Called by the API when a subscription changes, so the next tick sees it. */
  invalidate() {
    this.subs = null;
  }

  async subscriptions(): Promise<Subscription[]> {
    if (this.subs && Date.now() - this.loadedAt < CACHE_MS) return this.subs;
    const { results } = await this.env.DB.prepare("SELECT id, events, filters, created_ts FROM webhook_subscriptions WHERE active = 1")
      .all<{ id: string; events: string; filters: string | null; created_ts: number }>()
      .catch(() => ({ results: [] as { id: string; events: string; filters: string | null; created_ts: number }[] }));
    this.subs = results.map((r) => {
      const f = r.filters ? (JSON.parse(r.filters) as { addresses?: string[] }) : null;
      return { id: r.id, events: JSON.parse(r.events) as string[], addresses: f?.addresses?.map((a) => a.toLowerCase()) ?? null, createdTs: r.created_ts };
    });
    this.loadedAt = Date.now();
    return this.subs;
  }

  /** Event types some active subscription wants ("*" means all). */
  async wanted(): Promise<Set<string>> {
    return new Set((await this.subscriptions()).flatMap((s) => s.events));
  }

  /** Writes deliveries for `events` and queues the ones that are new. Returns how many were queued. */
  async produce(events: ChainEvent[], network: "testnet" | "mainnet", chainId: number): Promise<number> {
    if (events.length === 0) return 0;
    const subs = await this.subscriptions();
    const db = this.env.DB;
    const now = Math.floor(Date.now() / 1000);
    const iso = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [];
    for (const e of events) {
      let body: string | null = null;
      for (const s of subs) {
        if (!matches(s, e)) continue;
        body ??= payload(e, network, chainId);
        stmts.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO webhook_deliveries (id, subscription_id, event_id, event_type, payload, status, attempts,
                 next_attempt_ts, window_ts, created_at, created_ts) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?) RETURNING id`,
            )
            .bind(deliveryId(s.id, e.id), s.id, e.id, e.type, body, now, now, iso, now),
        );
      }
    }
    const fresh: string[] = [];
    for (let i = 0; i < stmts.length; i += 100) {
      const res = await db.batch<{ id: string }>(stmts.slice(i, i + 100));
      for (const r of res) for (const row of r.results ?? []) fresh.push(row.id);
    }
    await enqueue(this.env, fresh.map((delivery) => ({ delivery, attempt: 0 })));
    return fresh.length;
  }

  /**
   * Re-queues deliveries whose message was lost: never attempted after five minutes, or a retry
   * overdue by fifteen. Runs now and then from the indexer.
   */
  async sweep(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const { results } = await this.env.DB.prepare(
      `SELECT id, attempts FROM webhook_deliveries
       WHERE (status = 'pending' AND next_attempt_ts < ?) OR (status = 'failed' AND next_attempt_ts < ?)
       ORDER BY next_attempt_ts LIMIT 100`,
    )
      .bind(now - 300, now - 900)
      .all<{ id: string; attempts: number }>();
    await enqueue(this.env, results.map((r) => ({ delivery: r.id, attempt: r.attempts })));
    return results.length;
  }
}

export type DeliveryMessage = { delivery: string; attempt: number };

export async function enqueue(env: Pick<Env, "WEBHOOKS">, messages: DeliveryMessage[]) {
  if (!env.WEBHOOKS || messages.length === 0) return;
  for (let i = 0; i < messages.length; i += 100) {
    await env.WEBHOOKS.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
  }
}
