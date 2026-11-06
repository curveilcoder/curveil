/**
 * OpenAPI 3.1 description of the public API, served at /v1/openapi.json. The developer console
 * renders its reference from this document, and the SDK's client follows it. Keep it in step
 * with the routes: openapi.test.ts checks every route in the app is described here.
 */
import { Hono } from "hono";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_DESCRIPTIONS } from "@curveil/sdk/webhooks";
import type { Env } from "./lib";
import { LIMITS } from "./auth";

export const openapi = new Hono<{ Bindings: Env }>();

type Param = { name: string; in: "path" | "query"; description: string; required?: boolean; schema?: Record<string, unknown> };
type Op = {
  tag: string;
  summary: string;
  description?: string;
  params?: Param[];
  body?: Record<string, unknown>;
  response?: Record<string, unknown>;
  auth?: "optional" | "required" | "session";
  status?: number;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string, extra: Record<string, unknown> = {}) => ({ type: "string", ...(description ? { description } : {}), ...extra });
const int = (description?: string) => ({ type: "integer", ...(description ? { description } : {}) });
const bool = (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) });
const arr = (items: Record<string, unknown>, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required?: string[]) => ({ type: "object", properties, ...(required ? { required } : {}) });
const address = (description = "Checksummed address") => str(description, { pattern: "^0x[0-9a-fA-F]{40}$" });
const amount = (description = "Integer amount in the token's smallest unit") => str(description, { pattern: "^[0-9]+$" });
const path = (name: string, description: string): Param => ({ name, in: "path", description, required: true, schema: { type: "string" } });
const query = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }): Param => ({ name, in: "query", description, schema });

const ROUTES: Record<string, Partial<Record<"get" | "post" | "patch" | "delete", Op>>> = {
  "/v1/status": { get: { tag: "Status", summary: "Network, chain, indexer and module status" } },
  "/v1/manifest/{network}": {
    get: { tag: "Status", summary: "Deployment manifest", description: "Every contract address, deploy block, code hash and verification state.", params: [path("network", "testnet or mainnet")] },
  },
  "/v1/assets": { get: { tag: "Status", summary: "Listed assets" } },
  "/v1/governance": { get: { tag: "Status", summary: "Timelock queue, treasury balances and releases, and buybacks", description: "Every admin change scheduled in the timelock with its state (pending, ready, executed, cancelled), live balances of the protocol treasuries, and buyback burns." } },
  "/v1/indexer": { get: { tag: "Status", summary: "Indexer progress and the code version it runs" } },
  "/v1/openapi.json": { get: { tag: "Status", summary: "This document" } },

  "/v1/markets": { get: { tag: "Markets", summary: "DAMM pools and DLMM pairs with state and 24h stats", params: [query("creator", "Only pools this address created (graduation pools have no creator)")] } },
  "/v1/markets/{pool}": { get: { tag: "Markets", summary: "One pool", params: [path("pool", "Pool or pair address")] } },
  "/v1/markets/{pool}/swaps": { get: { tag: "Markets", summary: "Recent swaps on a pool", params: [path("pool", "Pool or pair address"), query("limit", "Up to 200")] } },
  "/v1/accounts/{address}/activity": { get: { tag: "Markets", summary: "Swaps and liquidity events of an address", params: [path("address", "Account")] } },
  "/v1/accounts/{address}/positions": { get: { tag: "Markets", summary: "Liquidity positions of an address", params: [path("address", "Account")] } },

  "/v1/launches": {
    get: {
      tag: "Launch",
      summary: "Launches with curve state and 24h stats",
      params: [
        query("state", "created, trading, graduation_ready or graduated"),
        query("creator", "Only launches by this creator"),
        query("operator", "Only launches on this launchpad (operator address)"),
        query("sort", "new, volume, progress or active"),
        query("limit", "Up to 200", { type: "integer" }),
      ],
    },
  },
  "/v1/launches/templates": { get: { tag: "Launch", summary: "Launch templates and their economics" } },
  "/v1/launches/metadata": {
    post: { tag: "Launch", summary: "Store token metadata and image", description: "Multipart form: name, symbol, description, links, image. Rate limited per IP. Returns the metadata URI to pass to createLaunch." },
  },
  "/v1/launches/metadata/{hash}": { get: { tag: "Launch", summary: "Token metadata by content hash", params: [path("hash", "Content hash")] } },
  "/v1/launches/metadata/{hash}/image": { get: { tag: "Launch", summary: "Token image by content hash", params: [path("hash", "Content hash")] } },
  "/v1/launches/{token}": { get: { tag: "Launch", summary: "One launch, read live from its curve", params: [path("token", "Token address")] } },
  "/v1/launches/{token}/trades": { get: { tag: "Launch", summary: "Trades on a launch's curve", params: [path("token", "Token address")] } },
  "/v1/escrow/{owner}": { get: { tag: "Launch", summary: "LP locks held by an address", params: [path("owner", "Beneficiary")] } },

  "/v1/factory": { get: { tag: "Launchpads", summary: "Launchpad registry: address, share cap and rules" } },
  "/v1/operators": {
    get: { tag: "Launchpads", summary: "Registered launchpads", params: [query("admin", "Only launchpads run by this admin"), query("limit", "Up to 200", { type: "integer" })], response: obj({ maxShareBps: int(), operators: arr(ref("Operator")) }) },
    post: {
      tag: "Launchpads",
      summary: "Set a launchpad's off-chain settings",
      description: "Domain, description and contact, kept by the API (not on chain). Only the launchpad admin, signed in with a session. Fields left out keep their value; null clears one. A new domain needs a TXT record and a verify call before it is served.",
      auth: "session",
      body: obj({ operator: address("Operator (FeeSplitter) address"), domain: str("Hostname, e.g. launch.example.com; null to clear"), description: str(), contact: str() }, ["operator"]),
    },
  },
  "/v1/operators/by-domain/{domain}": { get: { tag: "Launchpads", summary: "The launchpad serving a verified domain", params: [path("domain", "Hostname")], response: obj({ operator: ref("Operator") }) } },
  "/v1/operators/{id}": { get: { tag: "Launchpads", summary: "One launchpad", params: [path("id", "Operator address or slug")], response: obj({ operator: ref("Operator"), maxShareBps: int() }) } },
  "/v1/operators/{id}/revenue": {
    get: {
      tag: "Launchpads",
      summary: "A launchpad's fees: uncollected, allocated and paid, per token and recipient",
      description: "Balances are read live from the curves and the operator's FeeSplitter. Daily figures are estimates from indexed trades.",
      params: [path("id", "Operator address or slug")],
      response: ref("Revenue"),
    },
  },
  "/v1/operators/{id}/domain/verify": {
    post: { tag: "Launchpads", summary: "Check the domain's TXT record", description: "Looks up _curveil.<domain> TXT = curveil-operator=<address>.", auth: "session", params: [path("id", "Operator address")] },
  },

  "/v1/vault/status": { get: { tag: "Vault", summary: "Shielded pool status" } },
  "/v1/vault/roots": { get: { tag: "Vault", summary: "Recent Merkle roots" } },
  "/v1/vault/commitments": { get: { tag: "Vault", summary: "Note commitments, for wallet scanning" } },
  "/v1/vault/nullifiers": { get: { tag: "Vault", summary: "Spent nullifiers" } },
  "/v1/vault/activity": { get: { tag: "Vault", summary: "Public deposit and withdrawal activity" } },
  "/v1/vault/positions": { get: { tag: "Vault", summary: "Shielded liquidity positions (public parts)" } },
  "/v1/ceremony/contributions": {
    post: {
      tag: "Vault",
      summary: "Upload a setup ceremony contribution",
      description: "Only while a ceremony round is open. The body is the new .zkey (8 to 12 MiB). Curveil checks it before it counts.",
      params: [query("circuit", "transfer or withdraw"), query("name", "The contributor's public name")],
    },
  },

  "/v1/perps/markets": { get: { tag: "Perps", summary: "Perpetual markets with price, funding and open interest" } },
  "/v1/perps/markets/{id}/funding": { get: { tag: "Perps", summary: "Funding history", params: [path("id", "Market id")] } },
  "/v1/perps/markets/{id}/prices": { get: { tag: "Perps", summary: "Recorded prices", params: [path("id", "Market id")] } },
  "/v1/perps/markets/{id}/candles": { get: { tag: "Perps", summary: "Reference candles (Coinbase, one of the oracle's sources)", params: [path("id", "Market id"), query("range", "5h (1-minute candles), 1d (5-minute), 3d (15-minute), 1w or 12d (hourly), 1m or 75d (6-hourly), 290d (daily)")] } },
  "/v1/perps/markets/{id}/activity": { get: { tag: "Perps", summary: "Opens, closes and liquidations", params: [path("id", "Market id")] } },
  "/v1/perps/positions/{owner}": { get: { tag: "Perps", summary: "Positions of an owner", params: [path("owner", "Owner address")] } },
  "/v1/perps/position/{id}": { get: { tag: "Perps", summary: "One position with its orders", params: [path("id", "Position id")] } },
  "/v1/perps/orders/{owner}": { get: { tag: "Perps", summary: "Conditional orders of an owner", params: [path("owner", "Owner address")] } },
  "/v1/perps/vault/{account}": { get: { tag: "Perps", summary: "Liquidity vault balance of an account", params: [path("account", "Account")] } },
  "/v1/perps/claims": { get: { tag: "Perps", summary: "Shielded perps claims (public parts)" } },
  "/v1/perps/prices": { get: { tag: "Perps", summary: "Latest signed price reports from the keeper" } },
  "/v1/perps/kick": { post: { tag: "Perps", summary: "Ask the keeper to look at pending requests now" } },

  "/v1/auth/nonce": { post: { tag: "Developers", summary: "Start a Sign-In with Ethereum", description: "Returns a nonce valid for 10 minutes. Build an EIP-4361 message with it and sign it in the wallet." } },
  "/v1/auth/verify": {
    post: {
      tag: "Developers",
      summary: "Finish a Sign-In with Ethereum",
      description: "Returns a session token (cvs_...) valid for 7 days. Send it as Authorization: Bearer.",
      body: obj({ message: str("The EIP-4361 message"), signature: str("The wallet's signature") }, ["message", "signature"]),
      response: obj({ token: str(), address: address(), expiresAt: str() }),
    },
  },
  "/v1/auth/session": { get: { tag: "Developers", summary: "Who the credentials belong to", auth: "required" } },
  "/v1/auth/logout": { post: { tag: "Developers", summary: "End the session" } },
  "/v1/keys": {
    get: { tag: "Developers", summary: "Your API keys", auth: "session", response: obj({ keys: arr(ref("ApiKey")) }) },
    post: {
      tag: "Developers",
      summary: "Create an API key",
      description: `Shown once; Curveil stores only its SHA-256 hash. Keys raise the limit from ${LIMITS.public} to ${LIMITS.key} requests a minute. Up to 5 active keys.`,
      auth: "session",
      status: 201,
      body: obj({ label: str() }),
      response: { allOf: [ref("ApiKey"), obj({ key: str("The key, e.g. cvk_test_...") })] },
    },
  },
  "/v1/keys/{id}": { delete: { tag: "Developers", summary: "Revoke an API key", description: "Takes effect within a minute.", auth: "session", params: [path("id", "Key id")] } },

  "/v1/webhooks/events": { get: { tag: "Webhooks", summary: "Event types you can subscribe to" } },
  "/v1/webhooks": {
    get: { tag: "Webhooks", summary: "Your webhooks", auth: "required", response: obj({ webhooks: arr(ref("Webhook")) }) },
    post: {
      tag: "Webhooks",
      summary: "Create a webhook",
      description: "Returns the signing secret once. Only events after creation are delivered.",
      auth: "required",
      status: 201,
      body: ref("WebhookInput"),
      response: obj({ webhook: ref("Webhook"), secret: str("whsec_...") }),
    },
  },
  "/v1/webhooks/{id}": {
    get: { tag: "Webhooks", summary: "One webhook", auth: "required", params: [path("id", "Webhook id")] },
    patch: { tag: "Webhooks", summary: "Change a webhook (url, events, filters, description, active)", auth: "required", params: [path("id", "Webhook id")], body: ref("WebhookInput") },
    delete: { tag: "Webhooks", summary: "Delete a webhook and its delivery log", auth: "required", params: [path("id", "Webhook id")] },
  },
  "/v1/webhooks/{id}/rotate-secret": { post: { tag: "Webhooks", summary: "Replace the signing secret", auth: "required", params: [path("id", "Webhook id")] } },
  "/v1/webhooks/{id}/test": {
    post: {
      tag: "Webhooks",
      summary: "Send a test delivery",
      description: "A sample event marked test: true, signed and delivered like any other.",
      auth: "required",
      status: 202,
      params: [path("id", "Webhook id")],
      body: obj({ type: str("An event type to sample; webhook.test by default") }),
    },
  },
  "/v1/webhooks/{id}/deliveries": {
    get: {
      tag: "Webhooks",
      summary: "Deliveries with every attempt",
      auth: "required",
      params: [path("id", "Webhook id"), query("status", "pending, delivered, failed or dead"), query("before", "Paging cursor from `next`", { type: "integer" }), query("limit", "Up to 100", { type: "integer" })],
      response: obj({ deliveries: arr(ref("Delivery")), next: { type: ["integer", "null"] } }),
    },
  },
  "/v1/webhooks/{id}/replay": {
    post: {
      tag: "Webhooks",
      summary: "Send deliveries again",
      description: "The ones named, or up to 100 dead (or failing) ones. Each gets a fresh 24-hour retry window; body and event id are unchanged.",
      auth: "required",
      params: [path("id", "Webhook id")],
      body: obj({ deliveries: arr(str()), status: str("dead (default) or failed") }),
    },
  },
};

const schemas = {
  Error: obj({ error: str("Machine-readable code"), message: str("What happened, in plain words") }, ["error", "message"]),
  Operator: obj({
    address: address("The operator's FeeSplitter; its address on launches"),
    slug: str(),
    admin: address(),
    pendingAdmin: { anyOf: [address(), { type: "null" }] },
    shareBps: int("Share of the protocol part of curve fees, as set"),
    effectiveShareBps: int("What new launches get: min(shareBps, the protocol cap)"),
    active: bool(),
    suspended: bool("Suspended by the protocol: no new launches"),
    acceptingLaunches: bool(),
    templates: arr(int()),
    brand: obj({ name: str(), tagline: str(), accent: str("#rrggbb"), url: str(), logo: str() }),
    brandURI: { type: ["string", "null"], description: "When the brand is not inline JSON" },
    recipients: arr(obj({ address: address(), weightBps: int() })),
    domain: { type: ["string", "null"], description: "Verified custom domain" },
    launches: int(),
    volumeQuote: { type: "number" },
    createdAt: int("Unix seconds"),
  }),
  Revenue: obj({
    operator: address(),
    launches: int(),
    tokens: arr(
      obj({
        token: address(),
        symbol: str(),
        decimals: int(),
        earned: amount("Uncollected + pending + distributed"),
        uncollected: amount("Still in the curves' operator buckets"),
        pending: amount("Arrived in the splitter, not allocated yet"),
        unpaid: amount("Allocated to recipients, not pulled yet"),
        distributed: amount("Allocated so far"),
        recipients: arr(obj({ address: address(), weightBps: int(), current: bool(), owed: amount(), released: amount() })),
      }),
    ),
    curves: arr(obj({ token: address("The launch token"), curve: address(), quote: address(), uncollected: amount() }), "Launches with operator fees still in the curve"),
    daily: arr(obj({ day: str(), trades: int(), volumeQuote: { type: "number" }, estimatedFees: { type: "number" } })),
    history: arr(obj({ kind: str("collected, distributed or released"), token: str("The fee token"), recipient: str("Who was paid (released only)"), launch: str("The launch the fees came from (collected only)"), amount: amount(), txHash: str(), timestamp: int() })),
  }),
  ApiKey: obj({ id: str(), label: str(), prefix: str(), tier: str(), requestsPerMinute: int(), createdAt: str(), lastUsedAt: { type: ["string", "null"] }, revokedAt: { type: ["string", "null"] } }),
  WebhookInput: obj({
    url: str("Public https URL"),
    events: arr(str(undefined, { enum: [...WEBHOOK_EVENTS, "*"] })),
    filters: obj({ addresses: arr(address("Deliver only events that involve one of these")) }),
    description: str(),
    active: bool(),
  }),
  Webhook: obj({
    id: str(),
    url: str(),
    events: arr(str()),
    filters: { type: ["object", "null"] },
    description: { type: ["string", "null"] },
    secretHint: str(),
    active: bool(),
    createdAt: str(),
    deliveries: obj({ delivered: int(), failing: int(), dead: int() }),
  }),
  WebhookEvent: obj(
    {
      id: str("Stable per chain event; the same on every retry and replay"),
      type: str(undefined, { enum: [...WEBHOOK_EVENTS, "webhook.test"] }),
      network: str(),
      chainId: int(),
      createdAt: str("Block time"),
      block: { type: ["object", "null"], properties: { number: int(), hash: str(), timestamp: int() } },
      transactionHash: { type: ["string", "null"] },
      logIndex: { type: ["integer", "null"] },
      finality: str("sequencer: sent once the sequencer includes the event, before L1 finality"),
      data: { type: "object" },
      test: bool(),
    },
    ["id", "type", "network", "chainId", "createdAt", "data"],
  ),
  Delivery: obj({
    id: str(),
    eventId: str(),
    type: str(),
    status: str(undefined, { enum: ["pending", "delivered", "failed", "dead"] }),
    attempts: int(),
    nextAttemptAt: { type: ["string", "null"] },
    lastStatus: { type: ["integer", "null"] },
    lastError: { type: ["string", "null"] },
    payload: ref("WebhookEvent"),
    history: arr(obj({ attempt: int(), at: str(), status: { type: ["integer", "null"] }, durationMs: int(), error: { type: ["string", "null"] } })),
  }),
};

export function openapiDocument(serverUrl: string, network: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [p, methods] of Object.entries(ROUTES)) {
    paths[p] = {};
    for (const [m, op] of Object.entries(methods)) {
      const security = op.auth === "required" || op.auth === "session" ? [{ bearer: [] }, ...(op.auth === "required" ? [{ apiKey: [] }] : [])] : [{}, { bearer: [] }, { apiKey: [] }];
      paths[p][m] = {
        tags: [op.tag],
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
        operationId: `${m}${p.replace(/^\/v1/, "").replace(/\{(\w+)\}/g, "By_$1").replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ""))}`,
        ...(op.params ? { parameters: op.params } : {}),
        ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: op.body } } } } : {}),
        security,
        ...(op.auth === "session" ? { "x-requires": "A wallet sign-in session; an API key is not enough." } : {}),
        responses: {
          [String(op.status ?? 200)]: { description: "OK", content: { "application/json": { schema: op.response ?? { type: "object" } } } },
          "4XX": { description: "A request problem; the body says what to change.", content: { "application/json": { schema: ref("Error") } } },
          "429": { description: `Over the request limit (${LIMITS.public}/min per IP, ${LIMITS.key}/min per API key).`, content: { "application/json": { schema: ref("Error") } } },
        },
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Curveil API",
      version: "1.0.0",
      description: [
        `Public data and developer tools for Curveil on ${network}. Reads need no credentials.`,
        `Limits: ${LIMITS.public} requests a minute per IP, ${LIMITS.key} with an API key (X-API-Key or Authorization: Bearer).`,
        "Amounts are integer strings in the token's smallest unit unless a field name ends in Quote.",
        "Webhook deliveries are signed: Curveil-Signature: t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<body>'>. The @curveil/sdk verifyWebhook helper checks it.",
      ].join("\n\n"),
    },
    servers: [{ url: serverUrl, description: network }],
    tags: [
      { name: "Status" },
      { name: "Markets" },
      { name: "Launch" },
      { name: "Launchpads", description: "Branded launchpads (operators) on Curveil's launch contracts." },
      { name: "Vault" },
      { name: "Perps" },
      { name: "Developers", description: "Sign-in and API keys." },
      {
        name: "Webhooks",
        description: WEBHOOK_EVENTS.map((e) => `- \`${e}\`: ${WEBHOOK_EVENT_DESCRIPTIONS[e]}`).join("\n") + "\n\nRetries: exponential backoff for 24 hours, then dead-lettered. Dead deliveries can be replayed.",
      },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A session token (cvs_...) from /v1/auth/verify, or an API key (cvk_...)" },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((e) => [
        e,
        {
          post: {
            summary: WEBHOOK_EVENT_DESCRIPTIONS[e],
            parameters: [
              { name: "Curveil-Signature", in: "header", required: true, schema: { type: "string" } },
              { name: "Curveil-Event-Id", in: "header", required: true, schema: { type: "string" } },
              { name: "Curveil-Delivery-Id", in: "header", required: true, schema: { type: "string" } },
              { name: "Curveil-Timestamp", in: "header", required: true, schema: { type: "string" } },
            ],
            requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
            responses: { "2XX": { description: "Delivered. Any other answer, or none within 10 seconds, is retried." } },
          },
        },
      ]),
    ),
  };
}

/** Routes described, as "METHOD /v1/path/:param" (for the coverage test). */
export const describedRoutes = Object.entries(ROUTES).flatMap(([p, ms]) => Object.keys(ms).map((m) => `${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`));

openapi.get("/openapi.json", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(openapiDocument(new URL(c.req.url).origin, c.env.NETWORK));
});
