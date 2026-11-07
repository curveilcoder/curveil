/**
 * Perps: isolated-margin long and short positions in USDG against the perps liquidity vault.
 * Opening and closing are requests that a keeper executes with a fresh oracle price within
 * seconds; anyone may execute them. Everything shown is read from the chain through the API.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Loading, Sk, SkRows } from "../components/Skeleton";
import { TvChart, TvChartSkeleton } from "../components/TvChart";
import "../styles/perps.css";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useReadContract } from "wagmi";
import { formatUnits, maxUint256, type Address } from "viem";
import { ModuleStatus } from "../components/ModuleStatus";
import { ModuleGate } from "../components/ModuleGate";
import { TxStatus } from "../components/TxStatus";
import { WalletAction, AmountField } from "../components/WalletAction";
import { SyncNote, VaultGate, useShieldedVault } from "../components/Funding";
import { FundingSwitch } from "../components/FundingSwitch";
import { ShieldedPerpOpen, ShieldedPerpPositions } from "../components/ShieldedPerps";
import { erc20Abi } from "../lib/abis";
import { IS_TESTNET, QUOTE, curveilChain, explorerTx, shortAddress } from "../lib/config";
import { fmtAmount, fmtBps, parseAmount, timeAgo } from "../lib/format";
import { useWalletTokens } from "../lib/tokens";
import { useTxRunner, type TxStep } from "../lib/tx";
import { useFunding } from "../lib/funding";
import { balances, useVault } from "../lib/vault/store";
import {
  LEVERAGES,
  ORDER_MANAGER,
  PERPS_ADAPTER,
  PERPS_DEPLOYED,
  PERP_ENGINE,
  PERP_VAULT,
  REASON_TEXT,
  REASON_TEXT_ZH,
  SLIPPAGES_BPS,
  USDG_DECIMALS,
  WAD,
  acceptablePrice,
  fmtUsdPrice,
  kickKeeper,
  orderManagerAbi,
  perpEngineAbi,
  perpVaultAbi,
  previewOpen,
  signedUsd,
  usePerpActivity,
  usePerpCandles,
  usePerpOrders,
  usePerpPositions,
  usePerpVaultAccount,
  usePerpsOverview,
  wad,
  type CandleRange,
  type LivePosition,
  type OrderRow,
  type PerpMarket,
  type PerpsOverview,
  type RequestRow,
} from "../lib/perps";
import { useT, tNow } from "../lib/i18n";

const USDG = QUOTE?.address as Address | undefined;
const SYMBOL = QUOTE?.symbol ?? "USDG";
const usd = (v: bigint | string | null | undefined, digits = 2) => (v === null || v === undefined ? "–" : fmtAmount(v, USDG_DECIMALS, digits));

export function Perps() {
  const t = useT();
  if (!PERPS_DEPLOYED || !USDG) {
    return (
      <ModuleGate id="perps" title={t("Perps", "永续合约")} summary={t("Isolated-margin perpetuals in USDG with up to 5× leverage, funded publicly or from shielded notes.", "以 USDG 结算的逐仓永续合约，最高 5 倍杠杆，可用公开资金或隐私票据开仓。")} coming={t([
        "Long and short positions with charges and liquidation price shown first",
        "Close in part or in full, add margin, and set take-profit and stop-loss orders",
        "Stale or inconsistent oracle prices block new risk",
      ], [
        "做多和做空，费用和强平价格事先显示",
        "部分或全部平仓、追加保证金、设置止盈止损订单",
        "预言机价格过时或不一致时，禁止新增风险敞口",
      ])} />
    );
  }
  return <PerpsPage />;
}

type AccountTab = "info" | "positions" | "pending" | "orders" | "history" | "trades";
/** Candle sizes, TradingView style. Each one fetches the most history Coinbase sends in one go. */
const RANGES: [CandleRange, string][] = [["5h", "1m"], ["1d", "5m"], ["3d", "15m"], ["12d", "1h"], ["75d", "6h"], ["290d", "1D"]];

/** Price change over the last day, from the reference candles and the live mark. */
/** The last day of reference candles: change against the live mark, 24h high and low, and closes for a sparkline. */
function useDay(market: PerpMarket) {
  const day = usePerpCandles(market.id, "1d");
  const c = day.data?.candles ?? [];
  const markN = market.markPrice ? Number(market.markPrice) : null;
  const ref = c.length ? c[0]!.o : null;
  const now = markN ?? (c.length ? c[c.length - 1]!.c : null);
  return {
    change: ref && now ? (now - ref) / ref : null,
    hi: c.length ? Math.max(...c.map((x) => x.h), markN ?? 0) : null,
    lo: c.length ? Math.min(...c.map((x) => x.l), markN ?? Infinity) : null,
    closes: c.map((x) => x.c),
  };
}
const useDayChange = (market: PerpMarket) => useDay(market).change;

const pctText = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const toneOf = (x: number | null) => (x === null || x === 0 ? "" : x > 0 ? "good-text" : "bad-text");

function PerpsPage() {
  const t = useT();
  const overview = usePerpsOverview();
  const [marketId, setMarketId] = useState<number | null>(null);
  const [side, setSide] = useState<"long" | "short">("long");
  const markets = overview.data ? listedMarkets(overview.data) : [];
  const market = markets.find((m) => m.id === marketId) ?? markets[0];
  const shielded = useFunding() === "shielded" && Boolean(PERPS_ADAPTER);
  const vault = useShieldedVault(shielded);

  const pick = (s: "long" | "short") => {
    setSide(s);
    document.getElementById("px-order")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (overview.isError) {
    return (
      <div className="wrap tk px">
        <p className="notice bad" role="alert">{t("Perps markets could not be loaded from the API. Trading is blocked until they load.", "无法从 API 加载永续合约市场。加载成功前交易暂不可用。")}</p>
      </div>
    );
  }
  if (overview.isLoading || !overview.data || !market) return <PerpsSkeleton />;
  const o = overview.data;
  return (
    <div className="pxt px has-mbar">
      <ScrollLock />
      <div className="pxt-grid">
        <div className="pxt-left">
          <section className="pxt-card pxt-watch" aria-label={t("Markets", "市场")}>
            <Watchlist o={o} market={market} onPick={setMarketId} />
          </section>
          <section className="pxt-card pxt-bal" aria-label={t("Balances", "余额")}>
            <Balances />
          </section>
          <VaultTeaser o={o} />
        </div>
        <div className="pxt-right">
        <div className="pxt-center">
          <section className="pxt-card pxt-chart" aria-label={t(`${market.symbol} chart`, `${market.symbol} 图表`)}>
            <ChartHead o={o} market={market} onPick={setMarketId} />
            <ChartSection market={market} />
          </section>
          <section className="pxt-card pxt-account">
            <AccountTabs o={o} market={market} shielded={shielded} vault={vault} />
          </section>
          <section className="pxt-card pxt-liq" id="px-liquidity" aria-label={t("Provide liquidity", "提供流动性")}>
            <div className="pxt-card-head pxt-liq-head"><h2>{t("Provide liquidity", "提供流动性")}</h2></div>
            <div className="pxt-pad"><LiquidityVault o={o} /></div>
          </section>
        </div>
        <aside className="pxt-card pxt-side" id="px-order" aria-label={t("Place an order", "下单")}>
          <div className="pxt-side-head">
            <h2>{t(`Trade ${market.symbol}`, `交易 ${market.symbol}`)}</h2>
            {PERPS_ADAPTER && <FundingSwitch className="pxt-side-switch" />}
          </div>
          <section className={`tk-trade px-order${shielded ? " shielded-panel" : ""}`}>
            {shielded && <SyncNote v={vault} />}
            <OrderPanel o={o} market={market} shielded={shielded} vault={vault} side={side} onSide={setSide} />
          </section>
          <SideFoot shielded={shielded} />
        </aside>
        </div>
      </div>
      <div className="tk-mbar px-mbar" role="region" aria-label={t("Quick trade", "快速交易")}>
        <div className="tk-mbar-price">
          <span className="tk-label">{market.symbol}</span>
          <strong className="mono">{fmtUsdPrice(market.markPrice ?? market.recordedPrice?.price)}</strong>
        </div>
        <button type="button" className="btn tk-buy" onClick={() => pick("long")}>{t("Long", "做多")}</button>
        <button type="button" className="btn tk-sell" onClick={() => pick("short")}>{t("Short", "做空")}</button>
      </div>
    </div>
  );
}

/** On wide screens the terminal fills the window and its columns scroll, not the page. */
function ScrollLock() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("pxt-locked");
    return () => root.classList.remove("pxt-locked");
  }, []);
  return null;
}

/** The time left until the next whole hour, when funding settles. */
function useNextHour() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = 3600 - (Math.floor(now / 1000) % 3600);
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return { next: `${mm}:${ss}` };
}

const SHIELD = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13.5 3.5v4.2c0 3.3-2.3 5.7-5.5 6.8-3.2-1.1-5.5-3.5-5.5-6.8V3.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>;

/** A small line chart of the last day's closes. */
function Spark({ values, up }: { values: number[]; up: boolean | null }) {
  if (values.length < 2) return <span className="pxt-spark" aria-hidden="true" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 64).toFixed(1)},${(22 - ((v - lo) / span) * 20).toFixed(1)}`).join(" ");
  return (
    <svg className={`pxt-spark ${up === null ? "" : up ? "good-text" : "bad-text"}`} viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Markets to list: open ones that can be priced. A closed market, or one whose Pyth feed the plan
 * does not cover, is left out unless it still holds positions, so traders can always reach those.
 */
function listedMarkets(o: PerpsOverview): PerpMarket[] {
  const held = (m: PerpMarket) => Boolean(m.state && (BigInt(m.state.oiLong) > 0n || BigInt(m.state.oiShort) > 0n));
  const open = o.markets.filter((m) => held(m) || ((!m.config || m.config.enabled) && !m.priceFeedDenied));
  return open.length ? open : o.markets;
}

/** Every perps market, searchable, with its last day at a glance. Picking one switches the page. */
function Watchlist({ o, market, onPick }: { o: PerpsOverview; market: PerpMarket; onPick: (id: number) => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const all = listedMarkets(o);
  const list = all.filter((m) => !term || m.symbol.toLowerCase().includes(term) || m.base.toLowerCase().includes(term));
  // The list has a fixed maximum height and scrolls; a fade marks the edge that has more rows.
  const listRef = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState("");
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const up = el.scrollTop > 2;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setMore([up && "up", down && "down"].filter(Boolean).join(" "));
  };
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [list.length]);
  // Keep the picked market in view when it is chosen from the chart header.
  useEffect(() => {
    const el = listRef.current;
    const row = el?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el || !row) return;
    const top = row.offsetTop - el.offsetTop;
    if (top < el.scrollTop) el.scrollTop = top - 4;
    else if (top + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + row.offsetHeight - el.clientHeight + 4;
  }, [market.id]);
  return (
    <>
      <div className="pxt-card-head"><h2>{t("Markets", "市场")}</h2><span className="pxt-count">{all.length}</span></div>
      <label className="pxt-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
        <span className="sr-only">{t("Search markets", "搜索市场")}</span>
        <input type="search" placeholder={t("Search markets", "搜索市场")} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="pxt-watch-cols" aria-hidden="true"><span>{t("Market", "市场")}</span><span>{t("Mark", "标记价")}</span><span>24h</span></div>
      <ul className="pxt-watch-list" ref={listRef} onScroll={measure} data-more={more || undefined}>
        {list.map((m) => <WatchRow key={m.id} m={m} on={m.id === market.id} onPick={onPick} />)}
        {list.length === 0 && <li className="small muted pxt-watch-none">{t(`No market matches “${q}”.`, `没有与“${q}”匹配的市场。`)}</li>}
      </ul>
    </>
  );
}

function WatchRow({ m, on, onPick }: { m: PerpMarket; on: boolean; onPick: (id: number) => void }) {
  const d = useDay(m);
  const up = d.change === null ? null : d.change >= 0;
  return (
    <li>
      <button type="button" className="pxt-watch-row" aria-current={on ? "true" : undefined} onClick={() => onPick(m.id)}>
        <span className="pxt-watch-mk">
          <CoinMark base={m.base} />
          <span>
            <strong>{m.symbol}</strong>
            <span className="mono">{fmtUsdPrice(m.markPrice ?? m.recordedPrice?.price)}</span>
          </span>
        </span>
        <span className="pxt-watch-right">
          <Spark values={d.closes} up={up} />
          <span className={`mono ${toneOf(d.change)}`}>{pctText(d.change)}</span>
        </span>
      </button>
    </li>
  );
}

/** Scrolls to the liquidity card and briefly outlines it, so it is clear where to look. */
function goToVault() {
  const el = document.getElementById("px-liquidity");
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("pxt-flash");
  void el.offsetWidth;
  el.classList.add("pxt-flash");
}

/** The liquidity vault in the left column, so it is seen without scrolling. Without `o` it is the loading version. */
function VaultTeaser({ o }: { o?: PerpsOverview }) {
  const t = useT();
  const { address } = useConnection();
  const mine = usePerpVaultAccount(o ? address : undefined);
  const v = o?.vault;
  const shares = mine.data ? BigInt(mine.data.shares) : 0n;
  return (
    <section className="pxt-card pxt-vlt" aria-label={t("Liquidity vault", "流动性金库")}>
      <div className="pxt-card-head"><h2>{t("Liquidity vault", "流动性金库")}</h2><span className="pxt-pill">{t("Earn", "赚取")}</span></div>
      <p className="pxt-vlt-pitch">{t("Take the other side of every trade. The vault earns 80% of trading fees and what traders lose, and pays what they win.", "成为每笔交易的对手方。金库获得 80% 的交易手续费和交易者的亏损，并支付交易者的盈利。")}</p>
      <dl className="pxt-vlt-stats">
        <div><dt>{t("Value", "价值")}</dt><dd className="mono">{!v ? <Sk w="6ch" /> : v.totalAssets !== null ? `${usd(v.totalAssets, 0)} ${SYMBOL}` : t("pricing…", "定价中…")}</dd></div>
        <div><dt>{t("Share price", "份额价格")}</dt><dd className="mono">{!v ? <Sk w="6ch" /> : v.sharePrice !== null ? v.sharePrice.toFixed(4) : "–"}</dd></div>
      </dl>
      {shares > 0n && mine.data?.value && <p className="pxt-vlt-mine">{t("You hold", "你持有")} <span className="mono">≈ {usd(mine.data.value)} {SYMBOL}</span></p>}
      <button type="button" className="btn btn-primary btn-block" onClick={goToVault} disabled={!o}>{t("Provide liquidity", "提供流动性")}</button>
    </section>
  );
}

/** USDG in the connected wallet and in the shielded vault: what can margin a position. */
function Balances() {
  const t = useT();
  const { address } = useConnection();
  const wallet = useWalletTokens([USDG], PERP_ENGINE);
  const v = useVault();
  const usdgAsset = v.status?.assets.find((a) => USDG && a.address.toLowerCase() === USDG.toLowerCase());
  const shieldedBal = usdgAsset && v.phase === "unlocked" ? balances(usdgAsset.resource).spendable : undefined;
  const pub = wallet.get(USDG).balance;
  return (
    <>
      <div className="pxt-card-head"><h2>{t("Balances", "余额")}</h2></div>
      <div className="pxt-bal-box">
        <div className="pxt-bal-top">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.3" /></svg>
          <span>{t("Public wallet", "公开钱包")}</span>
        </div>
        <div className="pxt-bal-row"><span>{SYMBOL}</span><span className="mono">{!address ? t("Not connected", "未连接") : pub !== undefined ? usd(pub) : "–"}</span></div>
      </div>
      <Link to="/app/vault" className="pxt-bal-box pxt-bal-link">
        <div className="pxt-bal-top">
          <span className="pxt-fund-ico on">{SHIELD}</span>
          <span>{t("Shielded vault", "隐私金库")}</span>
          <svg className="pxt-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </div>
        <div className="pxt-bal-row">
          <span>{SYMBOL}</span>
          <span className="mono">{shieldedBal !== undefined ? usd(shieldedBal) : v.phase === "locked" ? t("Locked", "已锁定") : v.phase === "none" ? t("No vault yet", "还没有金库") : "–"}</span>
        </div>
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ market switch and header

/** The market list in a dialog, with search: opened from the market title. */
function MarketPicker({ o, market, onPick, onClose }: { o: PerpsOverview; market: PerpMarket; onPick: (id: number) => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const term = q.trim().toLowerCase();
  const list = listedMarkets(o).filter((m) => !term || m.symbol.toLowerCase().includes(term) || m.base.toLowerCase().includes(term));
  return (
    <dialog ref={ref} className="px-dlg" aria-label={t("Choose a market", "选择市场")} onClose={onClose} onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="px-dlg-in">
        <div className="px-dlg-head">
          <h2>{t("Perpetual markets", "永续合约市场")}</h2>
          <button type="button" className="txt-close" aria-label={t("Close", "关闭")} onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </div>
        <label className="px-dlg-search">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
          <span className="sr-only">{t("Search markets", "搜索市场")}</span>
          <input autoFocus type="search" placeholder={t("Search by name, e.g. ETH", "按名称搜索，例如 ETH")} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="px-dlg-cols" aria-hidden="true"><span>{t("Market", "市场")}</span><span>{t("Mark price", "标记价格")}</span><span>24h</span><span>{t("Volume 24h", "24 小时成交量")}</span></div>
        <ul className="px-dlg-list" role="listbox" aria-label={t("Markets", "市场")}>
          {list.map((m) => <PickerRow key={m.id} m={m} on={m.id === market.id} onPick={(id) => { onPick(id); ref.current?.close(); }} />)}
          {list.length === 0 && <li className="small muted px-dlg-none">{t(`No market matches “${q}”.`, `没有与“${q}”匹配的市场。`)}</li>}
        </ul>
      </div>
    </dialog>
  );
}

/** Official logos for perps markets, served by the site. A market without one shows its first letter. */
const COIN_LOGOS: Record<string, string> = Object.fromEntries(
  ["ETH", "BTC", "SOL", "LINK", "XRP", "BNB", "DOGE", "AVAX", "SUI", "LTC", "ADA", "HYPE"].map((b) => [b, `/tokens/${b.toLowerCase()}.png`]),
);

function CoinMark({ base, large }: { base: string; large?: boolean }) {
  const cls = `px-coin${large ? " px-coin-lg" : ""} px-coin-${base.toLowerCase()}`;
  const logo = COIN_LOGOS[base.toUpperCase()];
  if (logo) return <img className={`${cls} px-coin-img`} src={logo} alt="" aria-hidden="true" />;
  return <span className={cls} aria-hidden="true">{base.slice(0, 1)}</span>;
}

function PickerRow({ m, on, onPick }: { m: PerpMarket; on: boolean; onPick: (id: number) => void }) {
  const t = useT();
  const change = useDayChange(m);
  return (
    <li>
      <button type="button" role="option" aria-selected={on} className="px-dlg-row" onClick={() => onPick(m.id)}>
        <span className="px-dlg-mk">
          <CoinMark base={m.base} />
          <span><strong>{m.symbol}</strong><span className="small muted">{m.config ? t(`Up to ${m.config.maxLeverageBps / 10_000}×`, `最高 ${m.config.maxLeverageBps / 10_000}×`) : "–"}</span></span>
        </span>
        <span className="mono">{fmtUsdPrice(m.markPrice ?? m.recordedPrice?.price)}</span>
        <span className={`mono ${toneOf(change)}`}>{pctText(change)}</span>
        <span className="mono muted">{Number(m.volume24h).toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
      </button>
    </li>
  );
}

/** The chart card's header: market switch, mark price and change, then the market's live numbers. */
function ChartHead({ o, market, onPick }: { o: PerpsOverview; market: PerpMarket; onPick: (id: number) => void }) {
  const t = useT();
  const d = useDay(market);
  const cfg = market.config;
  const st = market.state;
  const rec = market.recordedPrice;
  const rate = Number(market.fundingRatePerHour);
  const { next } = useNextHour();
  const [open, setOpen] = useState(false);
  const f = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n >= 1000 ? 2 : 4 }));
  return (
    <header className="pxt-head">
      {open && <MarketPicker o={o} market={market} onPick={onPick} onClose={() => setOpen(false)} />}
      <div className="pxt-head-id">
        <h1>
          <button type="button" className="pxt-mkt-btn" aria-haspopup="dialog" title={t("Change market", "切换市场")} onClick={() => setOpen(true)}>
            <CoinMark base={market.base} />
            <span>{market.base}<span className="pxt-slash"> / </span>USD</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
        </h1>
        {cfg && <span className="pxt-pill">{t(`Up to ${cfg.maxLeverageBps / 10_000}×`, `最高 ${cfg.maxLeverageBps / 10_000}×`)}</span>}
        {cfg && !cfg.enabled && <span className="pxt-pill warn-text">{t("Paused", "已暂停")}</span>}
      </div>
      <div className="pxt-head-px">
        <strong className="mono">{fmtUsdPrice(market.markPrice)}</strong>
        <span className={`pxt-chg mono ${d.change === null ? "" : d.change >= 0 ? "up" : "down"}`}>{pctText(d.change)}</span>
      </div>
      <dl className="pxt-head-stats">
        <div><dt>{t("24h high", "24 小时最高")}</dt><dd className="mono">{f(d.hi)}</dd></div>
        <div><dt>{t("24h low", "24 小时最低")}</dt><dd className="mono">{f(d.lo)}</dd></div>
        <div><dt>{t("Oracle", "预言机")}</dt><dd className="mono" title={rec?.timestamp ? t(`Last recorded on-chain ${timeAgo(rec.timestamp)}`, `最近一次上链记录：${timeAgo(rec.timestamp)}`) : undefined}>{rec?.timestamp ? fmtUsdPrice(rec.price) : "–"}</dd></div>
        <div><dt>{t("Funding 1h", "1 小时资金费")}</dt><dd className={`mono ${toneOf(rate)}`} title={fundingText(market)}>{Number.isFinite(rate) ? `${(rate * 100).toFixed(4)}%` : "–"} <span className="muted">· {next}</span></dd></div>
        <div><dt>{t("Open interest", "未平仓量")}</dt><dd className="mono">{st ? usd(BigInt(st.oiLong) + BigInt(st.oiShort), 0) : "–"} <span className="muted">{SYMBOL}</span></dd></div>
        <div><dt>{t("Volume 24h", "24 小时成交量")}</dt><dd className="mono">{Number(market.volume24h).toLocaleString("en-US", { maximumFractionDigits: 0 })} <span className="muted">{SYMBOL}</span></dd></div>
        <div><dt>{t("Vault liquidity", "金库流动性")}</dt><dd className="mono"><button type="button" className="pxt-stat-link" onClick={goToVault} title={t("Provide liquidity to the vault", "向金库提供流动性")}>{o.vault.freeLiquidity !== null ? usd(o.vault.freeLiquidity, 0) : "–"} <span className="muted">{SYMBOL}</span></button></dd></div>
      </dl>
    </header>
  );
}

// ------------------------------------------------------------------ chart, stats, open interest, facts

const CHART_H = 360;
const DEFAULT_RANGE: CandleRange = "12d";

function ChartSection({ market }: { market: PerpMarket }) {
  const t = useT();
  const [range, setRange] = useState<CandleRange>(DEFAULT_RANGE);
  const q = usePerpCandles(market.id, range);
  const mark = market.markPrice ? Number(market.markPrice) : null;
  const c = q.data?.candles ?? [];
  const tf = RANGES.find(([r]) => r === range)?.[1] ?? "";
  const sizes = (
    <div className="pxt-tf" role="group" aria-label={t("Candle size", "K 线周期")}>
      {RANGES.map(([r, label]) => <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{label}</button>)}
    </div>
  );
  return (
    <section className="tk-chart pxt-chart-body" aria-label={t(`${market.symbol} price`, `${market.symbol} 价格`)}>
      {q.isLoading && !q.data ? (
        <ChartFrameSkeleton toolbar={sizes} />
      ) : q.isError && !q.data ? (
        <>
          <div className="pxt-tools">{sizes}</div>
          <div className="chart-empty" style={{ minHeight: CHART_H }}><p className="small muted" style={{ margin: 0 }}>{t("Reference prices are unavailable right now. Trading still uses the signed oracle price.", "参考价格暂时不可用。交易仍使用带签名的预言机价格。")}</p></div>
        </>
      ) : (
        <TvChart
          candles={c}
          mark={mark}
          height={CHART_H}
          resetKey={`${market.id}:${range}`}
          terminal={{
            title: t(`${market.base} / USD · ${tf} · Coinbase reference`, `${market.base} / USD · ${tf} · Coinbase 参考价`),
            toolbar: sizes,
            fileName: `curveil-${market.base}-USD-${tf}`,
          }}
        />
      )}
    </section>
  );
}

/** Longs against shorts, and how much of each side's cap is used. */
function OpenInterest({ market }: { market: PerpMarket }) {
  const t = useT();
  const cfg = market.config;
  const st = market.state;
  const oiL = st ? BigInt(st.oiLong) : 0n;
  const oiS = st ? BigInt(st.oiShort) : 0n;
  const total = oiL + oiS;
  const longPct = total === 0n ? 50 : Number((oiL * 1000n) / total) / 10;
  const used = (a: bigint, cap: string | undefined) => (cap && BigInt(cap) > 0n ? Number((a * 1000n) / BigInt(cap)) / 10 : 0);
  return (
    <section className="tk-curve px-oi" aria-label={t("Open interest", "未平仓量")}>
      <div className="row-between">
        <span className="tk-label">{t("Open interest, long against short", "未平仓量：多头对空头")}</span>
        <span className="small muted">{fundingText(market)}</span>
      </div>
      <div className={`px-split${total === 0n ? " empty" : ""}`} role="img" aria-label={t(`Longs ${longPct.toFixed(1)}%, shorts ${(100 - longPct).toFixed(1)}%`, `多头 ${longPct.toFixed(1)}%，空头 ${(100 - longPct).toFixed(1)}%`)}>
        <div className="px-split-l" style={{ width: `${longPct}%` }} />
        <div className="px-split-s" />
      </div>
      <div className="px-oi-sides">
        <div>
          <span className="good-text">{t("Long", "多头")} {total === 0n ? "–" : `${longPct.toFixed(1)}%`}</span>
          <span className="mono">{usd(oiL, 0)} <span className="muted">{t(`of ${cfg ? usd(cfg.maxOpenInterestLong, 0) : "–"} cap (${used(oiL, cfg?.maxOpenInterestLong).toFixed(1)}%)`, `/ 上限 ${cfg ? usd(cfg.maxOpenInterestLong, 0) : "–"}（${used(oiL, cfg?.maxOpenInterestLong).toFixed(1)}%）`)}</span></span>
        </div>
        <div>
          <span className="bad-text">{t("Short", "空头")} {total === 0n ? "–" : `${(100 - longPct).toFixed(1)}%`}</span>
          <span className="mono">{usd(oiS, 0)} <span className="muted">{t(`of ${cfg ? usd(cfg.maxOpenInterestShort, 0) : "–"} cap (${used(oiS, cfg?.maxOpenInterestShort).toFixed(1)}%)`, `/ 上限 ${cfg ? usd(cfg.maxOpenInterestShort, 0) : "–"}（${used(oiS, cfg?.maxOpenInterestShort).toFixed(1)}%）`)}</span></span>
        </div>
      </div>
    </section>
  );
}

function MarketFacts({ o, market }: { o: PerpsOverview; market: PerpMarket }) {
  const t = useT();
  const cfg = market.config;
  const rec = market.recordedPrice;
  const oi = market.state ? BigInt(market.state.oiLong) + BigInt(market.state.oiShort) : 0n;
  const stale = rec && rec.ageSeconds !== null && rec.ageSeconds > o.params.navMaxAge && oi > 0n;
  return (
    <section className="tk-about">
      <h2>{t("Market details", "市场详情")}</h2>
      <dl className="tk-facts">
        <div><dt>{t("Max leverage", "最大杠杆")}</dt><dd>{cfg ? `${cfg.maxLeverageBps / 10_000}×` : "–"}</dd></div>
        <div><dt>{t("Open / close fee", "开仓 / 平仓手续费")}</dt><dd className="mono">{fmtBps(cfg?.openFeeBps)} / {fmtBps(cfg?.closeFeeBps)}</dd></div>
        <div><dt>{t("Maintenance margin", "维持保证金")}</dt><dd className="mono">{t(`${fmtBps(cfg?.maintenanceMarginBps)} of size`, `仓位规模的 ${fmtBps(cfg?.maintenanceMarginBps)}`)}</dd></div>
        <div><dt>{t("Liquidation fee", "强平手续费")}</dt><dd className="mono">{t(`${fmtBps(cfg?.liquidationFeeBps)} of size`, `仓位规模的 ${fmtBps(cfg?.liquidationFeeBps)}`)}</dd></div>
        <div><dt>{t("Profit cap", "盈利上限")}</dt><dd className="mono">{cfg ? t(`${cfg.maxProfitBps / 100}% of size`, `仓位规模的 ${cfg.maxProfitBps / 100}%`) : "–"}</dd></div>
        <div><dt>{t("Minimum margin", "最低保证金")}</dt><dd className="mono">{cfg ? `${usd(BigInt(cfg.minCollateral))} ${SYMBOL}` : "–"}</dd></div>
        <div><dt>{t("Keeper fee", "执行者费用")}</dt><dd className="mono">{usd(BigInt(o.params.minExecutionFee), 4)} {SYMBOL}</dd></div>
        <div><dt>{t("Last on-chain price", "最近上链价格")}</dt><dd className={`mono ${stale ? "warn-text" : ""}`}>{rec && rec.timestamp ? `${fmtUsdPrice(rec.price)} · ${timeAgo(rec.timestamp)}` : t("none yet", "暂无")}</dd></div>
        <div><dt>{t("Price sources", "价格来源")}</dt><dd title={market.markSources.join(", ")}>{market.markSources.length ? market.markSources.join(", ") : "–"}</dd></div>
      </dl>
      <p className="small muted">
        {o.priceSource === "pyth"
          ? t("Prices come from Pyth and are checked on-chain by Pyth's contract. A request fills at the first Pyth price after you send it, so nobody can pick a better or worse one.", "价格来自 Pyth，并由 Pyth 合约在链上校验。请求会以你发送之后的第一个 Pyth 价格成交，因此没有人能挑选更好或更差的价格。")
          : o.priceSource === "curveil-test-signer"
            ? t("Testnet prices are a median of public exchanges, signed by a Curveil test key.", "测试网价格取多家公开交易所的中位数，并由 Curveil 测试密钥签名。")
            : t("Prices come from the oracle network's signed reports.", "价格来自预言机网络的签名报告。")}
      </p>
    </section>
  );
}

function Trades({ market }: { market: PerpMarket }) {
  const t = useT();
  const q = usePerpActivity(market.id);
  const rows = q.data ?? [];
  if (q.isLoading) return <><Loading label={t("Loading trades", "正在加载成交")} /><div className="table-scroll" tabIndex={0}><table className="data px-table"><tbody><SkRows cols={5} rows={4} /></tbody></table></div></>;
  if (rows.length === 0) return <p className="small muted px-empty">{t("No trades in this market yet.", "该市场还没有成交。")}</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data px-table">
        <thead><tr><th>{t("Action", "操作")}</th><th className="num">{t("Price", "价格")}</th><th className="num">{t("Size", "仓位规模")} ({SYMBOL})</th><th className="num">{t("PnL", "盈亏")}</th><th className="num">{t("Age", "时间")}</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const size = r.event === "opened" ? r.size : r.size_delta;
            const what = r.event === "opened" ? t("Open", "开仓") : r.event === "decreased" ? t("Close", "平仓") : t("Liquidation", "强平");
            return (
              <tr key={`${r.tx_hash}-${r.position_id}-${r.event}`}>
                <td>
                  <a className="px-mk" href={explorerTx(r.tx_hash)} target="_blank" rel="noreferrer">
                    <strong>{what}</strong>
                    <span className={r.event === "liquidated" ? "warn-text" : r.is_long ? "good-text" : "bad-text"}>{r.is_long ? t("Long", "做多") : t("Short", "做空")}</span>
                  </a>
                </td>
                <td className="num mono">{fmtUsdPrice(BigInt(r.price))}</td>
                <td className="num mono">{size ? usd(size, 0) : "–"}</td>
                <td className={`num mono ${r.pnl === null ? "" : BigInt(r.pnl) < 0n ? "bad-text" : "good-text"}`}>{r.pnl === null ? "–" : signedUsd(BigInt(r.pnl))}</td>
                <td className="num muted">{timeAgo(r.timestamp)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ loading

/** The page while markets load: the same frame, values as bars. */
function PerpsSkeleton() {
  const t = useT();
  const shielded = useFunding() === "shielded" && Boolean(PERPS_ADAPTER);
  const off = { type: "button" as const, disabled: true, tabIndex: -1 };
  const rows = (labels: string[], w = "8ch") => labels.map((l) => <div key={l}><dt>{l}</dt><dd><Sk w={w} /></dd></div>);
  return (
    <div className="pxt px has-mbar" aria-busy="true">
      <ScrollLock />
      <Loading label={t("Loading perps markets", "正在加载永续合约市场")} />
      <div className="pxt-grid">
        <div className="pxt-left">
          <section className="pxt-card pxt-watch" aria-hidden="true">
            <div className="pxt-card-head"><h2>{t("Markets", "市场")}</h2><Sk w={22} h={18} style={{ borderRadius: 999 }} /></div>
            <label className="pxt-search">
              <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
              <input type="search" placeholder={t("Search markets", "搜索市场")} disabled tabIndex={-1} />
            </label>
            <div className="pxt-watch-cols"><span>{t("Market", "市场")}</span><span>{t("Mark", "标记价")}</span><span>24h</span></div>
            <ul className="pxt-watch-list" data-more="down">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <li key={i}>
                  <div className="pxt-watch-row" aria-current={i === 0 ? "true" : undefined}>
                    <span className="pxt-watch-mk">
                      <Sk w={26} h={26} style={{ borderRadius: "50%" }} />
                      <span><strong><Sk w="7ch" /></strong><span className="mono"><Sk w="8ch" /></span></span>
                    </span>
                    <span className="pxt-watch-right"><Sk w={64} h={22} /><span className="mono"><Sk w="6ch" /></span></span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="pxt-card pxt-bal">
            <Balances />
          </section>
          <VaultTeaser />
        </div>
        <div className="pxt-right">
        <div className="pxt-center">
        <section className="pxt-card pxt-chart" aria-hidden="true">
          <header className="pxt-head">
            <div className="pxt-head-id">
              <h1><span className="pxt-mkt-btn"><Sk w={30} h={30} style={{ borderRadius: "50%" }} /><Sk w="6ch" h={22} /></span></h1>
              <Sk w={68} h={22} style={{ borderRadius: 999 }} />
            </div>
            <div className="pxt-head-px"><strong className="mono"><Sk w="8ch" /></strong><Sk w="6ch" h={26} /></div>
            <dl className="pxt-head-stats">{rows(t(["24h high", "24h low", "Oracle", "Funding 1h", "Open interest", "Volume 24h", "Vault liquidity"], ["24 小时最高", "24 小时最低", "预言机", "1 小时资金费", "未平仓量", "24 小时成交量", "金库流动性"]), "7ch")}</dl>
          </header>
          <section className="tk-chart pxt-chart-body"><ChartFrameSkeleton /></section>
        </section>
        <section className="pxt-card pxt-account" aria-hidden="true">
          <div className="tk-tabs px-account">
            <div className="tk-tablist">{[t("Market info", "市场信息"), ...(shielded ? [t("Shielded positions", "隐私仓位")] : t(["Positions", "Pending", "TP / SL", "History"], ["仓位", "待执行", "止盈 / 止损", "历史"])), t("Market trades", "市场成交")].map((l, i) => <button key={l} {...off} role="tab" aria-selected={i === 0}>{l}</button>)}</div>
            <div className="pxt-pad pxt-info">
              <section className="tk-curve px-oi">
                <div className="row-between"><span className="tk-label">{t("Open interest, long against short", "未平仓量：多头对空头")}</span><Sk w="24ch" /></div>
                <div className="px-split empty"><div className="px-split-l" style={{ width: "50%" }} /><div className="px-split-s" /></div>
                <div className="px-oi-sides">
                  <div><span className="good-text">{t("Long", "多头")} –</span><span className="mono"><Sk w="23ch" /></span></div>
                  <div><span className="bad-text">{t("Short", "空头")} –</span><span className="mono"><Sk w="23ch" /></span></div>
                </div>
              </section>
              <section className="tk-about">
                <h2>{t("Market details", "市场详情")}</h2>
                <dl className="tk-facts">{rows(t(["Max leverage", "Open / close fee", "Maintenance margin", "Liquidation fee", "Profit cap", "Minimum margin", "Keeper fee", "Last on-chain price", "Price sources"], ["最大杠杆", "开仓 / 平仓手续费", "维持保证金", "强平手续费", "盈利上限", "最低保证金", "执行者费用", "最近上链价格", "价格来源"]))}</dl>
                <p className="small muted"><Sk w="100%" /><Sk w="60%" /></p>
              </section>
            </div>
          </div>
        </section>
        <section className="pxt-card pxt-liq">
          <div className="pxt-card-head pxt-liq-head"><h2>{t("Provide liquidity", "提供流动性")}</h2></div>
          <div className="pxt-pad">
            <div className="swap-layout px-lp">
              <div className="panel stack">
                <div className="row-between"><p className="eyebrow" style={{ margin: 0 }}>{t("Liquidity vault", "流动性金库")}</p><span className="tag tag-public">{t("Public", "公开")}</span></div>
                <p className="small muted" style={{ margin: 0 }}>
                  {t("The vault is every trader's counterparty. It earns what traders lose, 80% of trading fees and the funding imbalance, and pays what they win. Share value moves with open positions.", "金库是所有交易者的对手方。它获得交易者的亏损、80% 的交易手续费和资金费差额，并支付交易者的盈利。份额价值随持仓变动。")}
                </p>
                <dl className="kv stats">{rows(t(["Value", "Share price", "Reserved"], ["价值", "份额价格", "已预留"]))}</dl>
                <dl className="rows">{rows(t(["Free to redeem", "Most it can reserve", "Deposit lock"], ["可赎回", "最多可预留", "存入锁定期"]))}</dl>
              </div>
              <div className="panel stack">
                <div className="seg fill" style={{ marginTop: 0 }}><button {...off} aria-pressed="true">{t("Deposit", "存入")}</button><button {...off}>{t("Redeem", "赎回")}</button></div>
                <AmountField label={t("Deposit", "存入")} value="" onChange={() => {}} symbol={SYMBOL}><span className="token-tag">{SYMBOL}</span></AmountField>
                <dl className="rows summary">{rows(t(["Shares you get", "Your shares"], ["你获得的份额", "你的份额"]))}</dl>
                <WalletAction verb={t("deposit", "存入")}><Sk block w="100%" h={44} /></WalletAction>
                <p className="small muted" style={{ margin: 0 }}><Sk w="100%" /><Sk w="70%" /></p>
              </div>
            </div>
          </div>
        </section>
        </div>
        <aside className="pxt-card pxt-side">
          <div className="pxt-side-head">
            <h2>{t("Trade", "交易")} <Sk w="7ch" /></h2>
            {PERPS_ADAPTER && <FundingSwitch className="pxt-side-switch" />}
          </div>
          <section className={`tk-trade px-order${shielded ? " shielded-panel" : ""}`}>
            <div className="px-chips"><span className="px-chip">{t("Isolated", "逐仓")}</span><span className="px-chip">{t("Market", "市价")}</span><span className="px-chip mono">{t("Up to", "最高")} <Sk w="2ch" /></span></div>
            <div className="seg side-seg px-side-seg" style={{ marginTop: 0 }}>
              <button {...off} aria-pressed="true" data-side="long">{t("Long", "做多")}</button>
              <button {...off} data-side="short">{t("Short", "做空")}</button>
            </div>
            <div className="px-avail"><span>{t("Available", "可用")}</span><span className="mono"><Sk w="8ch" /></span></div>
            <AmountField label={t("Margin", "保证金")} value="" onChange={() => {}} symbol={SYMBOL}><span className="token-tag">{SYMBOL}</span></AmountField>
            <div className="px-pcts">{[25, 50, 75, 100].map((f) => <button key={f} {...off}>{f}%</button>)}</div>
            <div className="px-field">
              <div className="px-field-top"><span>{t("Leverage", "杠杆")}</span><span className="mono">3×</span></div>
              <div className="px-levs">{LEVERAGES.map((l) => <button key={l} {...off} aria-pressed={l === 3}>{l}×</button>)}</div>
            </div>
            <div className="px-field">
              <div className="px-field-top">
                <span>{t("Max slippage", "最大滑点")}</span>
                <div className="px-levs px-slip">{SLIPPAGES_BPS.map((b, i) => <button key={b} {...off} aria-pressed={i === 1}>{b / 100}%</button>)}</div>
              </div>
            </div>
            <WalletAction verb={t("trade perps", "交易永续合约")}><Sk block w="100%" h={44} /></WalletAction>
            <dl className="px-rows">
              {rows(t(["Liquidation price", "Order value", "Margin", "Fill no worse than", "Fees", "Most it can gain"], ["强平价格", "订单价值", "保证金", "成交价不差于", "手续费", "最多可赚"]))}
              <div className="px-total"><dt>{t(`Total from your ${shielded ? "notes" : "wallet"}`, `从你的${shielded ? "票据" : "钱包"}中支出合计`)}</dt><dd><Sk w="8ch" /></dd></div>
            </dl>
            <p className="px-note"><Sk w="100%" /><Sk w="100%" /><Sk w="50%" /></p>
          </section>
          <SideFoot shielded={shielded} />
        </aside>
        </div>
      </div>
      <div className="tk-mbar px-mbar" aria-hidden="true">
        <div className="tk-mbar-price"><span className="tk-label"><Sk w="7ch" /></span><strong className="mono"><Sk w="8ch" /></strong></div>
        <button {...off} className="btn tk-buy">{t("Long", "做多")}</button>
        <button {...off} className="btn tk-sell">{t("Short", "做空")}</button>
      </div>
    </div>
  );
}

/** The chart card's frame while candles load: the real toolbar, the plot as one bar. */
function ChartFrameSkeleton({ toolbar }: { toolbar?: ReactNode }) {
  return (
    <TvChartSkeleton
      height={CHART_H}
      toolbar={toolbar ?? <div className="pxt-tf">{RANGES.map(([r, label]) => <button key={r} type="button" disabled tabIndex={-1} aria-pressed={r === DEFAULT_RANGE}>{label}</button>)}</div>}
    />
  );
}

/** What an order makes public, and the leverage warning: under the order card. */
function SideFoot({ shielded }: { shielded: boolean }) {
  const t = useT();
  return (
    <div className="pxt-side-foot">
      <p className="pxt-privacy">
        {shielded
          ? t(<><b>Public:</b> market, size and price. <b>Hidden:</b> which wallet holds the position.</>, <><b>公开：</b>市场、仓位规模和价格。<b>隐藏：</b>哪个钱包持有该仓位。</>)
          : t(<><b>Public:</b> market, size, price and your wallet address. Switch to Shielded to hide the wallet.</>, <><b>公开：</b>市场、仓位规模、价格和你的钱包地址。切换到“隐私”即可隐藏钱包。</>)}
      </p>
      <p className="pxt-warn">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.5 11.4H1.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 6.2v3.3M8 11.3v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        <span>{t("Leverage multiplies losses as well as gains. Not independently audited.", "杠杆会同时放大盈利和亏损。尚未经过独立审计。")}</span>
      </p>
    </div>
  );
}

/** One position row while it loads. */
export function PositionSkeleton({ shielded = false }: { shielded?: boolean }) {
  const t = useT();
  return (
    <div className="panel stack perp-position" aria-hidden="true">
      <div className="row-between">
        <span className="row-between" style={{ gap: 8 }}>
          <Sk w="8ch" /><Sk w="5ch" h={20} />
          {shielded && <span className="tag tag-shielded">{t("Shielded", "隐私")}</span>}
        </span>
        <Sk w="4ch" />
      </div>
      <dl className="kv stats">
        {t(["Size", "Collateral", "PnL after funding", "Entry", "Mark", "Liquidation"], ["仓位规模", "保证金", "扣除资金费后的盈亏", "开仓价", "标记价", "强平价"]).map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="8ch" /></dd></div>)}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ order panel

function OrderPanel({ o, market, shielded, vault, side, onSide }: { o: PerpsOverview; market: PerpMarket; shielded: boolean; vault: ReturnType<typeof useShieldedVault>; side: "long" | "short"; onSide: (s: "long" | "short") => void }) {
  const t = useT();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const wallet = useWalletTokens([USDG], PERP_ENGINE);
  const isLong = side === "long";
  const setIsLong = (v: boolean) => onSide(v ? "long" : "short");
  const [input, setInput] = useState("");
  const [leverage, setLeverage] = useState<number>(3);
  const [slippage, setSlippage] = useState<number>(SLIPPAGES_BPS[1]);
  useEffect(() => tx.setPhase({ kind: "idle" }), [market.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cfg = market.config;
  const mark = wad(market.markPrice);
  const collateral = parseAmount(input, USDG_DECIMALS);
  const execFee = BigInt(o.params.minExecutionFee);
  const maxLev = cfg ? cfg.maxLeverageBps / 10_000 : 1;
  const levs = LEVERAGES.filter((l) => l <= maxLev);
  const p = cfg && collateral && mark ? previewOpen(cfg, isLong, collateral, leverage, mark) : null;
  const limit = mark ? acceptablePrice(mark, isLong, slippage) : null;
  const total = collateral !== null ? collateral + execFee : null;

  const usdgAsset = shielded ? vault.status?.assets.find((a) => USDG && a.address.toLowerCase() === USDG.toLowerCase()) : undefined;
  const bal = shielded ? (usdgAsset && vault.phase === "unlocked" ? balances(usdgAsset.resource).spendable : undefined) : wallet.get(USDG).balance;
  const allowance = wallet.get(USDG).allowance;

  const oiSide = market.state ? BigInt(isLong ? market.state.oiLong : market.state.oiShort) : 0n;
  const oiCap = cfg ? BigInt(isLong ? cfg.maxOpenInterestLong : cfg.maxOpenInterestShort) : 0n;
  const capacityLeft = o.vault.capacity !== null ? BigInt(o.vault.capacity) - BigInt(o.params.totalReserved) : null;
  const blocked = !cfg || !cfg.enabled
    ? "Market closed"
    : !mark
      ? "Waiting for a price"
      : !collateral || collateral === 0n
        ? "Enter margin"
        : collateral < BigInt(cfg.minCollateral) + p!.openFee
          ? `Minimum ${usd(BigInt(cfg.minCollateral) + p!.openFee)} ${SYMBOL}`
          : bal !== undefined && total! > bal
            ? `Not enough ${SYMBOL}`
            : oiSide + p!.size > oiCap
              ? "Above the open interest cap"
              : capacityLeft !== null && p!.maxProfit > capacityLeft
                ? "Vault has no room for this size"
                : null;
  /** The button text in Chinese; the English text above also drives the faucet hint. */
  const say = (b: string) => {
    const zh: Record<string, string> = { "Market closed": "市场已关闭", "Waiting for a price": "等待价格", "Enter margin": "请输入保证金", "Above the open interest cap": "超过未平仓量上限", "Vault has no room for this size": "金库没有足够空间承接该规模" };
    if (zh[b]) return t(b, zh[b]);
    if (b.startsWith("Minimum ")) return t(b, `最低 ${b.slice(8)}`);
    if (b.startsWith("Not enough ")) return t(b, `${b.slice(11)} 余额不足`);
    return b;
  };

  async function open() {
    if (blocked || !p || !limit || !PERP_ENGINE || !USDG || !collateral) return;
    const steps: TxStep[] = [];
    if ((allowance ?? 0n) < total!) {
      steps.push({ label: t(`Approve ${usd(total)} ${SYMBOL} for the perps engine`, `授权永续合约引擎使用 ${usd(total)} ${SYMBOL}`), params: { address: USDG, abi: erc20Abi, functionName: "approve", args: [PERP_ENGINE, total!], chainId: curveilChain.id } });
    }
    steps.push({
      label: t(`Request ${isLong ? "long" : "short"} ${market.symbol}`, `请求${isLong ? "做多" : "做空"} ${market.symbol}`),
      params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "requestOpen", args: [market.id, isLong, p.size, collateral, limit, execFee], chainId: curveilChain.id } as never,
    });
    const r = await tx.run(steps);
    if (r) {
      kickKeeper();
      setInput("");
      void wallet.refetch();
      void qc.invalidateQueries({ queryKey: ["perp-positions"] });
    }
  }

  const pct = (f: number) => {
    if (bal === undefined || bal <= execFee) return;
    const free = bal - execFee;
    setInput(formatUnits((free * BigInt(f)) / 100n, USDG_DECIMALS));
  };

  return (
    <>
      <div className="px-chips">
        <span className="px-chip" title={t("Each position has its own margin. A loss can never take more than that position's margin.", "每个仓位有独立的保证金。亏损永远不会超过该仓位的保证金。")}>{t("Isolated", "逐仓")}</span>
        <span className="px-chip">{t("Market", "市价")}</span>
        <span className="px-chip mono" title={t("Most leverage this market allows", "该市场允许的最大杠杆")}>{t(`Up to ${maxLev}×`, `最高 ${maxLev}×`)}</span>
      </div>
      <div className="seg side-seg px-side-seg" role="group" aria-label={t("Side", "方向")} style={{ marginTop: 0 }}>
        <button type="button" aria-pressed={isLong} data-side="long" onClick={() => setIsLong(true)}>{t("Long", "做多")}</button>
        <button type="button" aria-pressed={!isLong} data-side="short" onClick={() => setIsLong(false)}>{t("Short", "做空")}</button>
      </div>
      <div className="px-avail">
        <span>{t("Available", "可用")}</span>
        <span className="mono">{bal !== undefined ? `${usd(bal)} ${SYMBOL}` : "–"}</span>
      </div>
      <AmountField
        label={t("Margin", "保证金")}
        value={input}
        onChange={setInput}
        symbol={SYMBOL}
        decimals={USDG_DECIMALS}
        error={bal !== undefined && total !== null && collateral && total > bal ? t(`Margin plus the ${usd(execFee)} ${SYMBOL} keeper fee is more than your ${shielded ? "vault" : "wallet"} balance`, `保证金加上 ${usd(execFee)} ${SYMBOL} 执行者费用超过你的${shielded ? "金库" : "钱包"}余额`) : null}
      >
        <span className="token-tag">{SYMBOL}</span>
      </AmountField>
      <div className="px-pcts" role="group" aria-label={t("Share of available balance", "可用余额比例")}>
        {[25, 50, 75, 100].map((f) => <button key={f} type="button" onClick={() => pct(f)} disabled={bal === undefined}>{f}%</button>)}
      </div>
      <div className="px-field">
        <div className="px-field-top"><span>{t("Leverage", "杠杆")}</span><span className="mono">{leverage}×</span></div>
        <div className="px-levs" role="group" aria-label={t("Leverage", "杠杆")}>
          {levs.map((l) => <button key={l} type="button" aria-pressed={leverage === l} onClick={() => setLeverage(l)}>{l}×</button>)}
        </div>
      </div>
      <div className="px-field">
        <div className="px-field-top">
          <span title={t("If the price moves more than this before the keeper fills, the request is cancelled and your margin comes back.", "如果在执行者成交前价格变动超过此幅度，请求会被取消，保证金退回。")}>{t("Max slippage", "最大滑点")}</span>
          <div className="px-levs px-slip" role="group" aria-label={t("Max slippage", "最大滑点")}>
            {SLIPPAGES_BPS.map((b) => <button key={b} type="button" aria-pressed={slippage === b} onClick={() => setSlippage(b)}>{b / 100}%</button>)}
          </div>
        </div>
      </div>
      {shielded ? (
        <VaultGate v={vault}>
          {(status) => (
            <ShieldedPerpOpen
              status={status}
              market={market}
              isLong={isLong}
              size={p?.size ?? 0n}
              collateral={collateral ?? 0n}
              acceptable={limit ?? 0n}
              execFee={execFee}
              blocked={blocked && say(blocked)}
              onDone={() => {
                setInput("");
                kickKeeper();
              }}
            />
          )}
        </VaultGate>
      ) : (
        <>
          <WalletAction verb={t("trade perps", "交易永续合约")}>
            <button className={`btn btn-block px-submit side-${isLong ? "long" : "short"}`} disabled={Boolean(blocked) || tx.busy} onClick={open}>
              {tx.busy ? t("Check your wallet…", "请在钱包中确认…") : blocked ? say(blocked) : t(`${(allowance ?? 0n) < (total ?? 0n) ? "Approve and " : ""}${isLong ? "long" : "short"} ${market.base} ${leverage}×`, `${(allowance ?? 0n) < (total ?? 0n) ? "授权并" : ""}${isLong ? "做多" : "做空"} ${market.base} ${leverage}×`)}
            </button>
          </WalletAction>
          {blocked === `Not enough ${SYMBOL}` && IS_TESTNET && (
            <p className="small muted" style={{ margin: 0 }}>{t(<>Test {SYMBOL} is free from the <Link to="/docs" search={{ page: "testnet" }} hash="faucet">testnet faucet</Link>.</>, <>可以从<Link to="/docs" search={{ page: "testnet" }} hash="faucet">测试网水龙头</Link>免费领取测试 {SYMBOL}。</>)}</p>
          )}
          <TxStatus phase={tx.phase} />
        </>
      )}
      <dl className="px-rows">
        <div><dt>{t("Liquidation price", "强平价格")}</dt><dd className="mono warn-text">{p?.liquidationPrice !== undefined && p?.liquidationPrice !== null ? fmtUsdPrice(p.liquidationPrice) : "–"}</dd></div>
        <div><dt>{t("Order value", "订单价值")}</dt><dd className="mono">{p ? `${usd(p.size)} ${SYMBOL}` : "–"}</dd></div>
        <div><dt>{t("Margin", "保证金")}</dt><dd className="mono">{collateral ? `${usd(collateral)} ${SYMBOL}` : "–"}</dd></div>
        <div><dt>{t("Fill no worse than", "成交价不差于")}</dt><dd className="mono">{fmtUsdPrice(limit)}</dd></div>
        <div><dt>{t("Fees", "手续费")}</dt><dd className="mono" title={t(`Open fee ${fmtBps(cfg?.openFeeBps)} of size, plus the keeper fee`, `开仓手续费为仓位规模的 ${fmtBps(cfg?.openFeeBps)}，另加执行者费用`)}>{p ? `${usd(p.openFee + execFee, 4)} ${SYMBOL}` : `${usd(execFee, 4)} ${SYMBOL}`}</dd></div>
        <div><dt>{t("Most it can gain", "最多可赚")}</dt><dd className="mono">{p ? `${usd(p.maxProfit)} ${SYMBOL}` : "–"}</dd></div>
        <div className="px-total"><dt>{t(`Total from your ${shielded ? "notes" : "wallet"}`, `从你的${shielded ? "票据" : "钱包"}中支出合计`)}</dt><dd className="mono">{total !== null ? `${usd(total)} ${SYMBOL}` : "–"}</dd></div>
      </dl>
      <p className="px-note">
        {t(`A keeper fills your request at the next signed price, usually within seconds. Minimum margin ${cfg ? usd(BigInt(cfg.minCollateral)) : "–"} ${SYMBOL} plus the open fee. Closing costs ${fmtBps(cfg?.closeFeeBps)} of size.`, `执行者会以下一个签名价格成交你的请求，通常只需几秒。最低保证金 ${cfg ? usd(BigInt(cfg.minCollateral)) : "–"} ${SYMBOL}，另加开仓手续费。平仓费用为仓位规模的 ${fmtBps(cfg?.closeFeeBps)}。`)}
      </p>
    </>
  );
}

export function fundingText(m: PerpMarket): string {
  const r = Number(m.fundingRatePerHour);
  if (!Number.isFinite(r) || r === 0) return tNow("nobody pays (balanced or empty)", "无人支付（多空平衡或无持仓）");
  return tNow(`${r > 0 ? "longs pay shorts" : "shorts pay longs"} ${(Math.abs(r) * 100).toFixed(4)}% of size per hour`, `${r > 0 ? "多头向空头" : "空头向多头"}每小时支付仓位规模的 ${(Math.abs(r) * 100).toFixed(4)}%`);
}

// ------------------------------------------------------------------ positions, orders, history, trades

function AccountTabs({ o, market, shielded, vault }: { o: PerpsOverview; market: PerpMarket; shielded: boolean; vault: ReturnType<typeof useShieldedVault> }) {
  const tr = useT();
  const { address } = useConnection();
  const positions = usePerpPositions(shielded ? undefined : address);
  const orders = usePerpOrders(shielded ? undefined : address);
  const [tab, setTab] = useState<AccountTab>("info");
  const list = positions.data?.positions ?? [];
  const live = list.filter((p) => p.status === "open" || p.status === "pending");
  const done = list.filter((p) => p.status !== "open" && p.status !== "pending").slice(0, 20);
  const pending = (positions.data?.requests ?? []).filter((r) => r.outcome === null);
  const settled = (positions.data?.requests ?? []).filter((r) => r.outcome !== null).slice(0, 30);
  const active = (orders.data?.orders ?? []).filter((x) => x.status === "active");
  type Tab = [AccountTab, string, number | null];
  const tabs: Tab[] = [
    ["info", tr("Market info", "市场信息"), null],
    ...(shielded
      ? ([["positions", tr("Shielded positions", "隐私仓位"), null]] as Tab[])
      : ([["positions", tr("Positions", "仓位"), live.length || null], ["pending", tr("Pending", "待执行"), pending.length || null], ["orders", tr("TP / SL", "止盈 / 止损"), active.length || null], ["history", tr("History", "历史"), null]] as Tab[])),
    ["trades", tr("Market trades", "市场成交"), null],
  ];
  const shown = tabs.some(([t]) => t === tab) ? tab : "info";
  const account = shown !== "trades" && shown !== "info";
  return (
    <section className="tk-tabs px-account" aria-label={tr("Positions, orders and trades", "仓位、订单和成交")}>
      <div className="tk-tablist" role="tablist">
        {tabs.map(([t, label, n]) => (
          <button key={t} type="button" role="tab" aria-selected={shown === t} onClick={() => setTab(t)}>
            {label}{n !== null && <span className="tk-count">{n}</span>}
          </button>
        ))}
        {shown === "trades" && <span className="tk-tab-note">{tr(`${market.symbol}, newest first`, `${market.symbol}，最新在前`)}</span>}
      </div>
      {shown === "trades" ? (
        <Trades market={market} />
      ) : shown === "info" ? (
        <div className="pxt-pad pxt-info">
          <OpenInterest market={market} />
          <MarketFacts o={o} market={market} />
          <ModuleStatus id="perps" />
        </div>
      ) : shielded ? (
        <VaultGate v={vault}>{(status) => <ShieldedPerpPositions v={vault} status={status} o={o} />}</VaultGate>
      ) : !address && account ? (
        <div className="px-empty"><WalletAction verb={tr("see your positions", "查看你的仓位")}><span /></WalletAction></div>
      ) : positions.isError ? (
        <p className="notice bad" role="alert">{tr("Positions could not be loaded. They are safe on-chain; try again shortly.", "无法加载仓位。它们在链上是安全的，请稍后重试。")}</p>
      ) : (
        <>
          {shown === "positions" && <PositionsTable loading={positions.isLoading} live={live} o={o} orders={active} />}
          {shown === "pending" && (pending.length ? <PendingRequests requests={pending} o={o} /> : <p className="small muted px-empty">{tr("No requests waiting for the keeper.", "没有等待执行者处理的请求。")}</p>)}
          {shown === "orders" && <AllOrders orders={active} o={o} positions={live} />}
          {shown === "history" && <History positions={done} requests={settled} o={o} />}
        </>
      )}
    </section>
  );
}

function PositionsTable({ loading, live, o, orders }: { loading: boolean; live: LivePosition[]; o: PerpsOverview; orders: OrderRow[] }) {
  const t = useT();
  const [open, setOpen] = useState<{ id: string; action: PosAction } | null>(null);
  if (loading) return <><Loading label={t("Loading your positions", "正在加载你的仓位")} /><div className="table-scroll" tabIndex={0}><table className="data px-table"><tbody><SkRows cols={9} rows={2} /></tbody></table></div></>;
  if (live.length === 0) return <p className="small muted px-empty">{t("No open positions. Pick a side and margin in the order panel to open one.", "没有持仓。在下单面板中选择方向和保证金即可开仓。")}</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data px-table">
        <thead>
          <tr>
            <th>{t("Market", "市场")}</th><th className="num">{t("Size", "仓位规模")}</th><th className="num">{t("Margin", "保证金")}</th><th className="num">{t("Entry", "开仓价")}</th><th className="num">{t("Mark", "标记价")}</th><th className="num">{t("Liq. price", "强平价")}</th><th className="num">{t("PnL", "盈亏")}</th><th>{t("TP / SL", "止盈 / 止损")}</th><th />
          </tr>
        </thead>
        <tbody>
          {live.map((p) => {
            const m = o.markets.find((x) => x.id === p.market);
            const v = p.valuation;
            const net = v ? BigInt(v.pnl) - BigInt(v.funding) : null;
            const lev = BigInt(p.collateral) > 0n ? Number((BigInt(p.size) * 100n) / BigInt(p.collateral)) / 100 : null;
            const mine = orders.filter((x) => x.position_id === p.id);
            const tp = mine.find((x) => x.kind === "take_profit");
            const sl = mine.find((x) => x.kind === "stop_loss");
            const roe = net !== null && BigInt(p.collateral) > 0n ? Number((net * 10_000n) / BigInt(p.collateral)) / 100 : null;
            const act = open?.id === p.id ? open.action : null;
            const toggle = (a: PosAction) => setOpen(act === a ? null : { id: p.id, action: a });
            return (
              <Fragment key={p.id}>
                <tr className={act ? "px-row-open" : undefined}>
                  <td>
                    <span className="px-mk">
                      <strong>{m?.base ?? p.symbol}</strong>
                      <span className={p.isLong ? "good-text" : "bad-text"}>{p.isLong ? t("Long", "做多") : t("Short", "做空")}{lev !== null && p.status === "open" ? ` ${lev.toFixed(1)}×` : ""}</span>
                    </span>
                  </td>
                  <td className="num mono">{usd(p.size)}</td>
                  <td className="num mono">{usd(p.collateral)}</td>
                  <td className="num mono">{p.status === "open" ? fmtUsdPrice(BigInt(p.entryPrice)) : "–"}</td>
                  <td className="num mono">{fmtUsdPrice(p.markPrice ? BigInt(p.markPrice) : null)}</td>
                  <td className={`num mono ${v?.liquidatable ? "bad-text" : "warn-text"}`}>{v ? fmtUsdPrice(BigInt(v.liquidationPrice)) : "–"}</td>
                  <td className={`num mono ${net === null || signedUsd(net) === "0.00" ? "" : net < 0n ? "bad-text" : "good-text"}`}>
                    {signedUsd(net)}{roe !== null && <span className="px-roe"> ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)</span>}
                  </td>
                  <td className="mono small">{tp ? fmtUsdPrice(BigInt(tp.trigger_price)) : "–"} / {sl ? fmtUsdPrice(BigInt(sl.trigger_price)) : "–"}</td>
                  <td>
                    {p.status === "pending" ? (
                      <span className="small muted">{t("Opening…", "开仓中…")}</span>
                    ) : (
                      <span className="px-acts">
                        <button type="button" className="btn btn-sm" aria-pressed={act === "close"} onClick={() => toggle("close")}>{p.pendingClose !== "0" ? t("Closing…", "平仓中…") : t("Close", "平仓")}</button>
                        <button type="button" className="btn btn-sm" aria-pressed={act === "margin"} onClick={() => toggle("margin")}>{t("Margin", "保证金")}</button>
                        <button type="button" className="btn btn-sm" aria-pressed={act === "orders"} onClick={() => toggle("orders")}>{t("TP/SL", "止盈/止损")}</button>
                      </span>
                    )}
                  </td>
                </tr>
                {act && m && (
                  <tr className="px-row-form">
                    <td colSpan={9}>
                      <div className="px-row-form-in">
                        {act === "close" && <CloseForm p={p} m={m} o={o} />}
                        {act === "margin" && <MarginForm p={p} />}
                        {act === "orders" && <OrdersForm p={p} m={m} o={o} orders={mine} />}
                      </div>
                    </td>
                  </tr>
                )}
                {v?.liquidatable && (
                  <tr><td colSpan={9}><p className="notice bad small" style={{ margin: 0 }}>{t(`Position #${p.id} is below maintenance margin at the mark price and can be liquidated now. Add margin or close it.`, `按标记价格计算，仓位 #${p.id} 已低于维持保证金，现在可能被强平。请追加保证金或平仓。`)}</p></td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AllOrders({ orders, o, positions }: { orders: OrderRow[]; o: PerpsOverview; positions: LivePosition[] }) {
  const t = useT();
  const tx = useTxRunner();
  const qc = useQueryClient();
  if (orders.length === 0) return <p className="small muted px-empty">{t("No take-profit or stop-loss orders. Add one from a position's TP/SL button.", "没有止盈或止损订单。可以通过仓位的“止盈/止损”按钮添加。")}</p>;
  async function cancel(id: string) {
    if (!ORDER_MANAGER) return;
    if (await tx.run([{ label: t("Cancel order", "取消订单"), params: { address: ORDER_MANAGER, abi: orderManagerAbi, functionName: "cancel", args: [BigInt(id)], chainId: curveilChain.id } as never }]))
      void qc.invalidateQueries({ queryKey: ["perp-orders"] });
  }
  return (
    <>
      <div className="table-scroll" tabIndex={0}>
        <table className="data px-table">
          <thead><tr><th>{t("Market", "市场")}</th><th>{t("Type", "类型")}</th><th className="num">{t("Trigger", "触发价")}</th><th className="num">{t("Size", "仓位规模")}</th><th>{t("Position", "仓位")}</th><th /></tr></thead>
          <tbody>
            {orders.map((x) => {
              const p = positions.find((y) => y.id === x.position_id);
              const m = p ? o.markets.find((y) => y.id === p.market) : undefined;
              return (
                <tr key={x.order_id}>
                  <td><span className="px-mk"><strong>{m?.base ?? "–"}</strong>{p && <span className={p.isLong ? "good-text" : "bad-text"}>{p.isLong ? t("Long", "做多") : t("Short", "做空")}</span>}</span></td>
                  <td>{x.kind === "take_profit" ? t("Take-profit", "止盈") : t("Stop-loss", "止损")}</td>
                  <td className="num mono">{fmtUsdPrice(BigInt(x.trigger_price))}</td>
                  <td className="num mono">{x.size === "0" ? t("Whole position", "整个仓位") : `${usd(x.size)} ${SYMBOL}`}</td>
                  <td className="mono small">#{x.position_id}</td>
                  <td><button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => cancel(x.order_id)}>{t("Cancel", "取消")}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TxStatus phase={tx.phase} />
    </>
  );
}

function PendingRequests({ requests, o }: { requests: RequestRow[]; o: PerpsOverview }) {
  const t = useT();
  const tx = useTxRunner();
  const qc = useQueryClient();
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="stack">
      {requests.map((r) => {
        const canCancel = now > r.created_at + o.params.requestTimeout;
        const m = o.markets.find((x) => x.id === r.market_id);
        return (
          <div key={r.request_id} className="notice">
            <span className="dot warn" style={{ marginTop: 7 }} aria-hidden="true" />
            <div className="stack" style={{ gap: 6, flex: 1 }}>
              <span>
                {t(`${r.kind === "open" ? "Opening" : "Closing"} ${r.is_long ? "long" : "short"} ${m?.symbol ?? ""} · ${usd(r.size)} ${SYMBOL} · waiting for the keeper (${timeAgo(r.created_at)})`, `${r.kind === "open" ? "开仓" : "平仓"}${r.is_long ? "多单" : "空单"} ${m?.symbol ?? ""} · ${usd(r.size)} ${SYMBOL} · 等待执行者处理（${timeAgo(r.created_at)}）`)}
              </span>
              {canCancel && PERP_ENGINE && (
                <div>
                  <button
                    className="btn btn-sm"
                    disabled={tx.busy}
                    onClick={async () => {
                      const ok = await tx.run([{ label: t("Cancel request", "取消请求"), params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "cancelRequest", args: [BigInt(r.request_id)], chainId: curveilChain.id } as never }]);
                      if (ok) void qc.invalidateQueries({ queryKey: ["perp-positions"] });
                    }}
                  >
                    {t("Cancel for a full refund", "取消并全额退款")}
                  </button>
                  <TxStatus phase={tx.phase} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type PosAction = "close" | "margin" | "orders";

/** Size, collateral, entry, mark, PnL net of funding, liquidation price. Shared with shielded claims. */
export function PositionSummary({ p, m, tag }: { p: LivePosition; m: PerpMarket | undefined; tag?: ReactNode }) {
  const t = useT();
  const v = p.valuation;
  const net = v ? BigInt(v.pnl) - BigInt(v.funding) : null;
  const lev = BigInt(p.collateral) > 0n ? Number((BigInt(p.size) * 100n) / BigInt(p.collateral)) / 100 : null;
  return (
    <>
      <div className="row-between">
        <span className="row-between" style={{ gap: 8 }}>
          <strong>{m?.symbol ?? t(`Market ${p.market}`, `市场 ${p.market}`)}</strong>
          <span className={`tag ${p.isLong ? "tag-live" : "tag-short"}`}>{p.isLong ? t("Long", "做多") : t("Short", "做空")}</span>
          {lev !== null && p.status === "open" && <span className="small muted mono">{lev.toFixed(2)}×</span>}
          {tag}
        </span>
        <span className="small muted mono">#{p.id}</span>
      </div>
      {p.status === "open" ? (
        <dl className="kv stats">
          <div><dt>{t("Size", "仓位规模")}</dt><dd className="mono">{usd(p.size)}</dd></div>
          <div><dt>{t("Collateral", "保证金")}</dt><dd className="mono">{usd(p.collateral)}</dd></div>
          <div><dt>{t("PnL after funding", "扣除资金费后的盈亏")}</dt><dd className={`mono ${net === null || signedUsd(net) === "0.00" ? "" : net < 0n ? "bad-text" : "good-text"}`}>{signedUsd(net)}</dd></div>
          <div><dt>{t("Entry", "开仓价")}</dt><dd className="mono">{fmtUsdPrice(BigInt(p.entryPrice))}</dd></div>
          <div><dt>{t("Mark", "标记价")}</dt><dd className="mono">{fmtUsdPrice(p.markPrice ? BigInt(p.markPrice) : null)}</dd></div>
          <div><dt>{t("Liquidation", "强平价")}</dt><dd className={`mono ${v?.liquidatable ? "bad-text" : "warn-text"}`}>{v ? fmtUsdPrice(BigInt(v.liquidationPrice)) : "–"}</dd></div>
        </dl>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {p.status === "pending" ? t("Open request waiting.", "开仓请求等待中。") : t(`Position ${p.status}. Paid out ${usd(p.paidOut)} ${SYMBOL}.`, `仓位${STATUS_ZH[p.status] ?? p.status}。已支付 ${usd(p.paidOut)} ${SYMBOL}。`)}
        </p>
      )}
      {v?.liquidatable && <p className="notice bad small" style={{ margin: 0 }}>{t("This position is below maintenance margin at the mark price and can be liquidated now.", "按标记价格计算，该仓位已低于维持保证金，现在可能被强平。")}</p>}
    </>
  );
}

const FRACTIONS = [25, 50, 100] as const;
const STATUS_ZH: Record<string, string> = { open: "持仓中", pending: "待开仓", closed: "已平仓", liquidated: "已强平" };

function CloseForm({ p, m, o }: { p: LivePosition; m: PerpMarket; o: PerpsOverview }) {
  const t = useT();
  const tx = useTxRunner();
  const qc = useQueryClient();
  const [pct, setPct] = useState<number>(100);
  const [slippage, setSlippage] = useState<number>(SLIPPAGES_BPS[1]);
  const mark = wad(m.markPrice);
  const size = (BigInt(p.size) * BigInt(pct)) / 100n;
  const limit = mark ? acceptablePrice(mark, !p.isLong, slippage) : null;
  const execFee = BigInt(o.params.minExecutionFee);
  async function go() {
    if (!PERP_ENGINE || !limit) return;
    const r = await tx.run([
      { label: t(`Request close of ${pct}%`, `请求平仓 ${pct}%`), params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "requestClose", args: [BigInt(p.id), size, limit, execFee], chainId: curveilChain.id } as never },
    ]);
    if (r) {
      kickKeeper();
      void qc.invalidateQueries({ queryKey: ["perp-positions"] });
    }
  }
  return (
    <CloseControls pct={pct} setPct={setPct} slippage={slippage} setSlippage={setSlippage} size={size} limit={limit} execFee={execFee} closeFeeBps={m.config?.closeFeeBps}>
      <WalletAction verb={t("close", "平仓")}>
        <button className="btn btn-primary btn-block" disabled={tx.busy || !limit || p.pendingClose !== "0"} onClick={go}>{tx.busy ? t("Check your wallet…", "请在钱包中确认…") : p.pendingClose !== "0" ? t("Waiting for the keeper…", "等待执行者处理…") : t(`Close ${pct}%`, `平仓 ${pct}%`)}</button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </CloseControls>
  );
}

export function CloseControls({ pct, setPct, slippage, setSlippage, size, limit, execFee, closeFeeBps, children }: {
  pct: number;
  setPct: (n: number) => void;
  slippage: number;
  setSlippage: (n: number) => void;
  size: bigint;
  limit: bigint | null;
  execFee: bigint;
  closeFeeBps: number | undefined;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="stack">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="seg" role="group" aria-label={t("Share to close", "平仓比例")} style={{ marginTop: 0 }}>
          {FRACTIONS.map((f) => (
            <button key={f} type="button" aria-pressed={pct === f} onClick={() => setPct(f)}>{f}%</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t("Price limit", "价格限制")} style={{ marginTop: 0 }}>
          {SLIPPAGES_BPS.map((b) => (
            <button key={b} type="button" aria-pressed={slippage === b} onClick={() => setSlippage(b)}>{b / 100}%</button>
          ))}
        </div>
      </div>
      <dl className="rows">
        <div><dt>{t("Size to close", "平仓规模")}</dt><dd className="mono">{usd(size)} {SYMBOL}</dd></div>
        <div><dt>{t("Fill no worse than", "成交价不差于")}</dt><dd className="mono">{fmtUsdPrice(limit)}</dd></div>
        <div><dt>{t("Close fee + execution fee", "平仓手续费 + 执行费")}</dt><dd className="mono">{t(`${fmtBps(closeFeeBps)} of size + ${usd(execFee, 4)} ${SYMBOL}`, `仓位规模的 ${fmtBps(closeFeeBps)} + ${usd(execFee, 4)} ${SYMBOL}`)}</dd></div>
      </dl>
      {children}
    </div>
  );
}

function MarginForm({ p }: { p: LivePosition }) {
  const t = useT();
  const tx = useTxRunner();
  const qc = useQueryClient();
  const wallet = useWalletTokens([USDG], PERP_ENGINE);
  const [input, setInput] = useState("");
  const amount = parseAmount(input, USDG_DECIMALS);
  const bal = wallet.get(USDG).balance;
  const allowance = wallet.get(USDG).allowance ?? 0n;
  async function go() {
    if (!PERP_ENGINE || !USDG || !amount) return;
    const steps: TxStep[] = [];
    if (allowance < amount) steps.push({ label: t("Approve", "授权"), params: { address: USDG, abi: erc20Abi, functionName: "approve", args: [PERP_ENGINE, amount], chainId: curveilChain.id } });
    steps.push({ label: t("Add margin", "追加保证金"), params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "addCollateral", args: [BigInt(p.id), amount], chainId: curveilChain.id } as never });
    if (await tx.run(steps)) {
      setInput("");
      void wallet.refetch();
      void qc.invalidateQueries({ queryKey: ["perp-positions"] });
    }
  }
  const short = amount !== null && bal !== undefined && amount > bal;
  return (
    <div className="stack">
      <AmountField label={t("Add collateral", "追加保证金")} value={input} onChange={setInput} symbol={SYMBOL} decimals={USDG_DECIMALS} balance={bal !== undefined ? usd(bal) : undefined} onMax={() => bal !== undefined && setInput(formatUnits(bal, USDG_DECIMALS))}>
        <span className="token-tag">{SYMBOL}</span>
      </AmountField>
      <p className="small muted" style={{ margin: 0 }}>{t("Adding margin lowers leverage and moves the liquidation price away. It needs no price, so it applies at once.", "追加保证金会降低杠杆，使强平价格远离当前价格。它不需要价格，因此立即生效。")}</p>
      <WalletAction verb={t("add margin", "追加保证金")}>
        <button className="btn btn-primary btn-block" disabled={tx.busy || !amount || short} onClick={go}>{short ? t(`Not enough ${SYMBOL}`, `${SYMBOL} 余额不足`) : tx.busy ? t("Check your wallet…", "请在钱包中确认…") : t("Add margin", "追加保证金")}</button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </div>
  );
}

function OrdersForm({ p, m, o, orders }: { p: LivePosition; m: PerpMarket; o: PerpsOverview; orders: OrderRow[] }) {
  const t = useT();
  const tx = useTxRunner();
  const qc = useQueryClient();
  const form = useOrderForm(p, m, o);
  async function place() {
    if (!ORDER_MANAGER || !form.ready) return;
    const r = await tx.run([{ label: t(`Place ${form.kindLabel}`, `设置${form.kindLabel}`), params: { address: ORDER_MANAGER, abi: orderManagerAbi, functionName: "place", args: form.args, chainId: curveilChain.id } as never }]);
    if (r) {
      form.reset();
      void qc.invalidateQueries({ queryKey: ["perp-orders"] });
    }
  }
  async function cancel(id: string) {
    if (!ORDER_MANAGER) return;
    if (await tx.run([{ label: t("Cancel order", "取消订单"), params: { address: ORDER_MANAGER, abi: orderManagerAbi, functionName: "cancel", args: [BigInt(id)], chainId: curveilChain.id } as never }]))
      void qc.invalidateQueries({ queryKey: ["perp-orders"] });
  }
  return (
    <div className="stack">
      <OrderList orders={orders} onCancel={cancel} busy={tx.busy} />
      <OrderFields form={form} />
      <WalletAction verb={t("place orders", "下单")}>
        <button className="btn btn-primary btn-block" disabled={tx.busy || !form.ready} onClick={place}>{tx.busy ? t("Check your wallet…", "请在钱包中确认…") : form.problem ?? t(`Place ${form.kindLabel}`, `设置${form.kindLabel}`)}</button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </div>
  );
}

/** Take-profit / stop-loss form state. A stop-loss fills at any price once triggered; a take-profit within the limit. */
export function useOrderForm(p: LivePosition, m: PerpMarket, o: PerpsOverview) {
  const tr = useT();
  const [kind, setKind] = useState<1 | 2>(1);
  const [trigger, setTrigger] = useState("");
  const [pct, setPct] = useState<number>(100);
  const t = wad(trigger.trim() || null);
  const mark = wad(m.markPrice);
  const execFee = BigInt(o.params.minExecutionFee);
  const size = pct === 100 ? 0n : (BigInt(p.size) * BigInt(pct)) / 100n;
  // Take-profit: fill within 1% of the trigger. Stop-loss: any price, so it always exits.
  const limit = kind === 1 && t ? acceptablePrice(t, !p.isLong, 100) : p.isLong ? 0n : maxUint256;
  const favourable = (above: boolean) => (t && mark ? (above ? t > mark : t < mark) : true);
  const problem = !t
    ? tr("Enter a trigger price", "请输入触发价格")
    : kind === 1 && !favourable(p.isLong)
      ? tr(`Take-profit must be ${p.isLong ? "above" : "below"} the mark`, `止盈价必须${p.isLong ? "高于" : "低于"}标记价`)
      : kind === 2 && !favourable(!p.isLong)
        ? tr(`Stop-loss must be ${p.isLong ? "below" : "above"} the mark`, `止损价必须${p.isLong ? "低于" : "高于"}标记价`)
        : null;
  return {
    kind,
    setKind,
    trigger,
    setTrigger,
    pct,
    setPct,
    execFee,
    limit,
    problem,
    ready: problem === null,
    kindLabel: kind === 1 ? tr("take-profit", "止盈") : tr("stop-loss", "止损"),
    args: [BigInt(p.id), kind, t ?? 0n, size, limit, execFee, 0n] as const,
    body: { kind, triggerPrice: t ?? 0n, size, acceptablePrice: limit, executionFee: execFee, expiresAt: 0n },
    reset: () => setTrigger(""),
  };
}

export function OrderFields({ form }: { form: ReturnType<typeof useOrderForm> }) {
  const t = useT();
  return (
    <>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="seg" role="group" aria-label={t("Order kind", "订单类型")} style={{ marginTop: 0 }}>
          <button type="button" aria-pressed={form.kind === 1} onClick={() => form.setKind(1)}>{t("Take-profit", "止盈")}</button>
          <button type="button" aria-pressed={form.kind === 2} onClick={() => form.setKind(2)}>{t("Stop-loss", "止损")}</button>
        </div>
        <div className="seg" role="group" aria-label={t("Share to close", "平仓比例")} style={{ marginTop: 0 }}>
          {FRACTIONS.map((f) => (
            <button key={f} type="button" aria-pressed={form.pct === f} onClick={() => form.setPct(f)}>{f}%</button>
          ))}
        </div>
      </div>
      <AmountField label={t("Trigger price (USD)", "触发价格（USD）")} value={form.trigger} onChange={form.setTrigger} decimals={18}>
        <span className="token-tag">USD</span>
      </AmountField>
      <p className="small muted" style={{ margin: 0 }}>
        {form.kind === 1 ? t("Fills within 1% of the trigger.", "在触发价 1% 范围内成交。") : t("Fills at the first price past the trigger, whatever it is, so the exit is certain.", "以越过触发价后的第一个价格成交，无论是多少，确保一定能退出。")} {t(`The keeper earns ${usd(form.execFee, 4)} ${SYMBOL} from the proceeds when it fills.`, `成交时执行者从所得中获得 ${usd(form.execFee, 4)} ${SYMBOL}。`)}
      </p>
    </>
  );
}

export function OrderList({ orders, onCancel, busy }: { orders: OrderRow[]; onCancel: (id: string) => void; busy: boolean }) {
  const t = useT();
  if (orders.length === 0) return <p className="small muted" style={{ margin: 0 }}>{t("No active orders on this position.", "该仓位没有生效中的订单。")}</p>;
  return (
    <ul className="activity-list">
      {orders.map((x) => (
        <li key={x.order_id}>
          <span className="mono small">
            {x.kind === "take_profit" ? t("Take-profit", "止盈") : t("Stop-loss", "止损")} {t("at", "于")} {fmtUsdPrice(BigInt(x.trigger_price))} · {x.size === "0" ? t("whole position", "整个仓位") : `${usd(x.size)} ${SYMBOL}`}
          </span>
          <button className="btn btn-sm" disabled={busy} onClick={() => onCancel(x.order_id)}>{t("Cancel", "取消")}</button>
        </li>
      ))}
    </ul>
  );
}

function History({ positions, requests, o }: { positions: LivePosition[]; requests: RequestRow[]; o: PerpsOverview }) {
  const t = useT();
  if (positions.length === 0 && requests.length === 0) return <p className="small muted px-empty">{t("No settled requests or closed positions yet.", "还没有已结算的请求或已平仓的仓位。")}</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data px-table">
        <thead><tr><th>{t("Time", "时间")}</th><th>{t("Market", "市场")}</th><th>{t("Action", "操作")}</th><th className="num">{t("Size", "仓位规模")}</th><th>{t("Result", "结果")}</th><th>{t("Tx", "交易")}</th></tr></thead>
        <tbody>
          {requests.map((r) => {
            const m = o.markets.find((x) => x.id === r.market_id);
            return (
              <tr key={r.request_id}>
                <td className="small muted">{timeAgo(r.settled_at ?? r.created_at)}</td>
                <td><span className="px-mk"><strong>{m?.base ?? "–"}</strong><span className={r.is_long ? "good-text" : "bad-text"}>{r.is_long ? t("Long", "做多") : t("Short", "做空")}</span></span></td>
                <td>{r.kind === "open" ? t("Open", "开仓") : t("Close", "平仓")}</td>
                <td className="num mono">{usd(r.size)}</td>
                <td className="small">{r.outcome === "executed" ? <span className="good-text">{t("Filled at", "成交于")} {fmtUsdPrice(r.price ? BigInt(r.price) : null)}</span> : <span className="warn-text">{t("Cancelled:", "已取消：")} {t(REASON_TEXT[r.reason ?? ""], REASON_TEXT_ZH[r.reason ?? ""]) ?? r.reason}</span>}</td>
                <td className="mono small"><a href={explorerTx(r.tx_hash)} target="_blank" rel="noreferrer">{shortAddress(r.tx_hash)}</a></td>
              </tr>
            );
          })}
          {positions.map((p) => (
            <tr key={`p-${p.id}`}>
              <td className="small muted">–</td>
              <td><span className="px-mk"><strong>{p.symbol?.split("-")[0] ?? "–"}</strong><span className={p.isLong ? "good-text" : "bad-text"}>{p.isLong ? t("Long", "做多") : t("Short", "做空")}</span></span></td>
              <td>{t(`Position #${p.id} ${p.status}`, `仓位 #${p.id} ${STATUS_ZH[p.status] ?? p.status}`)}</td>
              <td className="num mono">–</td>
              <td className="small">{t(`Paid out ${usd(p.paidOut)} ${SYMBOL}`, `已支付 ${usd(p.paidOut)} ${SYMBOL}`)}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ liquidity vault

function LiquidityVault({ o }: { o: PerpsOverview }) {
  const t = useT();
  const { address } = useConnection();
  const qc = useQueryClient();
  const tx = useTxRunner();
  const wallet = useWalletTokens([USDG], PERP_VAULT);
  const mine = usePerpVaultAccount(address);
  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  const [input, setInput] = useState("");
  const v = o.vault;
  const amount = parseAmount(input, tab === "deposit" ? USDG_DECIMALS : 18);
  const preview = useReadContract({
    address: PERP_VAULT,
    abi: perpVaultAbi,
    functionName: tab === "deposit" ? "previewDeposit" : "previewRedeem",
    args: [amount ?? 0n],
    chainId: curveilChain.id,
    query: { enabled: Boolean(amount && amount > 0n), refetchInterval: 10_000 },
  });
  const out = preview.data as bigint | undefined;
  const util = v.balance && BigInt(v.balance) > 0n ? Number((BigInt(o.params.totalReserved) * 10_000n) / BigInt(v.balance)) / 100 : 0;
  const shares = mine.data ? BigInt(mine.data.shares) : 0n;
  const unlockAt = mine.data?.unlockAt ?? 0;
  const locked = unlockAt > Date.now() / 1000;
  const bal = wallet.get(USDG).balance;
  const allowance = wallet.get(USDG).allowance ?? 0n;
  const problem = !amount || amount === 0n
    ? "Enter an amount"
    : tab === "deposit" && bal !== undefined && amount > bal
      ? `Not enough ${SYMBOL}`
      : tab === "redeem" && amount > shares
        ? "More than your shares"
        : tab === "redeem" && locked
          ? `Locked until ${new Date(unlockAt * 1000).toLocaleTimeString()}`
          : out === undefined
            ? preview.isError ? "The vault cannot price shares right now" : "Getting a quote…"
            : null;

  async function go() {
    if (problem || !PERP_VAULT || !USDG || !amount || out === undefined || !address) return;
    const min = (out * 995n) / 1000n;
    const steps: TxStep[] = [];
    if (tab === "deposit") {
      if (allowance < amount) steps.push({ label: t("Approve", "授权"), params: { address: USDG, abi: erc20Abi, functionName: "approve", args: [PERP_VAULT, amount], chainId: curveilChain.id } });
      steps.push({ label: t("Deposit", "存入"), params: { address: PERP_VAULT, abi: perpVaultAbi, functionName: "deposit", args: [amount, min], chainId: curveilChain.id } as never });
    } else {
      steps.push({ label: t("Redeem", "赎回"), params: { address: PERP_VAULT, abi: perpVaultAbi, functionName: "redeem", args: [amount, min, address], chainId: curveilChain.id } as never });
    }
    if (await tx.run(steps)) {
      setInput("");
      void wallet.refetch();
      void mine.refetch();
      void qc.invalidateQueries({ queryKey: ["perps"] });
    }
  }

  const lockText = v.lockSeconds >= 7_200 ? t(`${Math.round(v.lockSeconds / 3_600)} hours`, `${Math.round(v.lockSeconds / 3_600)} 小时`) : t(`${Math.round(v.lockSeconds / 60)} minutes`, `${Math.round(v.lockSeconds / 60)} 分钟`);
  const say = (x: string) => x === "Enter an amount" ? t(x, "请输入金额") : x === "More than your shares" ? t(x, "超过你的份额") : x === "The vault cannot price shares right now" ? t(x, "金库目前无法为份额定价") : x === "Getting a quote…" ? t(x, "正在获取报价…") : x.startsWith("Not enough ") ? t(x, `${x.slice(11)} 余额不足`) : x.startsWith("Locked until ") ? t(x, `锁定至 ${x.slice(13)}`) : x;
  return (
    <div className="swap-layout px-lp">
      <div className="panel stack">
        <div className="row-between">
          <p className="eyebrow" style={{ margin: 0 }}>{t("Liquidity vault", "流动性金库")}</p>
          <span className="tag tag-public">{t("Public", "公开")}</span>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {t("The vault is every trader's counterparty. It earns what traders lose, 80% of trading fees and the funding imbalance, and pays what they win. Share value moves with open positions.", "金库是所有交易者的对手方。它获得交易者的亏损、80% 的交易手续费和资金费差额，并支付交易者的盈利。份额价值随持仓变动。")}
        </p>
        <dl className="kv stats">
          <div><dt>{t("Value", "价值")}</dt><dd className="mono">{v.totalAssets !== null ? usd(v.totalAssets, 0) : t("pricing…", "定价中…")}</dd></div>
          <div><dt>{t("Share price", "份额价格")}</dt><dd className="mono">{v.sharePrice !== null ? v.sharePrice.toFixed(4) : "–"}</dd></div>
          <div><dt>{t("Reserved", "已预留")}</dt><dd className="mono">{util.toFixed(1)}%</dd></div>
        </dl>
        <dl className="rows">
          <div><dt>{t("Free to redeem", "可赎回")}</dt><dd className="mono">{usd(v.freeLiquidity, 0)} {SYMBOL}</dd></div>
          <div><dt>{t("Most it can reserve", "最多可预留")}</dt><dd className="mono">{t(`${fmtBps(v.maxUtilizationBps)} of its balance`, `其余额的 ${fmtBps(v.maxUtilizationBps)}`)}</dd></div>
          <div><dt>{t("Deposit lock", "存入锁定期")}</dt><dd>{lockText}</dd></div>
        </dl>
        {v.totalAssets === null && <p className="small muted" style={{ margin: 0 }}>{t("A market with open positions has no recent recorded price, so shares cannot be priced. The keeper records one every few minutes.", "有持仓的市场最近没有记录价格，因此无法为份额定价。执行者每隔几分钟会记录一次价格。")}</p>}
      </div>
      <div className="panel stack">
        <div className="seg fill" role="group" aria-label={t("Vault action", "金库操作")} style={{ marginTop: 0 }}>
          <button type="button" aria-pressed={tab === "deposit"} onClick={() => { setTab("deposit"); setInput(""); }}>{t("Deposit", "存入")}</button>
          <button type="button" aria-pressed={tab === "redeem"} onClick={() => { setTab("redeem"); setInput(""); }}>{t("Redeem", "赎回")}</button>
        </div>
        <AmountField
          label={tab === "deposit" ? t("Deposit", "存入") : t("Redeem shares", "赎回份额")}
          value={input}
          onChange={setInput}
          symbol={tab === "deposit" ? SYMBOL : "cvPLP"}
          decimals={tab === "deposit" ? USDG_DECIMALS : 18}
          balance={tab === "deposit" ? (bal !== undefined ? usd(bal) : undefined) : fmtAmount(shares, 18)}
          onMax={() => (tab === "deposit" ? bal !== undefined && setInput(formatUnits(bal, USDG_DECIMALS)) : setInput(formatUnits(shares, 18)))}
          balanceLabel={tab === "deposit" ? t("Balance", "余额") : t("Shares", "份额")}
          error={problem === `Not enough ${SYMBOL}` || problem === "More than your shares" ? say(problem) : null}
        >
          <span className="token-tag">{tab === "deposit" ? SYMBOL : "cvPLP"}</span>
        </AmountField>
        <dl className="rows summary">
          <div><dt>{tab === "deposit" ? t("Shares you get", "你获得的份额") : t(`${SYMBOL} you get`, `你获得的 ${SYMBOL}`)}</dt><dd className="mono">{out !== undefined ? (tab === "deposit" ? fmtAmount(out, 18) : usd(out)) : amount && preview.isLoading ? <Sk w="9ch" /> : "–"}</dd></div>
          <div><dt>{t("Your shares", "你的份额")}</dt><dd className="mono">{fmtAmount(shares, 18)} {mine.data?.value ? `≈ ${usd(mine.data.value)} ${SYMBOL}` : ""}</dd></div>
          {locked && <div><dt>{t("Unlocks", "解锁时间")}</dt><dd>{new Date(unlockAt * 1000).toLocaleString()}</dd></div>}
        </dl>
        <WalletAction verb={tab === "deposit" ? t("deposit", "存入") : t("redeem", "赎回")}>
          <button className="btn btn-primary btn-block" disabled={tx.busy || Boolean(problem)} onClick={go}>
            {tx.busy ? t("Check your wallet…", "请在钱包中确认…") : problem ? say(problem) : (tab === "deposit" ? (allowance < (amount ?? 0n) ? t("Approve and deposit", "授权并存入") : t("Deposit", "存入")) : t("Redeem", "赎回"))}
          </button>
        </WalletAction>
        <TxStatus phase={tx.phase} />
        <p className="small muted" style={{ margin: 0 }}>
          {t(`Deposits lock for ${lockText}. Redemptions are limited to ${SYMBOL} not reserved for open positions' maximum profit. Both reject a fill more than 0.5% below the quote.`, `存入后锁定 ${lockText}。赎回仅限未为持仓最大盈利预留的 ${SYMBOL}。两者都会拒绝低于报价 0.5% 以上的成交。`)}
        </p>
      </div>
    </div>
  );
}

export { usd as fmtUsdg, SYMBOL as USDG_SYMBOL, WAD as PRICE_ONE };
