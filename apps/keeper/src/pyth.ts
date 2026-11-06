/**
 * Pyth price source. Price updates come from a Hermes server (free; Pyth's public one by
 * default) and are checked on-chain by Pyth's contract through PythReportVerifier:
 *
 *   report = abi.encode(bytes32 feedId, bytes[] updateData)
 *
 * feedId is Curveil's (keccak256("ETH/USD")); updateData is Hermes's binary update.
 *
 * - latest(): the newest update, for liquidations, take-profit and stop-loss fills and price
 *   records.
 * - firstAfter(): the first update published at or after a time, for filling a request. The
 *   contract accepts only that one (PerpEngine fills at the first price after the request), so
 *   any keeper fetching it gets the same price.
 */
import { encodeAbiParameters, type Hex } from "viem";

export const PUBLIC_HERMES = "https://hermes.pyth.network";
const TIMEOUT_MS = 4_000;

export type PythFeed = { feedId: Hex; pythId: Hex };
export type PythPrice = {
  feedId: Hex;
  pythId: Hex;
  /** USD per unit, 18 decimals. */
  priceWad: bigint;
  /** Confidence interval, 18 decimals. */
  confWad: bigint;
  publishTime: number;
  prevPublishTime: number | null;
  /** Ready to pass to the contracts. */
  report: Hex;
};

type HermesPrice = { price: string; conf: string; expo: number; publish_time: number };
type HermesResponse = {
  binary: { encoding: string; data: string[] };
  parsed?: { id: string; price: HermesPrice; metadata?: { prev_publish_time?: number } }[];
};

export class HermesError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

const strip = (id: string) => id.toLowerCase().replace(/^0x/, "");

/** Pyth's `price × 10^expo` as an 18-decimal value; null when it is not a usable price. */
export function pythToWad(value: string, expo: number): bigint | null {
  if (!/^\d+$/.test(value) || !Number.isInteger(expo) || expo > 0 || expo < -36) return null;
  const v = BigInt(value);
  const shift = 18 + expo;
  return shift >= 0 ? v * 10n ** BigInt(shift) : v / 10n ** BigInt(-shift);
}

export function encodeReport(feedId: Hex, updateData: Hex[]): Hex {
  return encodeAbiParameters([{ type: "bytes32" }, { type: "bytes[]" }], [feedId, updateData]);
}

export function hermesUrl(base: string | undefined, path: string, ids: Hex[]): string {
  const q = [...ids.map((id) => `ids[]=${strip(id)}`), "encoding=hex", "parsed=true"].join("&");
  // A provider URL may already carry a query (an API key): keep it.
  const [origin = "", query] = (base || PUBLIC_HERMES).split("?");
  return `${origin.replace(/\/+$/, "")}${path}?${q}${query ? `&${query}` : ""}`;
}

/** Turns a Hermes answer into one price per requested feed. Feeds Hermes left out are absent. */
export function parseHermes(body: HermesResponse, feeds: PythFeed[]): PythPrice[] {
  if (body?.binary?.encoding !== "hex" || !Array.isArray(body.binary.data) || body.binary.data.length === 0) {
    throw new HermesError("Hermes sent no update data", null);
  }
  const updateData = body.binary.data.map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex);
  const out: PythPrice[] = [];
  for (const f of feeds) {
    const p = body.parsed?.find((x) => strip(x.id) === strip(f.pythId));
    if (!p) continue;
    const priceWad = pythToWad(p.price.price, p.price.expo);
    const confWad = pythToWad(p.price.conf, p.price.expo);
    if (priceWad === null || priceWad === 0n || confWad === null) continue;
    out.push({
      feedId: f.feedId,
      pythId: f.pythId,
      priceWad,
      confWad,
      publishTime: p.price.publish_time,
      prevPublishTime: p.metadata?.prev_publish_time ?? null,
      report: encodeReport(f.feedId, updateData),
    });
  }
  return out;
}

type Fetch = typeof fetch;

/** Where Hermes is, and the Pyth API key it needs (Hermes requires one since Aug 26, 2026). */
export type Hermes = { url?: string; key?: string };
/** A bare string is the server URL with no key. */
type HermesArg = string | Hermes | undefined;
const hermesOf = (h: HermesArg): Hermes => (typeof h === "string" || h === undefined ? { url: h } : h);

export function hermesHeaders(key: string | undefined): Record<string, string> {
  return key ? { accept: "application/json", authorization: `Bearer ${key}` } : { accept: "application/json" };
}

async function get(url: string, key: string | undefined, fetcher: Fetch): Promise<HermesResponse> {
  const r = await fetcher(url, { headers: hermesHeaders(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    // Keep Hermes' own reason (for example a feed the API key's plan does not cover), trimmed.
    const why = (await r.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
    throw new HermesError(`Hermes answered ${r.status}${why ? `: ${why}` : ""}`, r.status);
  }
  return (await r.json()) as HermesResponse;
}

/** The newest update for every feed, in one request. */
export async function latest(hermes: HermesArg, feeds: PythFeed[], fetcher: Fetch = fetch): Promise<PythPrice[]> {
  if (feeds.length === 0) return [];
  const h = hermesOf(hermes);
  return parseHermes(await get(hermesUrl(h.url, "/v2/updates/price/latest", feeds.map((f) => f.pythId)), h.key, fetcher), feeds);
}

/**
 * The newest update for every feed, and why any feed has none. One request when it can; when Hermes
 * refuses the batch (403, for example a feed the API key's plan does not cover), each feed is asked
 * for on its own so one refused feed does not stop the others.
 */
export async function latestEach(hermes: HermesArg, feeds: PythFeed[], fetcher: Fetch = fetch): Promise<{ prices: PythPrice[]; errors: Map<string, string> }> {
  const errors = new Map<string, string>();
  try {
    return { prices: await latest(hermes, feeds, fetcher), errors };
  } catch (e) {
    if (!(e instanceof HermesError) || e.status !== 403 || feeds.length < 2) throw e;
  }
  const settled = await Promise.allSettled(feeds.map((f) => latest(hermes, [f], fetcher)));
  const prices: PythPrice[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") prices.push(...r.value);
    else errors.set(feeds[i]!.feedId.toLowerCase(), r.reason instanceof Error ? r.reason.message : "failed");
  });
  return { prices, errors };
}

/**
 * The first update for `feed` published at or after `time` (seconds). Null while Hermes does
 * not have one yet (the request was made less than a second or two ago).
 */
export async function firstAfter(hermes: HermesArg, feed: PythFeed, time: number, fetcher: Fetch = fetch): Promise<PythPrice | null> {
  const h = hermesOf(hermes);
  try {
    const [p] = parseHermes(await get(hermesUrl(h.url, `/v2/updates/price/${time}`, [feed.pythId]), h.key, fetcher), [feed]);
    return p && p.publishTime >= time ? p : null;
  } catch (e) {
    if (e instanceof HermesError && e.status === 404) return null;
    throw e;
  }
}
