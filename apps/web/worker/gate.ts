/**
 * Site lock for curveil.xyz. While SITE_LOCK is "on", everyone sees a locked page and
 * only browsers holding the team cookie reach the app. The cookie comes from /unlock with
 * the private key in SITE_KEY (a Worker secret), as a link: /unlock?key=…. There is no form. Testnet has no SITE_LOCK, so it stays open.
 */
import geist from "../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
import favicon from "../public/favicon.svg";
import geistMono from "../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2";

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  SITE_LOCK?: string;
  SITE_KEY?: string;
}

const COOKIE = "curveil_access";
const MAX_AGE = 60 * 60 * 24 * 60; // 60 days

async function tokenFor(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`curveil-site-lock:${key}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function cookieOf(req: Request): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return "";
}

const SEC = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex",
  "cache-control": "no-store",
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (env.SITE_LOCK !== "on" || !env.SITE_KEY) return env.ASSETS.fetch(req);
    const url = new URL(req.url);
    const want = await tokenFor(env.SITE_KEY);

    if (url.pathname === "/__lock/geist.woff2" || url.pathname === "/__lock/geist-mono.woff2") {
      return new Response(url.pathname.includes("mono") ? geistMono : geist, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=604800" } });
    }
    if (url.pathname === "/unlock") {
      const key = url.searchParams.get("key") ?? "";
      if (key && same(await tokenFor(key), want)) {
        return new Response(null, {
          status: 303,
          headers: { location: "/", "set-cookie": `${COOKIE}=${want}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" },
        });
      }
      return lockPage(401);
    }
    if (url.pathname === "/lock") {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, "cache-control": "no-store" } });
    }
    if (same(cookieOf(req), want)) return env.ASSETS.fetch(req);
    if (url.pathname === "/favicon.svg") return env.ASSETS.fetch(req);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    return lockPage(200);
  },
};

const LOGO = favicon.replace(/<svg /, '<svg aria-hidden="true" ').replace(/fill="#EEF2FA"/g, 'fill="currentColor"');
const LOCK = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

function lockPage(status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Curveil · Opening soon</title>
<meta name="description" content="Open markets. Private participation. Curveil on Robinhood Chain is opening soon.">
<meta property="og:title" content="Curveil · Opening soon">
<meta property="og:description" content="Open markets. Private participation.">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#000000">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
@font-face { font-family: "Geist"; src: url("/__lock/geist.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("/__lock/geist-mono.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
:root { --blue: #2563ff; --ink: #eef2fa; --muted: #8c96ad; --line: rgba(255,255,255,.1); color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: #000; color: var(--ink); font-family: "Geist", system-ui, -apple-system, "Segoe UI", sans-serif; }
body { min-height: 100svh; display: grid; grid-template-rows: auto 1fr auto; overflow-x: hidden; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background-image: radial-gradient(rgba(37,99,255,.55) 1px, transparent 1.4px); background-size: 9px 9px;
  -webkit-mask-image: radial-gradient(ellipse 60% 45% at 50% 108%, #000 10%, transparent 70%); mask-image: radial-gradient(ellipse 60% 45% at 50% 108%, #000 10%, transparent 70%); }
header, main, footer { position: relative; width: min(1120px, 100%); margin: 0 auto; padding-inline: 20px; }
header { display: flex; align-items: center; gap: 10px; padding-block: 24px; font-weight: 600; letter-spacing: .14em; font-size: 15px; }
header svg { width: 28px; height: 28px; color: var(--ink); }
main { display: grid; align-content: center; justify-items: center; text-align: center; gap: 22px; padding-block: 40px 80px; }
.badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid rgba(37,99,255,.55); border-radius: 999px; background: rgba(37,99,255,.12);
  font: 500 12px/1 "Geist Mono", ui-monospace, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; color: #c7d5ff; }
.badge svg { width: 14px; height: 14px; }
h1 { margin: 0; font-size: clamp(44px, 9vw, 96px); font-weight: 500; letter-spacing: -.045em; line-height: .98; }
h1 span { color: var(--blue); }
.lead { margin: 0; color: var(--muted); font-size: clamp(16px, 2.2vw, 19px); }
.url { font: 500 13px/1 "Geist Mono", ui-monospace, Menlo, monospace; letter-spacing: .08em; color: var(--muted); }
footer { padding-block: 24px; color: rgba(140,150,173,.7); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<header>${LOGO}<span>CURVEIL</span></header>
<main>
  <span class="badge">${LOCK} Locked for public</span>
  <h1>Opening <span>soon.</span></h1>
  <p class="lead">Open markets. Private participation.</p>
  <span class="url">curveil.xyz</span>
</main>
<footer>Robinhood Chain</footer>
</body>
</html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...SEC } });
}
