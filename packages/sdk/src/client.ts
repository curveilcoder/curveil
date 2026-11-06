/**
 * Curveil API client. Thin and typed where it matters: every method is a documented endpoint
 * (see /v1/openapi.json), errors throw CurveilApiError with the API's code and message, and
 * nothing is cached. Works anywhere fetch does.
 */

export const API_URLS = {
  testnet: "https://curveil-api-testnet.zeronym.workers.dev",
  mainnet: "https://api.curveil.xyz",
} as const;

export type Network = "testnet" | "mainnet";

export type ClientOptions = {
  /** Defaults to the testnet API. Mainnet needs an explicit URL until it launches. */
  baseUrl?: string;
  network?: Network;
  /** cvk_... from the developer console. Raises the request limit. Keep it server-side. */
  apiKey?: string;
  /** cvs_... from a wallet sign-in (signIn below). */
  sessionToken?: string;
  fetch?: typeof fetch;
};

export class CurveilApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "CurveilApiError";
  }
}

export type Brand = { name?: string; tagline?: string; accent?: string; url?: string; logo?: string };

export type Operator = {
  address: `0x${string}`;
  slug: string;
  admin: `0x${string}`;
  pendingAdmin: `0x${string}` | null;
  shareBps: number;
  effectiveShareBps: number;
  active: boolean;
  suspended: boolean;
  acceptingLaunches: boolean;
  templates: number[];
  brand: Brand | null;
  brandURI: string | null;
  recipients: { address: `0x${string}`; weightBps: number }[];
  domain: string | null;
  description: string | null;
  contact: string | null;
  launches: number;
  volumeQuote: number;
  createdAt: number;
  createdBlock: number;
  createdTx: string;
};

export type Revenue = {
  operator: `0x${string}`;
  slug: string;
  launches: number;
  tokens: {
    token: `0x${string}`;
    symbol: string;
    decimals: number;
    earned: string;
    uncollected: string;
    pending: string;
    unpaid: string;
    distributed: string;
    recipients: { address: `0x${string}`; weightBps: number; current: boolean; owed: string; released: string }[];
  }[];
  curves: { token: `0x${string}`; curve: `0x${string}`; quote: `0x${string}`; uncollected: string }[];
  daily: { day: string; trades: number; volumeQuote: number; estimatedFees: number }[];
  history: { kind: "collected" | "distributed" | "released"; token: string | null; recipient: string | null; launch: string | null; amount: string; txHash: string; block: number; timestamp: number }[];
};

export type Launch = {
  token: `0x${string}`;
  curve: `0x${string}`;
  name: string;
  symbol: string;
  metadataUri: string;
  image: string | null;
  creator: `0x${string}`;
  operator: `0x${string}` | null;
  operatorShareBps: number | null;
  templateId: number;
  templateLabel: string | null;
  quote: { address: `0x${string}`; symbol: string; decimals: number } | null;
  state: "created" | "trading" | "graduation_ready" | "graduated";
  progressBps: number;
  reserveQuote: number;
  price: number | null;
  marketCap: number | null;
  pool: `0x${string}` | null;
  volume24hQuote: number;
  trades24h: number;
  trades: number;
  lastTradeAt: number | null;
  createdAt: number;
};

export type Template = {
  id: number;
  label: string;
  enabled: boolean;
  quote: { address: `0x${string}`; symbol: string; decimals: number };
  feeBps: number;
  creatorFeeShareBps: number;
  graduationThreshold: string;
  graduationThresholdQuote: number;
  startMarketCap: number;
  migrationMarketCap: number;
  [k: string]: unknown;
};

export type Webhook = {
  id: string;
  url: string;
  events: string[];
  filters: { addresses: string[] } | null;
  description: string | null;
  secretHint: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deliveries?: { delivered: number; failing: number; dead: number };
};

export type Delivery = {
  id: string;
  eventId: string;
  type: string;
  status: "pending" | "delivered" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
  payload: unknown;
  history: { attempt: number; at: string; status: number | null; durationMs: number; error: string | null }[];
};

export type ApiKey = { id: string; label: string; prefix: string; tier: string; requestsPerMinute: number; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

type Query = Record<string, string | number | undefined | null>;

export class CurveilClient {
  readonly baseUrl: string;
  readonly network: Network;
  private apiKey?: string;
  private sessionToken?: string;
  private doFetch: typeof fetch;

  constructor(o: ClientOptions = {}) {
    this.network = o.network ?? "testnet";
    const url = o.baseUrl ?? API_URLS[this.network];
    this.baseUrl = url.replace(/\/$/, "");
    this.apiKey = o.apiKey;
    this.sessionToken = o.sessionToken;
    this.doFetch = o.fetch ?? ((...a) => fetch(...a));
  }

  /** Use a session token from now on (after signIn), or clear it with null. */
  setSession(token: string | null) {
    this.sessionToken = token ?? undefined;
  }

  async request<T>(method: string, path: string, o: { query?: Query; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    const credential = this.sessionToken ?? this.apiKey;
    if (credential) headers.authorization = `Bearer ${credential}`;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await this.doFetch(url.toString(), { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new CurveilApiError(r.status, json?.error ?? "http_error", json?.message ?? `The Curveil API answered ${r.status}`);
    return json as T;
  }

  private get = <T>(path: string, query?: Query) => this.request<T>("GET", path, { query });

  // Status and contracts
  status = () => this.get<Record<string, unknown>>("/v1/status");
  manifest = () => this.get<{ chainId: number; version: string; contracts: Record<string, { address: `0x${string}`; deployBlock: number; verified: boolean }>; assets: { symbol: string; label: string; address: `0x${string}`; decimals: number }[] }>(`/v1/manifest/${this.network}`);
  openapi = () => this.get<Record<string, unknown>>("/v1/openapi.json");

  // Markets
  pools = () => this.get<{ pools: Record<string, unknown>[] }>("/v1/markets");
  pool = (address: string) => this.get<Record<string, unknown>>(`/v1/markets/${address}`);
  swaps = (pool: string, limit?: number) => this.get<{ swaps: Record<string, unknown>[] }>(`/v1/markets/${pool}/swaps`, { limit });

  // Launches
  launches = (q: { operator?: string; creator?: string; state?: Launch["state"]; sort?: "new" | "volume" | "progress" | "active"; limit?: number } = {}) =>
    this.get<{ launches: Launch[] }>("/v1/launches", q);
  launch = (token: string) => this.get<{ launch: Launch & { fees: { creator: string; operator: string; protocol: string } }; template: Template | null; metadata: unknown }>(`/v1/launches/${token}`);
  templates = () => this.get<{ templates: Template[] }>("/v1/launches/templates");
  trades = (token: string) => this.get<{ trades: Record<string, unknown>[] }>(`/v1/launches/${token}/trades`);

  // Launchpads
  factory = () => this.get<{ registry: `0x${string}` | null; launchFactory: `0x${string}` | null; maxShareBps?: number; operatorCount?: number }>("/v1/factory");
  operators = (q: { admin?: string; limit?: number } = {}) => this.get<{ maxShareBps: number; operators: Operator[] }>("/v1/operators", q);
  operator = (idOrSlug: string) => this.get<{ operator: Operator; maxShareBps: number; domainSetup: { domain: string; verified: boolean; record: { type: string; name: string; value: string } } | null }>(`/v1/operators/${idOrSlug}`);
  operatorByDomain = (domain: string) => this.get<{ operator: Operator }>(`/v1/operators/by-domain/${domain}`);
  revenue = (idOrSlug: string) => this.get<Revenue>(`/v1/operators/${idOrSlug}/revenue`);
  setOperatorProfile = (body: { operator: string; domain?: string | null; description?: string; contact?: string }) => this.request<Record<string, unknown>>("POST", "/v1/operators", { body });
  verifyDomain = (operator: string) => this.request<{ verified: boolean }>("POST", `/v1/operators/${operator}/domain/verify`, { body: {} });

  // Sign-in (EIP-4361). `sign` is the wallet's personal_sign, e.g. viem's walletClient.signMessage.
  async signIn(o: { address: `0x${string}`; domain: string; uri: string; sign: (message: string) => Promise<`0x${string}`> }) {
    const { nonce, chainId, statement } = await this.request<{ nonce: string; chainId: number; statement: string }>("POST", "/v1/auth/nonce", { body: {} });
    const message = siweMessage({ ...o, nonce, chainId, statement, issuedAt: new Date() });
    const signature = await o.sign(message);
    const s = await this.request<{ token: string; address: `0x${string}`; expiresAt: string }>("POST", "/v1/auth/verify", { body: { message, signature } });
    this.sessionToken = s.token;
    return s;
  }
  session = () => this.get<{ address: `0x${string}`; kind: "session" | "key" }>("/v1/auth/session");
  signOut = async () => {
    await this.request("POST", "/v1/auth/logout", { body: {} });
    this.sessionToken = undefined;
  };

  // API keys (need a wallet session)
  keys = () => this.get<{ keys: ApiKey[] }>("/v1/keys");
  createKey = (label: string) => this.request<ApiKey & { key: string }>("POST", "/v1/keys", { body: { label } });
  revokeKey = (id: string) => this.request<{ ok: true }>("DELETE", `/v1/keys/${id}`);

  // Webhooks
  webhookEvents = () => this.get<{ events: { type: string; description: string }[] }>("/v1/webhooks/events");
  webhooks = () => this.get<{ webhooks: Webhook[] }>("/v1/webhooks");
  createWebhook = (body: { url: string; events: string[]; filters?: { addresses: string[] }; description?: string }) =>
    this.request<{ webhook: Webhook; secret: string }>("POST", "/v1/webhooks", { body });
  updateWebhook = (id: string, body: Partial<{ url: string; events: string[]; filters: { addresses: string[] } | null; description: string; active: boolean }>) =>
    this.request<{ webhook: Webhook }>("PATCH", `/v1/webhooks/${id}`, { body });
  deleteWebhook = (id: string) => this.request<{ ok: true }>("DELETE", `/v1/webhooks/${id}`);
  rotateWebhookSecret = (id: string) => this.request<{ secret: string }>("POST", `/v1/webhooks/${id}/rotate-secret`, { body: {} });
  testWebhook = (id: string, type?: string) => this.request<{ delivery: string }>("POST", `/v1/webhooks/${id}/test`, { body: { type } });
  deliveries = (id: string, q: { status?: Delivery["status"]; before?: number; limit?: number } = {}) => this.get<{ deliveries: Delivery[]; next: number | null }>(`/v1/webhooks/${id}/deliveries`, q);
  replay = (id: string, body: { deliveries?: string[]; status?: "dead" | "failed" } = {}) => this.request<{ replayed: number }>("POST", `/v1/webhooks/${id}/replay`, { body });
}

export function createClient(o: ClientOptions = {}) {
  return new CurveilClient(o);
}

/** An EIP-4361 message. */
export function siweMessage(o: { domain: string; address: string; uri: string; nonce: string; chainId: number; statement?: string; issuedAt: Date }): string {
  return [
    `${o.domain} wants you to sign in with your Ethereum account:`,
    o.address,
    "",
    ...(o.statement ? [o.statement, ""] : []),
    `URI: ${o.uri}`,
    "Version: 1",
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${o.issuedAt.toISOString()}`,
  ].join("\n");
}
