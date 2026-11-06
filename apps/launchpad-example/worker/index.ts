import { verifyWebhookRequest, WebhookVerificationError, type WebhookEvent } from "@curveil/sdk/webhooks";

type Env = {
  ASSETS: Fetcher;
  /** Verified webhook events (kept 7 days), for the page's activity feed. */
  EVENTS?: KVNamespace;
  /** The launchpad this site serves (its slug or operator address). */
  LAUNCHPAD: string;
  NETWORK: "testnet" | "mainnet";
  API_URL: string;
  /** The webhook endpoint's signing secret (whsec_...), set with `wrangler secret put`. */
  WEBHOOK_SECRET?: string;
};

const KEEP = 25; // events shown
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/config.json") {
      return json({ launchpad: env.LAUNCHPAD, network: env.NETWORK, apiUrl: env.API_URL, webhooks: Boolean(env.WEBHOOK_SECRET && env.EVENTS) });
    }

    if (url.pathname === "/webhooks/recent" && request.method === "GET") {
      const list = env.EVENTS ? await env.EVENTS.list<Summary>({ prefix: "e:", limit: KEEP }) : { keys: [] };
      return json({ events: list.keys.map((k) => k.metadata).filter(Boolean) });
    }

    if (url.pathname === "/webhooks" && request.method === "POST") {
      if (!env.WEBHOOK_SECRET) return json({ error: "not configured" }, 503);
      let event: WebhookEvent;
      try {
        event = await verifyWebhookRequest(request, env.WEBHOOK_SECRET);
      } catch (e) {
        // 401 shows up in the Curveil delivery log; like any non-2xx answer it is retried, then dead-lettered.
        if (e instanceof WebhookVerificationError) return json({ error: e.message }, 401);
        throw e;
      }
      if (env.EVENTS) {
        // One key per event, named by event time (newest first in a listing) and id. Deliveries
        // arrive concurrently, and retries and replays reuse the id, so the write is idempotent
        // and nothing is read-modify-written.
        const t = Date.parse(event.createdAt) || Date.now();
        const key = `e:${String(9_999_999_999_999 - t).padStart(13, "0")}:${event.id}`;
        const summary: Summary = { id: event.id, type: event.type, createdAt: event.createdAt, test: Boolean(event.test), tx: event.transactionHash, receivedAt: new Date().toISOString() };
        await env.EVENTS.put(key, JSON.stringify(event), { metadata: summary, expirationTtl: 7 * 86_400 });
      }
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};

type Summary = { id: string; type: string; createdAt: string; test: boolean; tx: string | null; receivedAt: string };
