/**
 * Curveil webhooks: event types, payload shape, and signature checks.
 *
 * Every delivery is a POST with a JSON body and these headers:
 *
 *   Curveil-Event-Id     stable id of the chain event (the same on every retry and replay)
 *   Curveil-Event-Type   one of WEBHOOK_EVENTS, or "webhook.test"
 *   Curveil-Delivery-Id  id of this delivery (one per subscription and event)
 *   Curveil-Timestamp    unix seconds when this attempt was signed
 *   Curveil-Signature    t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<body>">
 *
 * Verify the signature against the raw body before parsing it, reject timestamps far from
 * now (replays), and use the event id to ignore duplicates: a delivery can arrive more than once.
 * Uses Web Crypto only, so it runs in browsers, Workers, Deno, Bun and Node 18+.
 */

export const WEBHOOK_EVENTS = [
  "swap",
  "liquidity.changed",
  "launch.created",
  "launch.progress",
  "launch.graduated",
  "escrow.unlocked",
  "perps.liquidation",
  "operator.fee_paid",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  swap: "A swap on a DAMM pool or DLMM pair, or a trade on a launch's bonding curve.",
  "liquidity.changed": "Liquidity added to or removed from a pool, fees claimed, or a position transferred.",
  "launch.created": "A new token launch, with the launchpad operator it runs on, if any.",
  "launch.progress": "A launch's curve reserve crossed the next 10% step towards graduation.",
  "launch.graduated": "A launch graduated: its liquidity moved into a DAMM pool and the LP was escrowed.",
  "escrow.unlocked": "An escrowed LP lock reached its unlock time and can be claimed.",
  "perps.liquidation": "A perpetual position was liquidated.",
  "operator.fee_paid": "A launchpad operator's fee splitter paid a recipient.",
};

export type WebhookEvent<T = Record<string, unknown>> = {
  /** Stable per chain event. Use it to ignore duplicates. */
  id: string;
  type: WebhookEventType | "webhook.test";
  network: "testnet" | "mainnet";
  chainId: number;
  /** When the event happened on chain (block time), ISO 8601. */
  createdAt: string;
  /** The block that holds the event; for escrow.unlocked, the block where the unlock time was seen. */
  block: { number: number; hash: string; timestamp: number } | null;
  transactionHash: string | null;
  logIndex: number | null;
  /** Events are sent once the sequencer has included them, before L1 finality. */
  finality: "sequencer";
  data: T;
  /** Set on test deliveries sent from the developer console or the test endpoint. */
  test?: boolean;
};

export const HEADERS = {
  eventId: "Curveil-Event-Id",
  eventType: "Curveil-Event-Type",
  deliveryId: "Curveil-Delivery-Id",
  timestamp: "Curveil-Timestamp",
  signature: "Curveil-Signature",
} as const;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const enc = new TextEncoder();

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function fromHex(h: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(h)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The Curveil-Signature header value for `body` signed at `timestamp` (unix seconds). */
export async function signWebhook(secret: string, body: string, timestamp: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${toHex(mac)}`;
}

export type VerifyOptions = {
  /** The subscription's signing secret (whsec_...). */
  secret: string;
  /** The raw request body, exactly as received. */
  body: string;
  /** The Curveil-Signature header. */
  signature: string | null | undefined;
  /** Largest accepted distance between the signed time and now. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Unix seconds; defaults to the current time. */
  now?: number;
};

/**
 * Checks a delivery's signature and returns the parsed event. Throws WebhookVerificationError
 * when the header is missing or malformed, the timestamp is outside the tolerance, or no
 * signature matches. The comparison is constant-time (Web Crypto's HMAC verify).
 */
export async function verifyWebhook<T = Record<string, unknown>>(o: VerifyOptions): Promise<WebhookEvent<T>> {
  if (!o.signature) throw new WebhookVerificationError("Missing Curveil-Signature header");
  const parts = o.signature.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isInteger(t) || sigs.length === 0) throw new WebhookVerificationError("Malformed Curveil-Signature header");
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (o.toleranceSeconds ?? 300)) throw new WebhookVerificationError("Signature timestamp is outside the tolerance");
  const key = await hmacKey(o.secret, "verify");
  const data = enc.encode(`${t}.${o.body}`);
  for (const s of sigs) {
    const bytes = fromHex(s);
    if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, data))) {
      try {
        return JSON.parse(o.body) as WebhookEvent<T>;
      } catch {
        throw new WebhookVerificationError("Body is not JSON");
      }
    }
  }
  throw new WebhookVerificationError("No signature matches");
}

/** Convenience for Fetch-style handlers (Workers, Deno, Bun, Next.js route handlers). */
export async function verifyWebhookRequest<T = Record<string, unknown>>(
  request: Request,
  secret: string,
  toleranceSeconds?: number,
): Promise<WebhookEvent<T>> {
  const body = await request.text();
  return verifyWebhook<T>({ secret, body, signature: request.headers.get(HEADERS.signature), toleranceSeconds });
}
