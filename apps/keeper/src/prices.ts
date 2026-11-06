/**
 * Test price source: last trade prices from public exchanges, combined into a median. A quote
 * further than `maxSpreadBps` from the median is dropped, and a price needs `minSources`
 * quotes that agree. Prices are USD per whole unit with 18 decimals.
 *
 * Only for the testnet test signer (price source "curveil-test-signer"). With price source
 * "pyth", prices come from Pyth (src/pyth.ts).
 */
import { parseUnits } from "viem";

export type Quote = { source: string; price: bigint };
export type Aggregate = { ok: true; price: bigint; sources: string[]; dropped: string[] } | { ok: false; error: string; sources: string[] };

const UA = { "user-agent": "curveil-keeper/1.0 (+https://curveil.xyz)", accept: "application/json" };
const TIMEOUT_MS = 3_000;

/** Parses a decimal price string ("3456.78") into 18 decimals; null when it is not a positive number. */
export function toWad(s: unknown): bigint | null {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return null;
  const [whole, frac = ""] = str.split(".");
  const v = parseUnits(`${whole}.${frac.slice(0, 18) || "0"}`, 18);
  return v > 0n ? v : null;
}

export function median(values: bigint[]): bigint {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

export function aggregate(quotes: Quote[], minSources: number, maxSpreadBps: number): Aggregate {
  const sources = quotes.map((q) => q.source);
  if (quotes.length < minSources) return { ok: false, error: `only ${quotes.length} of ${minSources} sources answered`, sources };
  const m = median(quotes.map((q) => q.price));
  const near = (p: bigint) => (p > m ? p - m : m - p) * 10_000n <= m * BigInt(maxSpreadBps);
  const kept = quotes.filter((q) => near(q.price));
  const dropped = quotes.filter((q) => !near(q.price)).map((q) => q.source);
  if (kept.length < minSources) return { ok: false, error: `sources disagree by more than ${maxSpreadBps} bps`, sources };
  return { ok: true, price: median(kept.map((q) => q.price)), sources: kept.map((q) => q.source), dropped };
}

type Fetcher = (bases: string[]) => Promise<Record<string, bigint>>;

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

const KRAKEN_PAIR: Record<string, string> = { ETH: "XETHZUSD", BTC: "XXBTZUSD" };

export const SOURCES: Record<string, Fetcher> = {
  coinbase: async (bases) => {
    const out: Record<string, bigint> = {};
    await Promise.all(
      bases.map(async (b) => {
        const j = (await getJson(`https://api.exchange.coinbase.com/products/${b}-USD/ticker`)) as { price?: string };
        const p = toWad(j.price);
        if (p) out[b] = p;
      }),
    );
    return out;
  },
  kraken: async (bases) => {
    const pairs = bases.map((b) => KRAKEN_PAIR[b]).filter(Boolean);
    if (pairs.length === 0) return {};
    const j = (await getJson(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(",")}`)) as {
      error?: string[];
      result?: Record<string, { c?: [string, string] }>;
    };
    const out: Record<string, bigint> = {};
    for (const b of bases) {
      const p = toWad(j.result?.[KRAKEN_PAIR[b] ?? ""]?.c?.[0]);
      if (p) out[b] = p;
    }
    return out;
  },
  bitstamp: async (bases) => {
    const out: Record<string, bigint> = {};
    await Promise.all(
      bases.map(async (b) => {
        const j = (await getJson(`https://www.bitstamp.net/api/v2/ticker/${b.toLowerCase()}usd/`)) as { last?: string };
        const p = toWad(j.last);
        if (p) out[b] = p;
      }),
    );
    return out;
  },
  gemini: async (bases) => {
    const out: Record<string, bigint> = {};
    await Promise.all(
      bases.map(async (b) => {
        const j = (await getJson(`https://api.gemini.com/v1/pubticker/${b.toLowerCase()}usd`)) as { last?: string };
        const p = toWad(j.last);
        if (p) out[b] = p;
      }),
    );
    return out;
  },
};

export type SourceHealth = Record<string, { ok: boolean; error?: string }>;

/** Quotes every base from every source in parallel. A failing source only drops its quotes. */
export async function fetchQuotes(bases: string[], sources: Record<string, Fetcher> = SOURCES): Promise<{ quotes: Record<string, Quote[]>; health: SourceHealth }> {
  const quotes: Record<string, Quote[]> = Object.fromEntries(bases.map((b) => [b, []]));
  const health: SourceHealth = {};
  await Promise.all(
    Object.entries(sources).map(async ([name, f]) => {
      try {
        const got = await f(bases);
        for (const [b, price] of Object.entries(got)) quotes[b]?.push({ source: name, price });
        health[name] = { ok: Object.keys(got).length > 0, ...(Object.keys(got).length ? {} : { error: "no quotes" }) };
      } catch (e) {
        health[name] = { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "failed" };
      }
    }),
  );
  return { quotes, health };
}
