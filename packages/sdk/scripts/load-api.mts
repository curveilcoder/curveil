/**
 * Load test for the public API: a mix of the reads the website makes, at a fixed concurrency,
 * with a hard cap on total requests so a run never eats the plan's daily quota.
 *
 *   pnpm --filter @curveil/sdk load -- --base https://<api host> [--concurrency 20] [--seconds 60] [--max 3000] [--rate <per second>]
 *
 * Reports requests per second, latency percentiles per route and every non-2xx status. Rate
 * limiting (429) is counted separately: it means the limiter works, not that the API failed.
 */
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const base = arg("base", "http://localhost:8787").replace(/\/$/, "");
const concurrency = Number(arg("concurrency", "20"));
const seconds = Number(arg("seconds", "60"));
const max = Number(arg("max", "3000"));
/** Overall requests per second; 0 means as fast as the concurrency allows. */
const rate = Number(arg("rate", "0"));

const ROUTES = [
  { path: "/v1/status", weight: 2 },
  { path: "/v1/markets", weight: 4 },
  { path: "/v1/launches?limit=20", weight: 4 },
  { path: "/v1/vault/status", weight: 2 },
  { path: "/v1/perps/markets", weight: 2 },
  { path: "/v1/operators", weight: 1 },
  { path: "/v1/launches/templates", weight: 1 },
];
const bag = ROUTES.flatMap((r) => Array(r.weight).fill(r.path) as string[]);

type Stat = { ms: number[]; codes: Record<number, number> };
const stats = new Map<string, Stat>();
let sent = 0;
let failed = 0;
const deadline = Date.now() + seconds * 1000;

async function worker() {
  while (Date.now() < deadline && sent < max) {
    const path = bag[Math.floor(Math.random() * bag.length)]!;
    sent++;
    const t = performance.now();
    let code = 0;
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(15_000) });
      await r.arrayBuffer();
      code = r.status;
    } catch {
      failed++;
    }
    const ms = performance.now() - t;
    const s = stats.get(path) ?? { ms: [], codes: {} };
    s.ms.push(ms);
    s.codes[code] = (s.codes[code] ?? 0) + 1;
    stats.set(path, s);
    if (rate > 0) await new Promise((r) => setTimeout(r, Math.max(0, (concurrency / rate) * 1000 - ms)));
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsed = (Date.now() - started) / 1000;
const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

console.log(`${base}: ${sent} requests in ${elapsed.toFixed(1)} s at concurrency ${concurrency} (${(sent / elapsed).toFixed(1)}/s)`);
let errors = 0;
let limited = 0;
for (const [path, s] of [...stats].sort()) {
  const bad = Object.entries(s.codes).filter(([c]) => !(Number(c) >= 200 && Number(c) < 300));
  errors += bad.filter(([c]) => c !== "429").reduce((a, [, n]) => a + n, 0);
  limited += s.codes[429] ?? 0;
  console.log(
    `  ${path.padEnd(26)} n=${String(s.ms.length).padStart(5)}  p50 ${pct(s.ms, 50).toFixed(0).padStart(5)} ms  p95 ${pct(s.ms, 95).toFixed(0).padStart(5)} ms  p99 ${pct(s.ms, 99).toFixed(0).padStart(5)} ms${bad.length ? `  other: ${bad.map(([c, n]) => `${c}×${n}`).join(" ")}` : ""}`,
  );
}
console.log(`errors ${errors} (network ${failed}), rate limited ${limited}`);
if (errors > sent * 0.01) process.exitCode = 1;
