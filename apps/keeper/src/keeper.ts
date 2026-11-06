/**
 * Keeper: one Durable Object per network runs an alarm loop that
 *  - reads pending requests, open positions, active orders and market state from the chain;
 *  - prices each market: Pyth updates from Hermes (price source "pyth"), or, for the testnet
 *    test signer, a median of public exchange quotes signed as a report;
 *  - liquidates unhealthy positions, executes requests, cancels timed-out ones, fills triggered
 *    take-profit and stop-loss orders, clears dead orders;
 *  - records a price for markets with open interest every ~10 minutes, so the liquidity vault's
 *    NAV stays fresh, and accrues funding hourly.
 * Each action is simulated first and sent only if it would succeed. Every call it makes is
 * public: anyone running this code (or their own) with any funded wallet can do the same.
 */
import { DurableObject } from "cloudflare:workers";
import { parseManifest, type Manifest } from "@curveil/manifest";
import bundledTestnet from "@curveil/manifest/manifests/testnet.json";
import engineAbiJson from "@curveil/manifest/abis/PerpEngine.json";
import ordersAbiJson from "@curveil/manifest/abis/OrderManager.json";
import oracleAbiJson from "@curveil/manifest/abis/OracleAdapter.json";
import lensAbiJson from "@curveil/manifest/abis/PerpLens.json";
import verifierAbiJson from "@curveil/manifest/abis/SignedReportVerifier.json";
import pythVerifierAbiJson from "@curveil/manifest/abis/PythReportVerifier.json";
import {
  decodeAbiParameters,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MULTICALL3, multicallAbi, multicallSettled, rpc, rpcBatch, rpcBatchSettled, type Call } from "./rpc";
import { aggregate, fetchQuotes, type SourceHealth } from "./prices";
import { signReport } from "./reports";
import { firstAfter, latestEach as pythLatest, type PythFeed, type PythPrice } from "./pyth";
import { DEFAULT_PLAN, plan, type Action, type MarketView, type OrderView, type PositionView, type RequestView, type SignedPrice } from "./plan";
import type { Env } from "./env";
import { deliver, evaluate, message, plan as planAlerts, queuedAlert, type Alert, type SentLog } from "./alerts";

/** Errors Pyth's own contract raises, so skipped actions name them. */
const PYTH_ERRORS = [
  { type: "error", name: "PriceFeedNotFoundWithinRange", inputs: [] },
  { type: "error", name: "PriceFeedNotFound", inputs: [] },
  { type: "error", name: "InsufficientFee", inputs: [] },
  { type: "error", name: "InvalidUpdateData", inputs: [] },
] as const;

const engineAbi = engineAbiJson as Abi;
const ordersAbi = ordersAbiJson as Abi;
const oracleAbi = oracleAbiJson as Abi;
const lensAbi = lensAbiJson as Abi;
const errorsAbi = [...engineAbi, ...ordersAbi, ...oracleAbi, ...(verifierAbiJson as Abi), ...(pythVerifierAbiJson as Abi), ...PYTH_ERRORS].filter((x) => x.type === "error") as Abi;

/** Durable Object name. Bump to replace a running object outright after a deploy. */
export const KEEPER_GENERATION = 1;
export const keeperName = (env: Pick<Env, "NETWORK">) => `keeper-${env.NETWORK}-g${KEEPER_GENERATION}`;
export const keeperStub = (env: Env) => env.KEEPER.get(env.KEEPER.idFromName(keeperName(env)));
const KEEPER_CODE = "perps-2";

const ACTIVE_MS = 3_000; // requests waiting
const WATCH_MS = 5_000; // open positions or orders to watch
const IDLE_MS = 20_000;
const ERROR_MS = 10_000;
const STALE_ALARM_MS = 15_000; // an alarm this overdue is stuck
const PRICE_TTL_MS = 2_000;
const IDLE_PRICE_EVERY_MS = 60_000;
const ALERT_EVERY_MS = 60_000;
const CALL_SCHEDULED = "0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca"; // CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)
const LOG_RANGE = 10_000n;
const INFLIGHT_MS = 20_000;
const PAGE = 200;
const MAX_SENDS = 6;

export type MarketPrice = {
  market: number;
  symbol: string;
  base: string;
  feed: string;
  feedId: Hex;
  price: string | null;
  priceWad: string | null;
  timestamp: number | null;
  sources: string[];
  dropped?: string[];
  error?: string;
};

export type SignedReport = MarketPrice & { report: Hex | null };

export type KeeperStatus = {
  code: string;
  network: string;
  keeper: Address;
  signer: Address | null;
  priceSource: string | null;
  signing: boolean;
  startedAt: number;
  ticks: number;
  lastTickAt: number | null;
  lastTickMs: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveErrors: number;
  gasBalanceWei: string | null;
  gasLow: boolean;
  watching: { pending: number; open: number; orders: number };
  prices: MarketPrice[];
  sources: SourceHealth;
  sent: Record<string, number>;
  recent: { kind: string; key: string; hash: Hex; at: number }[];
  skipped: { key: string; reason: string; at: number }[];
  alarmAt: number | null;
};

type PositionInfo = { market: number; isLong: boolean; owner: Address };
type RequestInfo = { positionId: bigint; createdAt: number; kind: number };
type OrderInfo = { positionId: bigint; owner: Address; kind: number; createdAt: number; expiresAt: number; triggerPrice: bigint; acceptablePrice: bigint };

const call = (target: string, abi: Abi, functionName: string, args: unknown[] = []): Call => ({
  target,
  data: encodeFunctionData({ abi, functionName, args } as never),
});
const decode = <T>(abi: Abi, functionName: string, data: Hex): T => decodeFunctionResult({ abi, functionName, data } as never) as T;

function errorName(data: Hex | null, message: string): string {
  if (data && data.length >= 10) {
    try {
      const e = decodeErrorResult({ abi: errorsAbi, data });
      return e.args && e.args.length ? `${e.errorName}(${e.args.map(String).join(",")})` : e.errorName;
    } catch {
      /* not one of ours */
    }
  }
  return message.slice(0, 120);
}

type TickRecord = Pick<KeeperStatus, "ticks" | "lastTickAt" | "lastTickMs" | "lastError" | "lastErrorAt" | "consecutiveErrors" | "skipped">;

export class Keeper extends DurableObject<Env> {
  private manifest: { m: Manifest; at: number } | null = null;
  private positions = new Map<bigint, PositionInfo>();
  private requests = new Map<bigint, RequestInfo>();
  private orders = new Map<bigint, OrderInfo>();
  private inflight = new Map<string, number>();
  private priceCache: { at: number; prices: MarketPrice[]; sources: SourceHealth } | null = null;
  /** Latest Pyth update per market (price source "pyth"). */
  private pythCache = new Map<number, PythPrice>();
  private marketViews: MarketView[] = [];
  private alertedAt = 0;
  private status: Omit<KeeperStatus, "alarmAt" | "keeper" | "signer" | "signing" | "priceSource" | "network" | "code"> = {
    startedAt: Date.now(),
    ticks: 0,
    lastTickAt: null,
    lastTickMs: null,
    lastError: null,
    lastErrorAt: null,
    consecutiveErrors: 0,
    gasBalanceWei: null,
    gasLow: false,
    watching: { pending: 0, open: 0, orders: 0 },
    prices: [],
    sources: {},
    sent: {},
    recent: [],
    skipped: [],
  };

  private current(): boolean {
    return this.ctx.id.equals(this.env.KEEPER.idFromName(keeperName(this.env)));
  }

  private get account() {
    return privateKeyToAccount(this.env.KEEPER_KEY as Hex);
  }

  private get signer() {
    return this.env.PRICE_SIGNER_KEY ? privateKeyToAccount(this.env.PRICE_SIGNER_KEY as Hex) : null;
  }

  private async loadManifest(): Promise<Manifest> {
    if (this.manifest && Date.now() - this.manifest.at < 300_000) return this.manifest.m;
    const raw = await this.env.CONFIG.get(`manifest:${this.env.NETWORK}`, "json");
    const kv = raw ? parseManifest(raw) : null;
    const bundled = this.env.NETWORK === "testnet" ? parseManifest(bundledTestnet) : null;
    const build = (m: Manifest | null) => (m ? Number(m.version.split(".").pop()) || 0 : -1);
    const m = build(bundled) > build(kv) ? bundled : kv;
    if (!m) throw new Error(`No manifest for ${this.env.NETWORK}`);
    this.manifest = { m, at: Date.now() };
    return m;
  }

  /** Pyth feeds for the manifest's markets (price source "pyth"). */
  private pythFeeds(m: Manifest): (PythFeed & { market: number })[] {
    return (m.perps?.markets ?? []).flatMap((x) => (x.pythId ? [{ market: x.id, feedId: x.feedId as Hex, pythId: x.pythId as Hex }] : []));
  }

  /**
   * Why the keeper cannot price markets, or null when it can: price source "pyth" needs Pyth's
   * contract and a Pyth id per market; the test signer needs the key the verifier expects.
   */
  private signingProblem(m: Manifest): string | null {
    if (!m.perps) return "perps are not deployed on this network";
    if (m.perps.priceSource === "pyth") {
      if (!m.perps.pyth) return "the manifest has no Pyth contract";
      const missing = m.perps.markets.filter((x) => !x.pythId).map((x) => x.symbol);
      return missing.length ? `no Pyth price id for ${missing.join(", ")}` : null;
    }
    if (m.perps.priceSource !== "curveil-test-signer") return `price source ${m.perps.priceSource} is not supported by this keeper`;
    const s = this.signer;
    if (!s) return "PRICE_SIGNER_KEY is not set";
    if (!m.perps.priceSigner || getAddress(m.perps.priceSigner) !== s.address) return "PRICE_SIGNER_KEY does not match the verifier's signer";
    return null;
  }

  async kick(): Promise<{ scheduled: boolean }> {
    if (!this.current()) return { scheduled: false };
    const at = await this.ctx.storage.getAlarm();
    // Reschedule when there is no alarm, when it is far off, or when it is overdue: an alarm
    // left in the past (after a deploy or an exhausted retry) would otherwise never run again.
    // With a tick floor set, a pending alarm stands: pulling it forward on every kick would undo the floor.
    const floor = Number(this.env.MIN_TICK_MS) || 0;
    if (floor > 0 && at !== null && at >= Date.now() - STALE_ALARM_MS) return { scheduled: false };
    if (at === null || at > Date.now() + 500 || at < Date.now() - STALE_ALARM_MS) {
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return { scheduled: true };
    }
    return { scheduled: false };
  }

  async getStatus(): Promise<KeeperStatus> {
    const m = await this.loadManifest().catch(() => null);
    const sent = (await this.ctx.storage.get<Record<string, number>>("sent")) ?? this.status.sent;
    // The object can be evicted between alarms, so the tick record is read from storage.
    const tick = this.status.lastTickAt ? null : await this.ctx.storage.get<TickRecord>("tick");
    if (tick && !tick.skipped) tick.skipped = [];
    return {
      ...this.status,
      ...(tick ?? {}),
      sent,
      code: KEEPER_CODE,
      network: this.env.NETWORK,
      keeper: this.account.address,
      signer: this.signer?.address ?? null,
      priceSource: m?.perps?.priceSource ?? null,
      signing: m ? this.signingProblem(m) === null : false,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  /**
   * Current prices, each with a report anyone can submit (a Pyth update, or the test signer's
   * signature). Cached for two seconds.
   */
  async signedPrices(): Promise<
    { ok: true; chainId: number; priceSource: string; verifier: Address; signer: Address | null; reports: SignedReport[] } | { ok: false; error: string }
  > {
    const m = await this.loadManifest();
    const problem = this.signingProblem(m);
    if (problem) return { ok: false, error: problem };
    const prices = await this.prices(m);
    const verifier = getAddress(m.perps!.reportVerifier);
    if (m.perps!.priceSource === "pyth") {
      const reports = prices.map((p) => ({ ...p, report: p.priceWad ? (this.pythCache.get(p.market)?.report ?? null) : null }));
      return { ok: true, chainId: m.chainId, priceSource: "pyth", verifier, signer: null, reports };
    }
    const signer = this.signer!;
    const reports = await Promise.all(
      prices.map(async (p) => ({
        ...p,
        report:
          p.priceWad && p.timestamp
            ? await signReport(signer, m.chainId, verifier, { feedId: p.feedId, price: BigInt(p.priceWad), timestamp: p.timestamp })
            : null,
      })),
    );
    return { ok: true, chainId: m.chainId, priceSource: m.perps!.priceSource, verifier, signer: signer.address, reports };
  }

  private async prices(m: Manifest, maxAgeMs = PRICE_TTL_MS): Promise<MarketPrice[]> {
    if (this.priceCache && Date.now() - this.priceCache.at < maxAgeMs) return this.priceCache.prices;
    if (m.perps?.priceSource === "pyth") return this.pythPrices(m);
    const markets = m.perps?.markets ?? [];
    const bases = [...new Set(markets.map((x) => x.base))];
    const { quotes, health } = await fetchQuotes(bases);
    const at = Date.now();
    const timestamp = Math.floor(at / 1000);
    const minSources = Number(this.env.MIN_SOURCES) || 2;
    const maxSpread = Number(this.env.MAX_SPREAD_BPS) || 100;
    const prices = markets.map((mk): MarketPrice => {
      const a = aggregate(quotes[mk.base] ?? [], minSources, maxSpread);
      const base = { market: mk.id, symbol: mk.symbol, base: mk.base, feed: mk.feed, feedId: mk.feedId as Hex };
      return a.ok
        ? { ...base, price: formatUnits(a.price, 18), priceWad: a.price.toString(), timestamp, sources: a.sources, ...(a.dropped.length ? { dropped: a.dropped } : {}) }
        : { ...base, price: null, priceWad: null, timestamp: null, sources: a.sources, error: a.error };
    });
    this.priceCache = { at, prices, sources: health };
    this.status.prices = prices;
    this.status.sources = health;
    return prices;
  }

  /** Latest Pyth prices from Hermes, one request for every market. */
  private async pythPrices(m: Manifest): Promise<MarketPrice[]> {
    const at = Date.now();
    const feeds = this.pythFeeds(m);
    let got: PythPrice[] = [];
    let feedErrors = new Map<string, string>();
    let health: SourceHealth;
    try {
      const r = await pythLatest({ url: this.env.HERMES_URL, key: this.env.PYTH_API_KEY }, feeds);
      got = r.prices;
      feedErrors = r.errors;
      health = { pyth: { ok: got.length > 0, ...(got.length ? {} : { error: [...r.errors.values()][0] ?? "no prices" }) } };
    } catch (e) {
      health = { pyth: { ok: false, error: e instanceof Error ? e.message.slice(0, 220) : "failed" } };
    }
    const byFeed = new Map(got.map((p) => [p.feedId.toLowerCase(), p]));
    const prices = (m.perps?.markets ?? []).map((mk): MarketPrice => {
      const base = { market: mk.id, symbol: mk.symbol, base: mk.base, feed: mk.feed, feedId: mk.feedId as Hex };
      const p = byFeed.get(mk.feedId.toLowerCase());
      if (!p) {
        this.pythCache.delete(mk.id);
        return { ...base, price: null, priceWad: null, timestamp: null, sources: ["pyth"], error: feedErrors.get(mk.feedId.toLowerCase()) ?? health.pyth?.error ?? "no Pyth price" };
      }
      this.pythCache.set(mk.id, p);
      return { ...base, price: formatUnits(p.priceWad, 18), priceWad: p.priceWad.toString(), timestamp: p.publishTime, sources: ["pyth"] };
    });
    this.priceCache = { at, prices, sources: health };
    this.status.prices = prices;
    this.status.sources = health;
    return prices;
  }

  async alarm(): Promise<void> {
    if (!this.current()) {
      await this.ctx.storage.deleteAlarm();
      console.warn("retired a keeper object from an earlier generation");
      return;
    }
    const started = Date.now();
    let next = IDLE_MS;
    try {
      next = await this.tick();
      this.status.consecutiveErrors = 0;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("keeper tick failed", message);
      this.status.lastError = message.slice(0, 300);
      this.status.lastErrorAt = Date.now();
      this.status.consecutiveErrors++;
      next = ERROR_MS;
    }
    this.status.ticks++;
    this.status.lastTickAt = Date.now();
    this.status.lastTickMs = Date.now() - started;
    const { ticks, lastTickAt, lastTickMs, lastError, lastErrorAt, consecutiveErrors, skipped } = this.status;
    await this.ctx.storage.put("tick", { ticks, lastTickAt, lastTickMs, lastError, lastErrorAt, consecutiveErrors, skipped } satisfies TickRecord);
    // A floor on the gap between ticks, where the network sets one (testnet, to save quota).
    // Not while requests wait: a request must be filled within its timeout, and a missed first
    // attempt would otherwise wait out the floor and expire.
    if (next !== ACTIVE_MS) next = Math.max(next, Number(this.env.MIN_TICK_MS) || 0);
    await this.ctx.storage.setAlarm(Date.now() + next);
    if (Date.now() - this.alertedAt >= ALERT_EVERY_MS) {
      this.alertedAt = Date.now();
      await this.alerts().catch((e) => console.error("alerts failed", e instanceof Error ? e.message : e));
    }
  }

  /** Posts problems and queued admin changes to ALERT_WEBHOOK_URL, if one is set. */
  private async alerts(): Promise<void> {
    const url = this.env.ALERT_WEBHOOK_URL;
    if (!url) return;
    const m = await this.loadManifest();
    const now = Date.now();
    let broadcaster: { reachable: boolean; health: string | null } | null = null;
    if (this.env.BROADCASTER_URL) {
      try {
        const r = await fetch(`${this.env.BROADCASTER_URL.replace(/\/$/, "")}/v1/broadcast/info`, { signal: AbortSignal.timeout(8_000) });
        const info = r.ok ? ((await r.json()) as { healthy?: boolean }) : null;
        broadcaster = { reachable: Boolean(info), health: info ? (info.healthy ? "ok" : "unhealthy") : null };
      } catch {
        broadcaster = { reachable: false, health: null };
      }
    }
    const symbols = new Map((m.perps?.markets ?? []).map((x) => [x.id, x.symbol]));
    const active = evaluate({
      now,
      gasLow: this.status.gasLow,
      gasBalanceWei: this.status.gasBalanceWei,
      minGasWei: this.env.MIN_GAS_BALANCE_WEI || "0",
      consecutiveErrors: this.status.consecutiveErrors,
      lastError: this.status.lastError,
      sources: m.perps?.priceSource === "curveil-test-signer" && this.priceCache ? this.priceCache.sources : null,
      minSources: Number(this.env.MIN_SOURCES || "2"),
      markets: this.marketViews.map((v) => ({ id: v.id, symbol: symbols.get(v.id) ?? `market ${v.id}`, openInterest: v.oiLong + v.oiShort, priceAt: v.priceAt })),
      broadcaster,
    });
    const sent = (await this.ctx.storage.get<SentLog>("alerts.sent")) ?? {};
    const { post, resolved, next } = planAlerts(active, sent, now);
    const queued = await this.queuedCalls(m).catch(() => [] as Alert[]);
    const all = [...post, ...queued];
    if (all.length === 0 && resolved.length === 0) return;
    if (await deliver(url, message(m.network, all, resolved))) await this.ctx.storage.put("alerts.sent", next);
  }

  /** CallScheduled events since the last look. Starts from the current block, so no backlog. */
  private async queuedCalls(m: Manifest): Promise<Alert[]> {
    const timelock = m.admin.timelock;
    if (!timelock) return [];
    const head = BigInt(await rpc<Hex>(this.env.RPC_URL, "eth_blockNumber", []));
    const from = (await this.ctx.storage.get<string>("alerts.block")) ?? head.toString();
    let start = BigInt(from);
    if (start > head) return [];
    const end = start + LOG_RANGE < head ? start + LOG_RANGE : head;
    const logs = await rpc<{ topics: Hex[]; data: Hex; transactionHash: Hex }[]>(this.env.RPC_URL, "eth_getLogs", [
      { address: timelock, topics: [CALL_SCHEDULED], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
    ]);
    await this.ctx.storage.put("alerts.block", (end + 1n).toString());
    return logs.map((l) => {
      const [target, , data, , delay] = decodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }],
        l.data,
      ) as [Hex, bigint, Hex, Hex, bigint];
      return queuedAlert(m.network, { id: `${l.topics[1]}.${BigInt(l.topics[2] ?? "0x0")}`, target, data, delay, txHash: l.transactionHash }, m.explorer);
    });
  }

  /** One pass. Returns the delay before the next one. */
  private async tick(): Promise<number> {
    const env = this.env;
    const m = await this.loadManifest();
    if (!m.perps || !m.contracts.PerpEngine || !m.contracts.OrderManager || !m.contracts.OracleAdapter || !m.contracts.PerpLens) return IDLE_MS * 3;
    const engine = m.contracts.PerpEngine.address;
    const orderManager = m.contracts.OrderManager.address;
    const oracle = m.contracts.OracleAdapter.address;
    const lens = m.contracts.PerpLens.address;
    const me = this.account;
    const markets = m.perps.markets;
    const signing = this.signingProblem(m) === null;

    // ---- 1. chain state, in one request
    const views: Call[] = [
      call(engine, engineAbi, "requestTimeout"),
      call(engine, engineAbi, "pendingRequests", [0n, BigInt(PAGE)]),
      call(engine, engineAbi, "openPositions", [0n, BigInt(PAGE)]),
      call(orderManager, ordersAbi, "activeOrderIds", [0n, BigInt(PAGE)]),
      ...markets.flatMap((mk) => [call(engine, engineAbi, "marketState", [mk.id]), call(oracle, oracleAbi, "latestPrice", [mk.feedId])]),
    ];
    const watchingBefore = this.status.watching;
    const busyBefore = watchingBefore.pending + watchingBefore.open + watchingBefore.orders > 0;
    const pricesEarly =
      signing && (busyBefore || !this.priceCache || Date.now() - this.priceCache.at > IDLE_PRICE_EVERY_MS) ? this.prices(m).catch(() => null) : null;
    const [nonceHex, balanceHex, gasPriceHex, aggregateOut] = await rpcBatch<Hex>(env.RPC_URL, [
      { method: "eth_getTransactionCount", params: [me.address, "pending"] },
      { method: "eth_getBalance", params: [me.address, "latest"] },
      { method: "eth_gasPrice", params: [] },
      {
        method: "eth_call",
        params: [
          { to: MULTICALL3, data: encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [views.map((c) => ({ target: c.target as Hex, allowFailure: false, callData: c.data }))] }) },
          "latest",
        ],
      },
    ]);
    const results = (decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: aggregateOut! }) as readonly { returnData: Hex }[]).map(
      (r) => r.returnData,
    );
    const requestTimeout = Number(decode<bigint>(engineAbi, "requestTimeout", results[0]!));
    const pendingIds = decode<readonly bigint[]>(engineAbi, "pendingRequests", results[1]!);
    const openIds = decode<readonly bigint[]>(engineAbi, "openPositions", results[2]!);
    const orderIds = decode<readonly bigint[]>(ordersAbi, "activeOrderIds", results[3]!);
    const marketViews: MarketView[] = markets.map((mk, i) => {
      const s = decode<{ oiLong: bigint; oiShort: bigint; fundingUpdatedAt: bigint }>(engineAbi, "marketState", results[4 + i * 2]!);
      const [, ts] = decode<readonly [bigint, bigint]>(oracleAbi, "latestPrice", results[5 + i * 2]!);
      return { id: mk.id, feedId: mk.feedId as Hex, oiLong: s.oiLong, oiShort: s.oiShort, fundingUpdatedAt: Number(s.fundingUpdatedAt), priceAt: Number(ts) };
    });
    this.marketViews = marketViews;
    const balance = BigInt(balanceHex!);
    this.status.gasBalanceWei = balance.toString();
    this.status.gasLow = balance < BigInt(env.MIN_GAS_BALANCE_WEI || "0");
    this.status.watching = { pending: pendingIds.length, open: openIds.length, orders: orderIds.length };
    const busy = pendingIds.length + openIds.length + orderIds.length > 0;
    const anyInterest = marketViews.some((x) => x.oiLong + x.oiShort > 0n);

    // ---- 2. prices (testnet signer) and details for ids not seen before
    let prices: MarketPrice[] = [];
    if (signing && (busy || anyInterest)) prices = (await pricesEarly) ?? (await this.prices(m));
    else if (pricesEarly) await pricesEarly;
    const priceOf = new Map<number, bigint>();
    const priceAt = new Map<number, number>();
    for (const p of prices) {
      if (!p.priceWad) continue;
      priceOf.set(p.market, BigInt(p.priceWad));
      if (p.timestamp) priceAt.set(p.market, p.timestamp);
    }

    this.prune(pendingIds, openIds, orderIds);
    const newRequests = pendingIds.filter((id) => !this.requests.has(id));
    const newOrders = orderIds.filter((id) => !this.orders.has(id));
    const detailCalls: Call[] = [
      ...newRequests.map((id) => call(engine, engineAbi, "request", [id])),
      ...newOrders.map((id) => call(orderManager, ordersAbi, "order", [id])),
    ];
    const detail = await multicallSettled(env.RPC_URL, detailCalls);
    newRequests.forEach((id, i) => {
      const d = detail[i];
      if (!d) return;
      const r = decode<{ positionId: bigint; createdAt: bigint; kind: number }>(engineAbi, "request", d);
      this.requests.set(id, { positionId: r.positionId, createdAt: Number(r.createdAt), kind: Number(r.kind) });
    });
    newOrders.forEach((id, i) => {
      const d = detail[newRequests.length + i];
      if (!d) return;
      const o = decode<{ positionId: bigint; owner: Address; kind: number; createdAt: bigint; expiresAt: bigint; triggerPrice: bigint; acceptablePrice: bigint }>(
        ordersAbi,
        "order",
        d,
      );
      this.orders.set(id, {
        positionId: o.positionId,
        owner: getAddress(o.owner),
        kind: Number(o.kind),
        createdAt: Number(o.createdAt),
        expiresAt: Number(o.expiresAt),
        triggerPrice: o.triggerPrice,
        acceptablePrice: o.acceptablePrice,
      });
    });

    // Positions: open ones, those behind pending requests, and those behind active orders.
    const wanted = new Set<bigint>([...openIds, ...[...this.requests.values()].map((r) => r.positionId), ...[...this.orders.values()].map((o) => o.positionId)]);
    const newPositions = [...wanted].filter((id) => !this.positions.has(id));
    const pos = await multicallSettled(env.RPC_URL, newPositions.map((id) => call(engine, engineAbi, "position", [id])));
    newPositions.forEach((id, i) => {
      const d = pos[i];
      if (!d) return;
      const p = decode<{ owner: Address; market: number; isLong: boolean }>(engineAbi, "position", d);
      this.positions.set(id, { owner: getAddress(p.owner), market: Number(p.market), isLong: p.isLong });
    });

    // Which open positions are liquidatable at the current price (PerpLens does the maths).
    const byMarket = new Map<number, bigint[]>();
    for (const id of openIds) {
      const p = this.positions.get(id);
      if (p && priceOf.has(p.market)) byMarket.set(p.market, [...(byMarket.get(p.market) ?? []), id]);
    }
    const liqMarkets = [...byMarket.keys()];
    const liq = await multicallSettled(
      env.RPC_URL,
      liqMarkets.map((mk) => call(lens, lensAbi, "liquidatable", [byMarket.get(mk), priceOf.get(mk)])),
    );
    const liquidatable = new Set<bigint>();
    liqMarkets.forEach((mk, i) => {
      const d = liq[i];
      if (!d) return;
      const flags = decode<readonly boolean[]>(lensAbi, "liquidatable", d);
      byMarket.get(mk)!.forEach((id, j) => flags[j] && liquidatable.add(id));
    });

    // ---- 3. plan
    const now = Math.floor(Date.now() / 1000);
    const priceTs = prices.find((p) => p.timestamp)?.timestamp ?? now;
    const planPrices = new Map<number, SignedPrice>();
    for (const [mk, price] of priceOf) planPrices.set(mk, { price, timestamp: priceAt.get(mk) ?? priceTs, report: "0x" });
    const openSet = new Set(openIds);
    const requests: RequestView[] = [];
    for (const id of pendingIds) {
      const r = this.requests.get(id);
      const p = r && this.positions.get(r.positionId);
      if (r && p) requests.push({ id, positionId: r.positionId, market: p.market, createdAt: r.createdAt, kind: r.kind });
    }
    const positions: PositionView[] = [];
    for (const id of openIds) {
      const p = this.positions.get(id);
      if (p) positions.push({ id, market: p.market, isLong: p.isLong, liquidatable: liquidatable.has(id) });
    }
    const orders: OrderView[] = [];
    for (const id of orderIds) {
      const o = this.orders.get(id);
      if (!o) continue;
      const p = this.positions.get(o.positionId);
      orders.push({
        id,
        positionId: o.positionId,
        market: p?.market ?? 0,
        kind: o.kind,
        isLong: p?.isLong ?? true,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
        triggerPrice: o.triggerPrice,
        acceptablePrice: o.acceptablePrice,
        positionLive: Boolean(p) && openSet.has(o.positionId) && p!.owner === o.owner,
      });
    }
    for (const [k, at] of this.inflight) if (Date.now() - at > INFLIGHT_MS) this.inflight.delete(k);
    const actions = plan(
      { now, requestTimeout, markets: marketViews, prices: planPrices, requests, positions, orders, inflight: new Set(this.inflight.keys()) },
      DEFAULT_PLAN,
    );

    if (actions.length > 0) await this.act(m, actions, priceOf, priceTs, BigInt(nonceHex!), BigInt(gasPriceHex!));

    if (pendingIds.length > 0) return ACTIVE_MS;
    return busy ? WATCH_MS : IDLE_MS;
  }

  private prune(pending: readonly bigint[], open: readonly bigint[], orders: readonly bigint[]) {
    const p = new Set(pending);
    for (const id of this.requests.keys()) if (!p.has(id)) this.requests.delete(id);
    const o = new Set(orders);
    for (const id of this.orders.keys()) if (!o.has(id)) this.orders.delete(id);
    const keep = new Set<bigint>([...open, ...[...this.requests.values()].map((r) => r.positionId), ...[...this.orders.values()].map((x) => x.positionId)]);
    for (const id of this.positions.keys()) if (!keep.has(id)) this.positions.delete(id);
  }

  /** Signs the reports the actions need, simulates every action, and sends those that pass. */
  private async act(m: Manifest, actions: Action[], priceOf: Map<number, bigint>, timestamp: number, nonce: bigint, gasPrice: bigint) {
    const env = this.env;
    const me = this.account;
    const engine = m.contracts.PerpEngine!.address as Address;
    const orderManager = m.contracts.OrderManager!.address as Address;
    const oracle = m.contracts.OracleAdapter!.address as Address;
    const verifier = getAddress(m.perps!.reportVerifier);
    const signer = this.signer;

    const pyth = m.perps!.priceSource === "pyth";
    const reports = new Map<number, Hex>();
    const reportFor = async (market: number): Promise<Hex> => {
      const cached = reports.get(market);
      if (cached) return cached;
      if (pyth) {
        const p = this.pythCache.get(market);
        if (!p) throw new Error(`no Pyth price for market ${market}`);
        reports.set(market, p.report);
        return p.report;
      }
      const mk = m.perps!.markets.find((x) => x.id === market);
      const price = priceOf.get(market);
      if (!mk || price === undefined || !signer) throw new Error(`no price for market ${market}`);
      const r = await signReport(signer, m.chainId, verifier, { feedId: mk.feedId as Hex, price, timestamp });
      reports.set(market, r);
      return r;
    };

    const txs: { action: Action; to: Address; data: Hex }[] = [];
    for (const a of actions) {
      switch (a.kind) {
        case "liquidate":
          txs.push({ action: a, to: engine, data: encodeFunctionData({ abi: engineAbi, functionName: "liquidate", args: [a.positionId, await reportFor(a.market)] }) });
          break;
        case "execute": {
          // The engine fills a request only at the first price after it. With Pyth that is
          // Hermes's first update from the second after the request; the test signer's report
          // is simply newer than the request.
          let report: Hex | null;
          if (pyth) {
            const r = this.requests.get(a.requestId);
            const feed = this.pythFeeds(m).find((f) => f.market === a.market);
            report = r && feed ? ((await firstAfter({ url: env.HERMES_URL, key: env.PYTH_API_KEY }, feed, r.createdAt + 1))?.report ?? null) : null;
          } else report = await reportFor(a.market);
          if (!report) {
            this.skip(a.key, "the first Pyth price after the request is not available yet");
            break;
          }
          txs.push({ action: a, to: engine, data: encodeFunctionData({ abi: engineAbi, functionName: "executeRequest", args: [a.requestId, report] }) });
          break;
        }
        case "cancel":
          txs.push({ action: a, to: engine, data: encodeFunctionData({ abi: engineAbi, functionName: "cancelRequest", args: [a.requestId] }) });
          break;
        case "fill":
          txs.push({ action: a, to: orderManager, data: encodeFunctionData({ abi: ordersAbi, functionName: "execute", args: [a.orderId, await reportFor(a.market)] }) });
          break;
        case "expire":
          txs.push({ action: a, to: orderManager, data: encodeFunctionData({ abi: ordersAbi, functionName: "expire", args: [a.orderId] }) });
          break;
        case "submit":
          txs.push({ action: a, to: oracle, data: encodeFunctionData({ abi: oracleAbi, functionName: "submit", args: [await reportFor(a.market)] }) });
          break;
        case "funding":
          txs.push({ action: a, to: engine, data: encodeFunctionData({ abi: engineAbi, functionName: "updateFunding", args: [a.market] }) });
          break;
      }
    }

    const estimates = await rpcBatchSettled<Hex>(
      env.RPC_URL,
      txs.map((t) => ({ method: "eth_estimateGas", params: [{ from: me.address, to: t.to, data: t.data }] })),
    );
    let sends = 0;
    const sent = (await this.ctx.storage.get<Record<string, number>>("sent")) ?? {};
    for (let i = 0; i < txs.length && sends < MAX_SENDS; i++) {
      const t = txs[i]!;
      const est = estimates[i]!;
      if (!est.ok) {
        this.skip(t.action.key, errorName(est.data, est.message));
        continue;
      }
      const raw = await me.signTransaction({
        type: "eip1559",
        chainId: m.chainId,
        nonce: Number(nonce),
        to: t.to,
        data: t.data,
        gas: (BigInt(est.result) * 13n) / 10n,
        maxFeePerGas: gasPrice * 2n,
        maxPriorityFeePerGas: 0n,
        value: 0n,
      });
      try {
        const hash = await rpc<Hex>(env.RPC_URL, "eth_sendRawTransaction", [raw]);
        nonce++;
        sends++;
        this.inflight.set(t.action.key, Date.now());
        sent[t.action.kind] = (sent[t.action.kind] ?? 0) + 1;
        this.status.recent = [{ kind: t.action.kind, key: t.action.key, hash, at: Date.now() }, ...this.status.recent].slice(0, 20);
      } catch (e) {
        // A nonce clash means another sender used this wallet; the next tick re-reads the nonce.
        this.skip(t.action.key, e instanceof Error ? e.message.slice(0, 220) : "send failed");
        break;
      }
    }
    if (sends > 0) {
      this.status.sent = sent;
      await this.ctx.storage.put("sent", sent);
    }
  }

  private skip(key: string, reason: string) {
    this.status.skipped = [{ key, reason, at: Date.now() }, ...this.status.skipped].slice(0, 20);
  }
}
