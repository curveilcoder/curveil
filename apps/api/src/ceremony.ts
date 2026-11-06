/**
 * Vault setup ceremony: receives a contribution made in the browser (the site's /ceremony page)
 * and keeps it for the coordinator, who verifies it before it counts. Keys are public data, so
 * nothing here is secret. Uploads are accepted only while the coordinator has opened the round
 * (KV `ceremony:<network>:open`), and only for files shaped like the expected keys.
 */
import { Hono } from "hono";
import type { Env } from "./lib";

export const ceremony = new Hono<{ Bindings: Env }>();

const CIRCUITS = new Set(["transfer", "withdraw"]);
const MAX = 12 * 1024 * 1024;
const MIN = 8 * 1024 * 1024;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

ceremony.post("/ceremony/contributions", async (c) => {
  const open = await c.env.CONFIG.get(`ceremony:${c.env.NETWORK}:open`);
  if (open !== "1") return c.json({ error: "closed", message: "No ceremony round is open." }, 403);
  const circuit = c.req.query("circuit") ?? "";
  const name = (c.req.query("name") ?? "").slice(0, 60);
  if (!CIRCUITS.has(circuit)) return c.json({ error: "bad_input", message: "Unknown circuit." }, 400);
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX) return c.json({ error: "too_large", message: "That file is too large for a key." }, 413);
  if (c.env.UPLOADS) {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const { success } = await c.env.UPLOADS.limit({ key: `ceremony:${ip}` });
    if (!success) return c.json({ error: "rate_limited", message: "Too many uploads. Wait a minute and try again." }, 429);
  }
  const body = await c.req.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(4, body.byteLength)));
  if (body.byteLength < MIN || body.byteLength > MAX || head !== "zkey") return c.json({ error: "bad_input", message: "That is not a key file." }, 400);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
  await c.env.CONFIG.put(`ceremony:${c.env.NETWORK}:upload:${circuit}:${sha256}`, body, {
    expirationTtl: 14 * 24 * 3600,
    metadata: { name, circuit, bytes: body.byteLength, at: new Date().toISOString() },
  });
  return c.json({ ok: true, circuit, sha256 });
});
