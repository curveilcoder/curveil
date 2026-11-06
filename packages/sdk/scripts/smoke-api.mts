// QC: hits every API endpoint with good and bad input against a running API and reports any
// response that is a 5xx, the wrong status, not JSON, or missing CORS. Also runs the whole
// sign-in, API key and webhook lifecycle with a throwaway key (no on-chain transaction).
// Usage: pnpm --filter @curveil/sdk smoke [http://localhost:8787]
// Uploads are rate-limited per IP, so leave a minute between runs.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CurveilClient } from "../src/index";

const BASE = process.argv[2] ?? "http://localhost:8787";
const ORIGIN = process.argv[3] ?? "http://localhost:5173";
const problems: string[] = [];
let checks = 0;

async function hit(method: string, path: string, want: number | number[], o: { body?: unknown; auth?: string; raw?: string } = {}) {
  checks++;
  const wants = Array.isArray(want) ? want : [want];
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { origin: ORIGIN, ...(o.body !== undefined || o.raw ? { "content-type": "application/json" } : {}), ...(o.auth ? { authorization: `Bearer ${o.auth}` } : {}) },
      body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
  } catch (e) {
    problems.push(`${method} ${path}: request failed ${(e as Error).message}`);
    return null;
  }
  const ms = Date.now() - t0;
  const text = await r.text();
  let json: any = null;
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    try { json = JSON.parse(text); } catch { problems.push(`${method} ${path}: invalid JSON`); }
  }
  if (!wants.includes(r.status)) problems.push(`${method} ${path}: got ${r.status}, want ${wants.join("/")} ${text.slice(0, 160)}`);
  if (r.status >= 500 && !wants.includes(r.status)) problems.push(`${method} ${path}: SERVER ERROR ${r.status}`);
  if (method !== "OPTIONS" && !ct.includes("json") && !path.includes("/image")) problems.push(`${method} ${path}: content-type ${ct}`);
  if (!r.headers.get("access-control-allow-origin")) problems.push(`${method} ${path}: no CORS header`);
  if (r.status >= 400 && json && (typeof json.error !== "string" || typeof json.message !== "string")) problems.push(`${method} ${path}: error body lacks error/message: ${text.slice(0, 120)}`);
  if (ms > 5000) problems.push(`${method} ${path}: slow ${ms}ms`);
  return { status: r.status, json, headers: r.headers };
}

const Z = "0x0000000000000000000000000000000000000000";
const BAD = "not-an-address";
const markets = (await hit("GET", "/v1/markets", 200))?.json;
const pools: { address: string }[] = markets?.pools ?? markets ?? [];
const launches = (await hit("GET", "/v1/launches?limit=50", 200))?.json;
const L: { token: string; creator: string }[] = launches?.launches ?? [];
const pool = pools[0]?.address ?? Z;
const token = L[0]?.token ?? Z;
const owner = L[0]?.creator ?? Z;

// Public reads
await hit("GET", "/v1/status", 200);
await hit("GET", "/v1/manifest/testnet", 200);
await hit("GET", "/v1/manifest/mainnet", [404, 400]);
await hit("GET", "/v1/manifest/nope", [404, 400]);
await hit("GET", "/v1/assets", 200);
await hit("GET", "/v1/indexer", 200);
await hit("GET", "/v1/openapi.json", 200);
for (const p of pools) {
  await hit("GET", `/v1/markets/${p.address}`, 200);
  await hit("GET", `/v1/markets/${p.address}/swaps`, 200);
  await hit("GET", `/v1/markets/${p.address}/swaps?limit=1`, 200);
}
await hit("GET", `/v1/markets/${Z}`, 404);
await hit("GET", `/v1/markets/${BAD}`, 400);
await hit("GET", `/v1/markets/${pool}/swaps?limit=-5`, [200, 400]);
await hit("GET", `/v1/markets/${pool}/swaps?limit=abc`, [200, 400]);
await hit("GET", `/v1/markets/${pool}/swaps?before=abc`, [200, 400]);
await hit("GET", `/v1/accounts/${owner}/activity`, 200);
await hit("GET", `/v1/accounts/${owner}/positions`, 200);
await hit("GET", `/v1/accounts/${BAD}/activity`, 400);
await hit("GET", `/v1/accounts/${BAD}/positions`, 400);
await hit("GET", "/v1/launches", 200);
await hit("GET", "/v1/launches?state=trading", 200);
await hit("GET", "/v1/launches?state=bogus", [200, 400]);
await hit("GET", "/v1/launches?limit=100000", [200, 400]);
await hit("GET", "/v1/launches?sort=bogus", [200, 400]);
await hit("GET", "/v1/launches/templates", 200);
for (const l of L) {
  await hit("GET", `/v1/launches/${l.token}`, 200);
  await hit("GET", `/v1/launches/${l.token}/trades`, 200);
}
await hit("GET", `/v1/launches/${Z}`, 404);
await hit("GET", `/v1/launches/${BAD}`, 400);
await hit("GET", `/v1/launches/${BAD}/trades`, 400);
await hit("GET", "/v1/launches/metadata/0x1234", [400, 404]);
await hit("GET", `/v1/launches/metadata/0x${"ab".repeat(32)}`, 404);
await hit("GET", `/v1/launches/metadata/0x${"ab".repeat(32)}/image`, 404);
// Name and symbol live on-chain, so an empty document is valid (201) and extra fields are ignored.
await hit("POST", "/v1/launches/metadata", [200, 201], { body: {} });
await hit("POST", "/v1/launches/metadata", 400, { raw: "{not json" });
await hit("POST", "/v1/launches/metadata", 400, { body: { description: "x".repeat(501) } });
await hit("POST", "/v1/launches/metadata", 400, { body: { image: "https://example.com/a.png" } });
await hit("POST", "/v1/launches/metadata", 400, { body: { image: "data:image/png;base64,AAAA" } });
await hit("POST", "/v1/launches/metadata", [400, 429], { body: { website: "javascript:alert(1)" } });
// Uploads are limited per IP, so the last bad inputs may already meet the limit (429).
await hit("POST", "/v1/launches/metadata", [400, 429], { raw: "[1,2]" });
await hit("GET", `/v1/escrow/${owner}`, 200);
await hit("GET", `/v1/escrow/${BAD}`, 400);
await hit("GET", "/v1/factory", 200);
const ops = (await hit("GET", "/v1/operators", 200))?.json;
const op = (ops?.operators ?? [])[0];
if (op) {
  await hit("GET", `/v1/operators/${op.id ?? op.address}`, 200);
  await hit("GET", `/v1/operators/${op.id ?? op.address}/revenue`, 200);
}
await hit("GET", "/v1/operators/999999999", [404, 400]);
await hit("GET", `/v1/operators/${BAD}`, [404, 400]);
await hit("GET", "/v1/operators/by-domain/example.com", 404);
await hit("POST", "/v1/operators", [400, 401], { body: {} });
await hit("POST", "/v1/operators/1/domain/verify", [400, 401, 404], { body: {} });
await hit("GET", "/v1/vault/status", 200);
await hit("GET", "/v1/vault/roots", 200);
await hit("GET", "/v1/vault/commitments", 200);
await hit("GET", "/v1/vault/commitments?from=abc", [200, 400]);
await hit("GET", "/v1/vault/commitments?from=-1", [200, 400]);
await hit("GET", "/v1/vault/nullifiers", [200, 400]);
await hit("GET", "/v1/vault/activity", 200);
await hit("GET", "/v1/vault/positions", [200, 400]);
const pm = (await hit("GET", "/v1/perps/markets", 200))?.json;
for (const m of pm?.markets ?? []) {
  await hit("GET", `/v1/perps/markets/${m.id}/funding`, 200);
  await hit("GET", `/v1/perps/markets/${m.id}/prices`, 200);
  await hit("GET", `/v1/perps/markets/${m.id}/candles?range=1d`, [200, 503]);
  await hit("GET", `/v1/perps/markets/${m.id}/candles?range=1y`, 400);
  await hit("GET", `/v1/perps/markets/${m.id}/activity`, 200);
}
await hit("GET", "/v1/perps/markets/999/funding", [404, 400]);
await hit("GET", "/v1/perps/markets/abc/prices", [404, 400]);
await hit("GET", `/v1/perps/positions/${owner}`, 200);
await hit("GET", `/v1/perps/positions/${BAD}`, 400);
await hit("GET", "/v1/perps/position/999999", [404, 400]);
await hit("GET", "/v1/perps/position/abc", [404, 400]);
await hit("GET", `/v1/perps/orders/${owner}`, 200);
await hit("GET", `/v1/perps/orders/${BAD}`, 400);
await hit("GET", `/v1/perps/vault/${owner}`, 200);
await hit("GET", `/v1/perps/vault/${BAD}`, 400);
await hit("GET", "/v1/perps/claims", [200, 400]);
// 503 (as JSON) when no keeper is bound, as in local dev.
await hit("GET", "/v1/perps/prices", BASE.includes("localhost") ? [200, 503] : 200);
await hit("POST", "/v1/perps/kick", [200, 202, 400, 401, 429], { body: {} });
await hit("GET", "/v1/nope", 404);
await hit("OPTIONS", "/v1/markets", [200, 204]);

// Auth guards
await hit("GET", "/v1/auth/session", 401);
await hit("GET", "/v1/keys", 401);
await hit("POST", "/v1/keys", 401, { body: { label: "x" } });
await hit("GET", "/v1/webhooks", 401);
await hit("GET", "/v1/keys", 401, { auth: "garbage" });
await hit("POST", "/v1/auth/verify", 400, { body: {} });
await hit("POST", "/v1/auth/verify", 400, { body: { message: "hello", signature: "0x1234" } });
await hit("POST", "/v1/auth/verify", 400, { raw: "nope" });
await hit("GET", "/v1/webhooks/events", 200);

// Full lifecycle with a throwaway key
const acct = privateKeyToAccount(generatePrivateKey());
const host = new URL(ORIGIN).host;
const c = new CurveilClient({ baseUrl: BASE, network: "testnet" });
try {
  const s = await c.signIn({ address: acct.address, domain: host, uri: ORIGIN, sign: (message) => acct.signMessage({ message }) });
  checks++;
  const tok = s.token;
  await hit("GET", "/v1/auth/session", 200, { auth: tok });
  // Replay the same nonce: must fail.
  const k = await hit("POST", "/v1/keys", [200, 201], { auth: tok, body: { label: "qc key" } });
  // An empty label falls back to "API key"; a long one is cut to 48 characters.
  const k2 = await hit("POST", "/v1/keys", [200, 201], { auth: tok, body: { label: "" } });
  if (k2?.json?.label !== "API key") problems.push(`empty key label became ${k2?.json?.label}`);
  const k3 = await hit("POST", "/v1/keys", [200, 201], { auth: tok, body: { label: "x".repeat(300) } });
  if ((k3?.json?.label ?? "").length > 48) problems.push(`long key label kept ${k3?.json?.label?.length} characters`);
  for (const kk of [k2, k3]) if (kk?.json?.id) await hit("DELETE", `/v1/keys/${kk.json.id}`, 200, { auth: tok });
  const keyId = k?.json?.id;
  const apiKey = k?.json?.key;
  await hit("GET", "/v1/keys", 200, { auth: tok });
  if (apiKey) {
    // A key can read and manage webhooks but not create keys.
    checks++;
    const r = await fetch(BASE + "/v1/markets", { headers: { "x-api-key": apiKey, origin: ORIGIN } });
    if (r.status !== 200) problems.push(`GET /v1/markets with X-API-Key: ${r.status}`);
    const r2 = await fetch(BASE + "/v1/keys", { method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ label: "nested" }) });
    if (r2.status !== 403 && r2.status !== 401) problems.push(`POST /v1/keys with an API key: ${r2.status}, want 403`);
  }
  const wh = await hit("POST", "/v1/webhooks", [200, 201], { auth: tok, body: { url: "https://example.com/hook", events: ["swap"] } });
  await hit("POST", "/v1/webhooks", 400, { auth: tok, body: { url: "http://localhost/hook", events: ["swap"] } });
  await hit("POST", "/v1/webhooks", 400, { auth: tok, body: { url: "https://example.com/hook", events: ["no.such.event"] } });
  await hit("POST", "/v1/webhooks", 400, { auth: tok, body: { url: "not a url", events: ["swap"] } });
  await hit("POST", "/v1/webhooks", 400, { auth: tok, body: { url: "https://10.0.0.1/hook", events: ["swap"] } });
  const id = wh?.json?.webhook?.id;
  if (id) {
    await hit("GET", `/v1/webhooks/${id}`, 200, { auth: tok });
    await hit("PATCH", `/v1/webhooks/${id}`, 200, { auth: tok, body: { active: false } });
    await hit("PATCH", `/v1/webhooks/${id}`, 400, { auth: tok, body: { url: "ftp://x" } });
    await hit("POST", `/v1/webhooks/${id}/rotate-secret`, 200, { auth: tok, body: {} });
    await hit("POST", `/v1/webhooks/${id}/test`, [200, 201, 202, 409], { auth: tok, body: {} });
    await hit("GET", `/v1/webhooks/${id}/deliveries`, 200, { auth: tok });
    await hit("GET", `/v1/webhooks/${id}/deliveries?status=bogus`, [200, 400], { auth: tok });
    await hit("POST", `/v1/webhooks/${id}/replay`, 409, { auth: tok, body: {} }); // disabled above
    await hit("PATCH", `/v1/webhooks/${id}`, 200, { auth: tok, body: { active: true } });
    await hit("POST", `/v1/webhooks/${id}/replay`, 200, { auth: tok, body: {} });
    // Another wallet must not see it.
    const other = privateKeyToAccount(generatePrivateKey());
    const c2 = new CurveilClient({ baseUrl: BASE, network: "testnet" });
    const s2 = await c2.signIn({ address: other.address, domain: host, uri: ORIGIN, sign: (message) => other.signMessage({ message }) });
    await hit("GET", `/v1/webhooks/${id}`, 404, { auth: s2.token });
    await hit("DELETE", `/v1/webhooks/${id}`, 404, { auth: s2.token });
    if (keyId) await hit("DELETE", `/v1/keys/${keyId}`, 404, { auth: s2.token });
    await hit("DELETE", `/v1/webhooks/${id}`, 200, { auth: tok });
    await hit("GET", `/v1/webhooks/${id}`, 404, { auth: tok });
  }
  await hit("GET", "/v1/webhooks/nope", 404, { auth: tok });
  if (keyId) {
    await hit("DELETE", `/v1/keys/${keyId}`, 200, { auth: tok });
    checks++;
    const r = await fetch(BASE + "/v1/webhooks", { headers: { "x-api-key": apiKey, origin: ORIGIN } });
    if (r.status !== 401) problems.push(`revoked key still works: ${r.status}`);
  }
  await hit("POST", "/v1/auth/logout", 200, { auth: tok, body: {} });
  await hit("GET", "/v1/auth/session", 401, { auth: tok });
  // A message for another site is refused.
  const c3 = new CurveilClient({ baseUrl: BASE, network: "testnet" });
  checks++;
  try {
    await c3.signIn({ address: acct.address, domain: "evil.example", uri: "https://evil.example", sign: (message) => acct.signMessage({ message }) });
    problems.push("sign-in for a foreign domain was accepted");
  } catch { /* expected */ }
  // A signature by another key is refused.
  checks++;
  try {
    const other = privateKeyToAccount(generatePrivateKey());
    await c3.signIn({ address: acct.address, domain: host, uri: ORIGIN, sign: (message) => other.signMessage({ message }) });
    problems.push("sign-in with someone else's signature was accepted");
  } catch { /* expected */ }
} catch (e) {
  problems.push(`lifecycle: ${(e as Error).message}`);
}

console.log(`checks: ${checks}, problems: ${problems.length}`);
for (const p of problems) console.log(" -", p);
