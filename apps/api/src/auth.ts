/**
 * Developer accounts: Sign-In with Ethereum (EIP-4361) sessions, API keys and request limits.
 *
 * A session or an API key identifies an address. Sessions come from signing a SIWE message in a
 * wallet and are for people (the developer console, launchpad setup). API keys are for servers:
 * they raise the request limit and can manage webhooks, but can not create or revoke keys.
 * Neither is needed to read public data. Tokens and keys are random, shown once, and stored as
 * SHA-256 hashes only.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { createPublicClient, getAddress, http } from "viem";
import { generateSiweNonce, parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { loadManifest, type Env } from "./lib";

export type Auth = { kind: "session" | "key"; address: string; keyId?: string };
export type Vars = { auth: Auth | null };
export type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

export const auth = new Hono<{ Bindings: Env; Variables: Vars }>();

const SESSION_SECONDS = 7 * 86_400;
const NONCE_SECONDS = 600;
const MAX_KEYS = 5;
export const LIMITS = { public: 300, key: 3000, periodSeconds: 60 } as const;

const enc = new TextEncoder();
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(prefix: string, bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const newId = (prefix: string) => randomToken(prefix, 12);
const nowS = () => Math.floor(Date.now() / 1000);

export const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, error: string, message: string) => c.json({ error, message }, status);

// ------------------------------------------------------------------ resolving the caller

type KeyHit = { id: string; owner: string; at: number };
const keyCache = new Map<string, KeyHit | null>();
const lastUsedWrite = new Map<string, number>();

function credential(c: Context): string | null {
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return c.req.header("x-api-key")?.trim() ?? null;
}

async function resolve(c: AppContext): Promise<Auth | null | "invalid"> {
  const token = credential(c);
  if (!token) return null;
  const hash = await sha256Hex(token);
  if (token.startsWith("cvk_")) {
    let hit = keyCache.get(hash);
    if (hit === undefined || (hit && Date.now() - hit.at > 60_000)) {
      const row = await c.env.DB.prepare("SELECT id, owner FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
        .bind(hash)
        .first<{ id: string; owner: string }>();
      hit = row ? { ...row, at: Date.now() } : null;
      keyCache.set(hash, hit);
    }
    if (!hit) return "invalid";
    // Record use at most every ten minutes per key.
    if (Date.now() - (lastUsedWrite.get(hit.id) ?? 0) > 600_000) {
      lastUsedWrite.set(hit.id, Date.now());
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), hit.id).run().catch(() => undefined),
      );
    }
    return { kind: "key", address: hit.owner, keyId: hit.id };
  }
  if (token.startsWith("cvs_")) {
    const row = await c.env.DB.prepare("SELECT address FROM sessions WHERE token_hash = ? AND expires_ts > ?").bind(hash, nowS()).first<{ address: string }>();
    return row ? { kind: "session", address: row.address } : "invalid";
  }
  return "invalid";
}

/** Who is calling, and the request limit for them. Public reads need no credentials. */
export const identify: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const who = await resolve(c);
  if (who === "invalid") return err(c, 401, "invalid_credentials", "That API key or session is not valid. Sign in again or create a new key.");
  c.set("auth", who);
  const keyed = who?.kind === "key";
  const limiter = keyed ? c.env.KEY_LIMIT : c.env.PUBLIC_LIMIT;
  if (limiter && c.req.method !== "OPTIONS") {
    const subject = keyed ? `key:${who!.keyId}` : `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
    const { success } = await limiter.limit({ key: subject });
    if (!success) {
      c.header("Retry-After", String(LIMITS.periodSeconds));
      return c.json(
        {
          error: "rate_limited",
          message: keyed
            ? `This key is over ${LIMITS.key} requests a minute. Spread requests out or use webhooks instead of polling.`
            : `Over ${LIMITS.public} requests a minute from this address. Use an API key for a higher limit.`,
        },
        429,
      );
    }
  }
  await next();
  c.header("X-RateLimit-Limit", String(keyed ? LIMITS.key : LIMITS.public));
  c.header("X-RateLimit-Tier", keyed ? "developer" : "public");
};

/** Requires a session or a key. With `sessionOnly`, an API key is not enough. */
export function requireAuth(c: AppContext, sessionOnly = false): Auth | Response {
  const a = c.get("auth");
  if (!a) return err(c, 401, "sign_in_required", "Sign in with your wallet, or send an API key, to do this.");
  if (sessionOnly && a.kind !== "session") return err(c, 403, "session_required", "This needs a wallet sign-in; an API key can not do it.");
  return a;
}

// ------------------------------------------------------------------ Sign-In with Ethereum

/** The origins allowed to request sign-ins (the same list as CORS). */
function allowedHosts(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter((s) => s && s !== "*")
      .map((s) => new URL(s).host),
  );
}

auth.post("/auth/nonce", async (c) => {
  const nonce = generateSiweNonce();
  await c.env.DB.prepare("INSERT INTO auth_nonces (nonce, created_ts) VALUES (?, ?)").bind(nonce, nowS()).run();
  const { manifest } = await loadManifest(c.env);
  c.header("Cache-Control", "no-store");
  return c.json({
    nonce,
    chainId: manifest.chainId,
    expiresIn: NONCE_SECONDS,
    statement: "Sign in to Curveil. This proves you control this address. It costs nothing and sends no transaction.",
  });
});

auth.post("/auth/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { message?: string; signature?: string } | null;
  if (!body?.message || !body.signature || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
    return err(c, 400, "bad_request", "Send the signed SIWE message and its signature.");
  }
  if (body.message.length > 2000) return err(c, 400, "bad_request", "That message is too long.");
  const msg = parseSiweMessage(body.message);
  const { manifest } = await loadManifest(c.env);
  if (!msg.address || !msg.nonce || !msg.domain || !msg.uri) return err(c, 400, "bad_message", "That is not a complete Sign-In with Ethereum message.");
  if (!allowedHosts(c.env).has(msg.domain)) return err(c, 400, "bad_domain", `Sign-in requests from ${msg.domain} are not accepted.`);
  if (msg.chainId !== manifest.chainId) return err(c, 400, "wrong_chain", `Sign in on chain ${manifest.chainId}.`);
  if (!msg.issuedAt || Math.abs(Date.now() - msg.issuedAt.getTime()) > NONCE_SECONDS * 1000) {
    return err(c, 400, "stale_message", "That sign-in message is too old. Try again.");
  }
  // Use the nonce up first, so a signature can never be replayed even if verification is slow.
  const used = await c.env.DB.prepare("UPDATE auth_nonces SET used_ts = ? WHERE nonce = ? AND used_ts IS NULL AND created_ts > ?")
    .bind(nowS(), msg.nonce, nowS() - NONCE_SECONDS)
    .run();
  if (!used.meta.changes) return err(c, 400, "bad_nonce", "That sign-in request expired or was already used. Try again.");
  const client = createPublicClient({ transport: http(c.env.RPC_URL) });
  const ok = await verifySiweMessage(client, {
    message: body.message,
    signature: body.signature as `0x${string}`,
    domain: msg.domain,
    nonce: msg.nonce,
  }).catch(() => false);
  if (!ok) return err(c, 401, "bad_signature", "The signature does not match the message and address.");

  const token = randomToken("cvs_");
  const address = getAddress(msg.address);
  const expires = nowS() + SESSION_SECONDS;
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, address, created_at, expires_ts) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), address, new Date().toISOString(), expires)
    .run();
  c.header("Cache-Control", "no-store");
  return c.json({ token, address, expiresAt: new Date(expires * 1000).toISOString() });
});

auth.get("/auth/session", (c) => {
  const a = requireAuth(c);
  if (a instanceof Response) return a;
  c.header("Cache-Control", "no-store");
  return c.json({ address: a.address, kind: a.kind });
});

auth.post("/auth/logout", async (c) => {
  const token = credential(c);
  if (token?.startsWith("cvs_")) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ API keys

type KeyRow = { id: string; label: string; prefix: string; tier: string; created_at: string; last_used_at: string | null; revoked_at: string | null };
const shapeKey = (k: KeyRow) => ({
  id: k.id,
  label: k.label,
  prefix: k.prefix,
  tier: k.tier,
  requestsPerMinute: LIMITS.key,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at,
  revokedAt: k.revoked_at,
});

auth.get("/keys", async (c) => {
  const a = requireAuth(c, true);
  if (a instanceof Response) return a;
  const { results } = await c.env.DB.prepare(
    "SELECT id, label, prefix, tier, created_at, last_used_at, revoked_at FROM api_keys WHERE owner = ? ORDER BY created_at DESC",
  )
    .bind(a.address)
    .all<KeyRow>();
  c.header("Cache-Control", "no-store");
  return c.json({ keys: results.map(shapeKey), limits: LIMITS });
});

auth.post("/keys", async (c) => {
  const a = requireAuth(c, true);
  if (a instanceof Response) return a;
  const body = (await c.req.json().catch(() => ({}))) as { label?: string };
  const label = (body.label ?? "").trim().slice(0, 48) || "API key";
  const active = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner = ? AND revoked_at IS NULL").bind(a.address).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_KEYS) return err(c, 409, "too_many_keys", `You can have ${MAX_KEYS} active keys. Revoke one first.`);
  const key = randomToken(c.env.NETWORK === "mainnet" ? "cvk_live_" : "cvk_test_");
  const id = newId("key_");
  const row: KeyRow = { id, label, prefix: `${key.slice(0, 13)}…`, tier: "developer", created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
  await c.env.DB.prepare("INSERT INTO api_keys (id, owner, label, prefix, key_hash, tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, a.address, label, row.prefix, await sha256Hex(key), row.tier, row.created_at)
    .run();
  c.header("Cache-Control", "no-store");
  return c.json({ key, ...shapeKey(row), notice: "Copy this key now. Curveil stores only a hash of it and can not show it again." }, 201);
});

auth.delete("/keys/:id", async (c) => {
  const a = requireAuth(c, true);
  if (a instanceof Response) return a;
  const r = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), c.req.param("id"), a.address)
    .run();
  if (!r.meta.changes) return err(c, 404, "not_found", "No active key with that id on your account.");
  keyCache.clear();
  return c.json({ ok: true });
});
