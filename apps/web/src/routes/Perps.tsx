/**
 * Perps: isolated-margin long and short positions in USDG against the perps liquidity vault.
 * Opening and closing are requests that a keeper executes with a fresh oracle price within
 * seconds; anyone may execute them. Everything shown is read from the chain through the API.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Loading, Sk, SkRows } from "../components/Skeleton";
import { TvChart } from "../components/TvChart";
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

const USDG = QUOTE?.address as Address | undefined;
const SYMBOL = QUOTE?.symbol ?? "USDG";
const usd = (v: bigint | string | null | undefined, digits = 2) => (v === null || v === undefined ? "–" : fmtAmount(v, USDG_DECIMALS, digits));

export function Perps() {
  if (!PERPS_DEPLOYED || !USDG) {
    return (
      <ModuleGate id="perps" title="Perps" summary="Isolated-margin perpetuals in USDG with up to 5× leverage, funded publicly or from shielded notes." coming={[
        "Long and short positions with charges and liquidation price shown first",
        "Close in part or in full, add margin, and set take-profit and stop-loss orders",
        "Stale or inconsistent oracle prices block new risk",
      ]} />
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
  const overview = usePerpsOverview();
  const [marketId, setMarketId] = useState<number | null>(null);
  const [side, setSide] = useState<"long" | "short">("long");
  const markets = overview.data?.markets ?? [];
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
        <p className="notice bad" role="alert">Perps markets could not be loaded from the API. Trading is blocked until they load.</p>
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
          <section className="pxt-card pxt-watch" aria-label="Markets">
            <Watchlist o={o} market={market} onPick={setMarketId} />
          </section>
          <section className="pxt-card pxt-bal" aria-label="Balances">
            <Balances />
          </section>
        </div>
        <div className="pxt-right">
        <div className="pxt-center">
          <section className="pxt-card pxt-chart" aria-label={`${market.symbol} chart`}>
            <ChartHead o={o} market={market} onPick={setMarketId} />
            <ChartSection market={market} />
          </section>
          <section className="pxt-card pxt-account">
            <AccountTabs o={o} market={market} shielded={shielded} vault={vault} />
          </section>
          <section className="pxt-card pxt-liq" id="px-liquidity" aria-label="Provide liquidity">
            <div className="pxt-card-head pxt-liq-head"><h2>Provide liquidity</h2></div>
            <div className="pxt-pad"><LiquidityVault o={o} /></div>
          </section>
        </div>
        <aside className="pxt-card pxt-side" id="px-order" aria-label="Place an order">
          <div className="pxt-side-head">
            <h2>Trade {market.symbol}</h2>
            {PERPS_ADAPTER && <FundingSwitch className="pxt-side-switch" />}
          </div>
          <section className={`tk-trade px-order${shielded ? " shielded-panel" : ""}`}>
            {shielded && <SyncNote v={vault} />}
            <OrderPanel o={o} market={market} shielded={shielded} vault={vault} side={side} onSide={setSide} />
          </section>
          <div className="pxt-side-foot">
            <p className="pxt-privacy">
              {shielded
                ? <><b>Public:</b> market, size and price. <b>Hidden:</b> which wallet holds the position.</>
                : <><b>Public:</b> market, size, price and your wallet address. Switch to Shielded to hide the wallet.</>}
            </p>
            <p className="pxt-warn">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.5 11.4H1.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 6.2v3.3M8 11.3v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              <span>Leverage multiplies losses as well as gains. Not independently audited.</span>
            </p>
          </div>
        </aside>
        </div>
      </div>
      <div className="tk-mbar px-mbar" role="region" aria-label="Quick trade">
        <div className="tk-mbar-price">
          <span className="tk-label">{market.symbol}</span>
          <strong className="mono">{fmtUsdPrice(market.markPrice ?? market.recordedPrice?.price)}</strong>
        </div>
        <button type="button" className="btn tk-buy" onClick={() => pick("long")}>Long</button>
        <button type="button" className="btn tk-sell" onClick={() => pick("short")}>Short</button>
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

/** Every perps market, searchable, with its last day at a glance. Picking one switches the page. */
function Watchlist({ o, market, onPick }: { o: PerpsOverview; market: PerpMarket; onPick: (id: number) => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = o.markets.filter((m) => !term || m.symbol.toLowerCase().includes(term) || m.base.toLowerCase().includes(term));
  return (
    <>
      <div className="pxt-card-head"><h2>Markets</h2><span className="pxt-count">{o.markets.length}</span></div>
      <label className="pxt-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
        <span className="sr-only">Search markets</span>
        <input type="search" placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="pxt-watch-cols" aria-hidden="true"><span>Market</span><span>Mark</span><span>24h</span></div>
      <ul className="pxt-watch-list">
        {list.map((m) => <WatchRow key={m.id} m={m} on={m.id === market.id} onPick={onPick} />)}
        {list.length === 0 && <li className="small muted pxt-watch-none">No market matches “{q}”.</li>}
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

/** USDG in the connected wallet and in the shielded vault: what can margin a position. */
function Balances() {
  const { address } = useConnection();
  const wallet = useWalletTokens([USDG], PERP_ENGINE);
  const v = useVault();
  const usdgAsset = v.status?.assets.find((a) => USDG && a.address.toLowerCase() === USDG.toLowerCase());
  const shieldedBal = usdgAsset && v.phase === "unlocked" ? balances(usdgAsset.resource).spendable : undefined;
  const pub = wallet.get(USDG).balance;
  return (
    <>
      <div className="pxt-card-head"><h2>Balances</h2></div>
      <div className="pxt-bal-box">
        <div className="pxt-bal-top">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.3" /></svg>
          <span>Public wallet</span>
        </div>
        <div className="pxt-bal-row"><span>{SYMBOL}</span><span className="mono">{!address ? "Not connected" : pub !== undefined ? usd(pub) : "–"}</span></div>
      </div>
      <Link to="/app/vault" className="pxt-bal-box pxt-bal-link">
        <div className="pxt-bal-top">
          <span className="pxt-fund-ico on">{SHIELD}</span>
          <span>Shielded vault</span>
          <svg className="pxt-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </div>
        <div className="pxt-bal-row">
          <span>{SYMBOL}</span>
          <span className="mono">{shieldedBal !== undefined ? usd(shieldedBal) : v.phase === "locked" ? "Locked" : v.phase === "none" ? "No vault yet" : "–"}</span>
        </div>
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ market switch and header

/** The market list in a dialog, with search: opened from the market title. */
function MarketPicker({ o, market, onPick, onClose }: { o: PerpsOverview; market: PerpMarket; onPick: (id: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const term = q.trim().toLowerCase();
  const list = o.markets.filter((m) => !term || m.symbol.toLowerCase().includes(term) || m.base.toLowerCase().includes(term));
  return (
    <dialog ref={ref} className="px-dlg" aria-label="Choose a market" onClose={onClose} onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="px-dlg-in">
        <div className="px-dlg-head">
          <h2>Perpetual markets</h2>
          <button type="button" className="txt-close" aria-label="Close" onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
          </button>
        </div>
        <label className="px-dlg-search">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
          <span className="sr-only">Search markets</span>
          <input autoFocus type="search" placeholder="Search by name, e.g. ETH" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="px-dlg-cols" aria-hidden="true"><span>Market</span><span>Mark price</span><span>24h</span><span>Volume 24h</span></div>
        <ul className="px-dlg-list" role="listbox" aria-label="Markets">
          {list.map((m) => <PickerRow key={m.id} m={m} on={m.id === market.id} onPick={(id) => { onPick(id); ref.current?.close(); }} />)}
          {list.length === 0 && <li className="small muted px-dlg-none">No market matches “{q}”.</li>}
        </ul>
      </div>
    </dialog>
  );
}

/** Official logos for perps markets, served by the site. A market without one shows its first letter. */
const COIN_LOGOS: Record<string, string> = { ETH: "/tokens/eth.png", BTC: "/tokens/btc.png", SOL: "/tokens/sol.png", LINK: "/tokens/link.png" };

function CoinMark({ base, large }: { base: string; large?: boolean }) {
  const cls = `px-coin${large ? " px-coin-lg" : ""} px-coin-${base.toLowerCase()}`;
  const logo = COIN_LOGOS[base.toUpperCase()];
  if (logo) return <img className={`${cls} px-coin-img`} src={logo} alt="" aria-hidden="true" />;
  return <span className={cls} aria-hidden="true">{base.slice(0, 1)}</span>;
}

function PickerRow({ m, on, onPick }: { m: PerpMarket; on: boolean; onPick: (id: number) => void }) {
  const change = useDayChange(m);
  return (
    <li>
      <button type="button" role="option" aria-selected={on} className="px-dlg-row" onClick={() => onPick(m.id)}>
        <span className="px-dlg-mk">
          <CoinMark base={m.base} />
          <span><strong>{m.symbol}</strong><span className="small muted">{m.config ? `Up to ${m.config.maxLeverageBps / 10_000}×` : "–"}</span></span>
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
          <button type="button" className="pxt-mkt-btn" aria-haspopup="dialog" title="Change market" onClick={() => setOpen(true)}>
            <CoinMark base={market.base} />
            <span>{market.base}<span className="pxt-slash"> / </span>USD</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </button>
        </h1>
        {cfg && <span className="pxt-pill">Up to {cfg.maxLeverageBps / 10_000}×</span>}
        {cfg && !cfg.enabled && <span className="pxt-pill warn-text">Paused</span>}
      </div>
      <div className="pxt-head-px">
        <strong className="mono">{fmtUsdPrice(market.markPrice)}</strong>
        <span className={`pxt-chg mono ${d.change === null ? "" : d.change >= 0 ? "up" : "down"}`}>{pctText(d.change)}</span>
      </div>
      <dl className="pxt-head-stats">
        <div><dt>24h high</dt><dd className="mono">{f(d.hi)}</dd></div>
        <div><dt>24h low</dt><dd className="mono">{f(d.lo)}</dd></div>
        <div><dt>Oracle</dt><dd className="mono" title={rec?.timestamp ? `Last recorded on-chain ${timeAgo(rec.timestamp)}` : undefined}>{rec?.timestamp ? fmtUsdPrice(rec.price) : "–"}</dd></div>
        <div><dt>Funding 1h</dt><dd className={`mono ${toneOf(rate)}`} title={fundingText(market)}>{Number.isFinite(rate) ? `${(rate * 100).toFixed(4)}%` : "–"} <span className="muted">· {next}</span></dd></div>
        <div><dt>Open interest</dt><dd className="mono">{st ? usd(BigInt(st.oiLong) + BigInt(st.oiShort), 0) : "–"} <span className="muted">{SYMBOL}</span></dd></div>
        <div><dt>Volume 24h</dt><dd className="mono">{Number(market.volume24h).toLocaleString("en-US", { maximumFractionDigits: 0 })} <span className="muted">{SYMBOL}</span></dd></div>
        <div><dt>Vault liquidity</dt><dd className="mono">{o.vault.freeLiquidity !== null ? usd(o.vault.freeLiquidity, 0) : "–"} <span className="muted">{SYMBOL}</span></dd></div>
      </dl>
    </header>
  );
}

// ------------------------------------------------------------------ chart, stats, open interest, facts

const CHART_H = 360;

function ChartSection({ market }: { market: PerpMarket }) {
  const [range, setRange] = useState<CandleRange>("12d");
  const q = usePerpCandles(market.id, range);
  const mark = market.markPrice ? Number(market.markPrice) : null;
  const c = q.data?.candles ?? [];
  const tf = RANGES.find(([r]) => r === range)?.[1] ?? "";
  const sizes = (
    <div className="pxt-tf" role="group" aria-label="Candle size">
      {RANGES.map(([r, label]) => <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{label}</button>)}
    </div>
  );
  return (
    <section className="tk-chart pxt-chart-body" aria-label={`${market.symbol} price`}>
      {q.isLoading && !q.data ? (
        <>
          <div className="pxt-tools">{sizes}</div>
          <Sk block w="100%" h={CHART_H} />
        </>
      ) : q.isError && !q.data ? (
        <>
          <div className="pxt-tools">{sizes}</div>
          <div className="chart-empty" style={{ minHeight: CHART_H }}><p className="small muted" style={{ margin: 0 }}>Reference prices are unavailable right now. Trading still uses the signed oracle price.</p></div>
        </>
      ) : (
        <TvChart
          candles={c}
          mark={mark}
          height={CHART_H}
          resetKey={`${market.id}:${range}`}
          terminal={{
            title: `${market.base} / USD · ${tf} · Coinbase reference`,
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
  const cfg = market.config;
  const st = market.state;
  const oiL = st ? BigInt(st.oiLong) : 0n;
  const oiS = st ? BigInt(st.oiShort) : 0n;
  const total = oiL + oiS;
  const longPct = total === 0n ? 50 : Number((oiL * 1000n) / total) / 10;
  const used = (a: bigint, cap: string | undefined) => (cap && BigInt(cap) > 0n ? Number((a * 1000n) / BigInt(cap)) / 10 : 0);
  return (
    <section className="tk-curve px-oi" aria-label="Open interest">
      <div className="row-between">
        <span className="tk-label">Open interest, long against short</span>
        <span className="small muted">{fundingText(market)}</span>
      </div>
      <div className={`px-split${total === 0n ? " empty" : ""}`} role="img" aria-label={`Longs ${longPct.toFixed(1)}%, shorts ${(100 - longPct).toFixed(1)}%`}>
        <div className="px-split-l" style={{ width: `${longPct}%` }} />
        <div className="px-split-s" />
      </div>
      <div className="px-oi-sides">
        <div>
          <span className="good-text">Long {total === 0n ? "–" : `${longPct.toFixed(1)}%`}</span>
          <span className="mono">{usd(oiL, 0)} <span className="muted">of {cfg ? usd(cfg.maxOpenInterestLong, 0) : "–"} cap ({used(oiL, cfg?.maxOpenInterestLong).toFixed(1)}%)</span></span>
        </div>
        <div>
          <span className="bad-text">Short {total === 0n ? "–" : `${(100 - longPct).toFixed(1)}%`}</span>
          <span className="mono">{usd(oiS, 0)} <span className="muted">of {cfg ? usd(cfg.maxOpenInterestShort, 0) : "–"} cap ({used(oiS, cfg?.maxOpenInterestShort).toFixed(1)}%)</span></span>
        </div>
      </div>
    </section>
  );
}

function MarketFacts({ o, market }: { o: PerpsOverview; market: PerpMarket }) {
  const cfg = market.config;
  const rec = market.recordedPrice;
  const oi = market.state ? BigInt(market.state.oiLong) + BigInt(market.state.oiShort) : 0n;
  const stale = rec && rec.ageSeconds !== null && rec.ageSeconds > o.params.navMaxAge && oi > 0n;
  return (
    <section className="tk-about">
      <h2>Market details</h2>
      <dl className="tk-facts">
        <div><dt>Max leverage</dt><dd>{cfg ? `${cfg.maxLeverageBps / 10_000}×` : "–"}</dd></div>
        <div><dt>Open / close fee</dt><dd className="mono">{fmtBps(cfg?.openFeeBps)} / {fmtBps(cfg?.closeFeeBps)}</dd></div>
        <div><dt>Maintenance margin</dt><dd className="mono">{fmtBps(cfg?.maintenanceMarginBps)} of size</dd></div>
        <div><dt>Liquidation fee</dt><dd className="mono">{fmtBps(cfg?.liquidationFeeBps)} of size</dd></div>
        <div><dt>Profit cap</dt><dd className="mono">{cfg ? `${cfg.maxProfitBps / 100}% of size` : "–"}</dd></div>
        <div><dt>Minimum margin</dt><dd className="mono">{cfg ? `${usd(BigInt(cfg.minCollateral))} ${SYMBOL}` : "–"}</dd></div>
        <div><dt>Keeper fee</dt><dd className="mono">{usd(BigInt(o.params.minExecutionFee), 4)} {SYMBOL}</dd></div>
        <div><dt>Last on-chain price</dt><dd className={`mono ${stale ? "warn-text" : ""}`}>{rec && rec.timestamp ? `${fmtUsdPrice(rec.price)} · ${timeAgo(rec.timestamp)}` : "none yet"}</dd></div>
        <div><dt>Price sources</dt><dd title={market.markSources.join(", ")}>{market.markSources.length ? market.markSources.join(", ") : "–"}</dd></div>
      </dl>
      <p className="small muted">
        {o.priceSource === "pyth"
          ? "Prices come from Pyth and are checked on-chain by Pyth's contract. A request fills at the first Pyth price after you send it, so nobody can pick a better or worse one."
          : o.priceSource === "curveil-test-signer"
            ? "Testnet prices are a median of public exchanges, signed by a Curveil test key."
            : "Prices come from the oracle network's signed reports."}
      </p>
    </section>
  );
}

function Trades({ market }: { market: PerpMarket }) {
  const q = usePerpActivity(market.id);
  const rows = q.data ?? [];
  if (q.isLoading) return <><Loading label="Loading trades" /><div className="table-scroll" tabIndex={0}><table className="data px-table"><tbody><SkRows cols={5} rows={4} /></tbody></table></div></>;
  if (rows.length === 0) return <p className="small muted px-empty">No trades in this market yet.</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data px-table">
        <thead><tr><th>Action</th><th className="num">Price</th><th className="num">Size ({SYMBOL})</th><th className="num">PnL</th><th className="num">Age</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const size = r.event === "opened" ? r.size : r.size_delta;
            const what = r.event === "opened" ? "Open" : r.event === "decreased" ? "Close" : "Liquidation";
            return (
              <tr key={`${r.tx_hash}-${r.position_id}-${r.event}`}>
                <td>
                  <a className="px-mk" href={explorerTx(r.tx_hash)} target="_blank" rel="noreferrer">
                    <strong>{what}</strong>
                    <span className={r.event === "liquidated" ? "warn-text" : r.is_long ? "good-text" : "bad-text"}>{r.is_long ? "Long" : "Short"}</span>
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
  return (
    <div className="pxt px" aria-busy="true">
      <ScrollLock />
      <Loading label="Loading perps markets" />
      <div className="pxt-grid">
        <div className="pxt-left">
          <section className="pxt-card pxt-watch" aria-hidden="true">
            <div className="pxt-card-head"><h2>Markets</h2></div>
            <div className="pxt-search"><Sk w="60%" /></div>
            <ul className="pxt-watch-list">
              {[0, 1, 2].map((i) => (
                <li key={i} className="pxt-watch-row">
                  <span className="pxt-watch-mk"><Sk w={26} h={26} style={{ borderRadius: "50%" }} /><span><Sk w="7ch" /><Sk w="6ch" /></span></span>
                  <span className="pxt-watch-right"><Sk w={64} h={22} /><Sk w="5ch" /></span>
                </li>
              ))}
            </ul>
          </section>
          <section className="pxt-card pxt-bal" aria-hidden="true">
            <div className="pxt-card-head"><h2>Balances</h2></div>
            {["Public wallet", "Shielded vault"].map((l) => (
              <div key={l} className="pxt-bal-box"><div className="pxt-bal-top"><span>{l}</span></div><div className="pxt-bal-row"><span>{SYMBOL}</span><Sk w="6ch" /></div></div>
            ))}
          </section>
        </div>
        <div className="pxt-right">
        <div className="pxt-center">
        <section className="pxt-card pxt-chart" aria-hidden="true">
          <header className="pxt-head">
            <div className="pxt-head-id"><Sk w={30} h={30} style={{ borderRadius: "50%" }} /><Sk w="7ch" h={22} /></div>
            <div className="pxt-head-px"><Sk w="8ch" h={34} /><Sk w="6ch" h={24} /></div>
            <dl className="pxt-head-stats">{["24h high", "24h low", "Oracle", "Funding 1h", "Open interest", "Volume 24h", "Vault liquidity"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="7ch" /></dd></div>)}</dl>
          </header>
          <div className="pxt-chart-body">
            <div className="pxt-tools"><Sk w={260} h={34} /></div>
            <Sk block w="100%" h={CHART_H} />
          </div>
        </section>
        <section className="pxt-card pxt-account" aria-hidden="true">
          <div className="tk-tabs px-account">
            <div className="tk-tablist">{["Market info", "Positions", "Pending", "TP / SL", "History", "Market trades"].map((l) => <button key={l} type="button" role="tab" disabled tabIndex={-1}>{l}</button>)}</div>
            <div className="px-empty"><Sk block w="100%" h={56} /></div>
          </div>
        </section>
        </div>
        <aside className="pxt-card pxt-side" aria-hidden="true">
          <div className="pxt-side-head"><h2>Trade</h2></div>
          <section className="tk-trade px-order">
            <div className="seg side-seg px-side-seg" style={{ marginTop: 0 }}>
              <button type="button" disabled tabIndex={-1}>Long</button>
              <button type="button" disabled tabIndex={-1}>Short</button>
            </div>
            <Sk block w="100%" h={88} />
            <Sk block w="100%" h={36} />
            <Sk block w="100%" h={36} />
            <dl className="px-rows">{["Liquidation price", "Order value", "Fees"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="8ch" /></dd></div>)}</dl>
            <Sk block w="100%" h={44} />
          </section>
        </aside>
        </div>
      </div>
    </div>
  );
}

/** One position row while it loads. */
export function PositionSkeleton({ shielded = false }: { shielded?: boolean }) {
  return (
    <div className="panel stack perp-position" aria-hidden="true">
      <div className="row-between">
        <span className="row-between" style={{ gap: 8 }}>
          <Sk w="8ch" /><Sk w="5ch" h={20} />
          {shielded && <span className="tag tag-shielded">Shielded</span>}
        </span>
        <Sk w="4ch" />
      </div>
      <dl className="kv stats">
        {["Size", "Collateral", "PnL after funding", "Entry", "Mark", "Liquidation"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="8ch" /></dd></div>)}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ order panel

function OrderPanel({ o, market, shielded, vault, side, onSide }: { o: PerpsOverview; market: PerpMarket; shielded: boolean; vault: ReturnType<typeof useShieldedVault>; side: "long" | "short"; onSide: (s: "long" | "short") => void }) {
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

  async function open() {
    if (blocked || !p || !limit || !PERP_ENGINE || !USDG || !collateral) return;
    const steps: TxStep[] = [];
    if ((allowance ?? 0n) < total!) {
      steps.push({ label: `Approve ${usd(total)} ${SYMBOL} for the perps engine`, params: { address: USDG, abi: erc20Abi, functionName: "approve", args: [PERP_ENGINE, total!], chainId: curveilChain.id } });
    }
    steps.push({
      label: `Request ${isLong ? "long" : "short"} ${market.symbol}`,
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
        <span className="px-chip" title="Each position has its own margin. A loss can never take more than that position's margin.">Isolated</span>
        <span className="px-chip">Market</span>
        <span className="px-chip mono" title="Most leverage this market allows">Up to {maxLev}×</span>
      </div>
      <div className="seg side-seg px-side-seg" role="group" aria-label="Side" style={{ marginTop: 0 }}>
        <button type="button" aria-pressed={isLong} data-side="long" onClick={() => setIsLong(true)}>Long</button>
        <button type="button" aria-pressed={!isLong} data-side="short" onClick={() => setIsLong(false)}>Short</button>
      </div>
      <div className="px-avail">
        <span>Available</span>
        <span className="mono">{bal !== undefined ? `${usd(bal)} ${SYMBOL}` : "–"}</span>
      </div>
      <AmountField
        label="Margin"
        value={input}
        onChange={setInput}
        symbol={SYMBOL}
        decimals={USDG_DECIMALS}
        error={bal !== undefined && total !== null && collateral && total > bal ? `Margin plus the ${usd(execFee)} ${SYMBOL} keeper fee is more than your ${shielded ? "vault" : "wallet"} balance` : null}
      >
        <span className="token-tag">{SYMBOL}</span>
      </AmountField>
      <div className="px-pcts" role="group" aria-label="Share of available balance">
        {[25, 50, 75, 100].map((f) => <button key={f} type="button" onClick={() => pct(f)} disabled={bal === undefined}>{f}%</button>)}
      </div>
      <div className="px-field">
        <div className="px-field-top"><span>Leverage</span><span className="mono">{leverage}×</span></div>
        <div className="px-levs" role="group" aria-label="Leverage">
          {levs.map((l) => <button key={l} type="button" aria-pressed={leverage === l} onClick={() => setLeverage(l)}>{l}×</button>)}
        </div>
      </div>
      <div className="px-field">
        <div className="px-field-top">
          <span title="If the price moves more than this before the keeper fills, the request is cancelled and your margin comes back.">Max slippage</span>
          <div className="px-levs px-slip" role="group" aria-label="Max slippage">
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
              blocked={blocked}
              onDone={() => {
                setInput("");
                kickKeeper();
              }}
            />
          )}
        </VaultGate>
      ) : (
        <>
          <WalletAction verb="trade perps">
            <button className={`btn btn-block px-submit side-${isLong ? "long" : "short"}`} disabled={Boolean(blocked) || tx.busy} onClick={open}>
              {tx.busy ? "Check your wallet…" : blocked ?? `${(allowance ?? 0n) < (total ?? 0n) ? "Approve and " : ""}${isLong ? "long" : "short"} ${market.base} ${leverage}×`}
            </button>
          </WalletAction>
          {blocked === `Not enough ${SYMBOL}` && IS_TESTNET && (
            <p className="small muted" style={{ margin: 0 }}>Test {SYMBOL} is free from the <Link to="/docs" search={{ page: "testnet" }} hash="faucet">testnet faucet</Link>.</p>
          )}
          <TxStatus phase={tx.phase} />
        </>
      )}
      <dl className="px-rows">
        <div><dt>Liquidation price</dt><dd className="mono warn-text">{p?.liquidationPrice !== undefined && p?.liquidationPrice !== null ? fmtUsdPrice(p.liquidationPrice) : "–"}</dd></div>
        <div><dt>Order value</dt><dd className="mono">{p ? `${usd(p.size)} ${SYMBOL}` : "–"}</dd></div>
        <div><dt>Margin</dt><dd className="mono">{collateral ? `${usd(collateral)} ${SYMBOL}` : "–"}</dd></div>
        <div><dt>Fill no worse than</dt><dd className="mono">{fmtUsdPrice(limit)}</dd></div>
        <div><dt>Fees</dt><dd className="mono" title={`Open fee ${fmtBps(cfg?.openFeeBps)} of size, plus the keeper fee`}>{p ? `${usd(p.openFee + execFee, 4)} ${SYMBOL}` : `${usd(execFee, 4)} ${SYMBOL}`}</dd></div>
        <div><dt>Most it can gain</dt><dd className="mono">{p ? `${usd(p.maxProfit)} ${SYMBOL}` : "–"}</dd></div>
        <div className="px-total"><dt>Total from your {shielded ? "notes" : "wallet"}</dt><dd className="mono">{total !== null ? `${usd(total)} ${SYMBOL}` : "–"}</dd></div>
      </dl>
      <p className="px-note">
        A keeper fills your request at the next signed price, usually within seconds. Minimum margin {cfg ? usd(BigInt(cfg.minCollateral)) : "–"} {SYMBOL} plus the open fee. Closing costs {fmtBps(cfg?.closeFeeBps)} of size.
      </p>
    </>
  );
}

export function fundingText(m: PerpMarket): string {
  const r = Number(m.fundingRatePerHour);
  if (!Number.isFinite(r) || r === 0) return "nobody pays (balanced or empty)";
  return `${r > 0 ? "longs pay shorts" : "shorts pay longs"} ${(Math.abs(r) * 100).toFixed(4)}% of size per hour`;
}

// ------------------------------------------------------------------ positions, orders, history, trades

function AccountTabs({ o, market, shielded, vault }: { o: PerpsOverview; market: PerpMarket; shielded: boolean; vault: ReturnType<typeof useShieldedVault> }) {
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
    ["info", "Market info", null],
    ...(shielded
      ? ([["positions", "Shielded positions", null]] as Tab[])
      : ([["positions", "Positions", live.length || null], ["pending", "Pending", pending.length || null], ["orders", "TP / SL", active.length || null], ["history", "History", null]] as Tab[])),
    ["trades", "Market trades", null],
  ];
  const shown = tabs.some(([t]) => t === tab) ? tab : "info";
  const account = shown !== "trades" && shown !== "info";
  return (
    <section className="tk-tabs px-account" aria-label="Positions, orders and trades">
      <div className="tk-tablist" role="tablist">
        {tabs.map(([t, label, n]) => (
          <button key={t} type="button" role="tab" aria-selected={shown === t} onClick={() => setTab(t)}>
            {label}{n !== null && <span className="tk-count">{n}</span>}
          </button>
        ))}
        {shown === "trades" && <span className="tk-tab-note">{market.symbol}, newest first</span>}
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
        <div className="px-empty"><WalletAction verb="see your positions"><span /></WalletAction></div>
      ) : positions.isError ? (
        <p className="notice bad" role="alert">Positions could not be loaded. They are safe on-chain; try again shortly.</p>
      ) : (
        <>
          {shown === "positions" && <PositionsTable loading={positions.isLoading} live={live} o={o} orders={active} />}
          {shown === "pending" && (pending.length ? <PendingRequests requests={pending} o={o} /> : <p className="small muted px-empty">No requests waiting for the keeper.</p>)}
          {shown === "orders" && <AllOrders orders={active} o={o} positions={live} />}
          {shown === "history" && <History positions={done} requests={settled} o={o} />}
        </>
      )}
    </section>
  );
}

function PositionsTable({ loading, live, o, orders }: { loading: boolean; live: LivePosition[]; o: PerpsOverview; orders: OrderRow[] }) {
  const [open, setOpen] = useState<{ id: string; action: PosAction } | null>(null);
  if (loading) return <><Loading label="Loading your positions" /><div className="table-scroll" tabIndex={0}><table className="data px-table"><tbody><SkRows cols={9} rows={2} /></tbody></table></div></>;
  if (live.length === 0) return <p className="small muted px-empty">No open positions. Pick a side and margin in the order panel to open one.</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data px-table">
        <thead>
          <tr>
            <th>Market</th><th className="num">Size</th><th className="num">Margin</th><th className="num">Entry</th><th className="num">Mark</th><th className="num">Liq. price</th><th className="num">PnL</th><th>TP / SL</th><th />
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
                      <span className={p.isLong ? "good-text" : "bad-text"}>{p.isLong ? "Long" : "Short"}{lev !== null && p.status === "open" ? ` ${lev.toFixed(1)}×` : ""}</span>
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
                      <span className="small muted">Opening…</span>
                    ) : (
                      <span className="px-acts">
                        <button type="button" className="btn btn-sm" aria-pressed={act === "close"} onClick={() => toggle("close")}>{p.pendingClose !== "0" ? "Closing…" : "Close"}</button>
                        <button type="button" className="btn btn-sm" aria-pressed={act === "margin"} onClick={() => toggle("margin")}>Margin</button>
                        <button type="button" className="btn btn-sm" aria-pressed={act === "orders"} onClick={() => toggle("orders")}>TP/SL</button>
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
                  <tr><td colSpan={9}><p className="notice bad small" style={{ margin: 0 }}>Position #{p.id} is below maintenance margin at the mark price and can be liquidated now. Add margin or close it.</p></td></tr>
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
  const tx = useTxRunner();
  const qc = useQueryClient();
  if (orders.length === 0) return <p className="small muted px-empty">No take-profit or stop-loss orders. Add one from a position's TP/SL button.</p>;
  async function cancel(id: string) {
    if (!ORDER_MANAGER) return;
    if (await tx.run([{ label: "Cancel order", params: { address: ORDER_MANAGER, abi: orderManagerAbi, functionName: "cancel", args: [BigInt(id)], chainId: curveilChain.id } as never }]))
      void qc.invalidateQueries({ queryKey: ["perp-orders"] });
  }
  return (
    <>
      <div className="table-scroll" tabIndex={0}>
        <table className="data px-table">
          <thead><tr><th>Market</th><th>Type</th><th className="num">Trigger</th><th className="num">Size</th><th>Position</th><th /></tr></thead>
          <tbody>
            {orders.map((x) => {
              const p = positions.find((y) => y.id === x.position_id);
              const m = p ? o.markets.find((y) => y.id === p.market) : undefined;
              return (
                <tr key={x.order_id}>
                  <td><span className="px-mk"><strong>{m?.base ?? "–"}</strong>{p && <span className={p.isLong ? "good-text" : "bad-text"}>{p.isLong ? "Long" : "Short"}</span>}</span></td>
                  <td>{x.kind === "take_profit" ? "Take-profit" : "Stop-loss"}</td>
                  <td className="num mono">{fmtUsdPrice(BigInt(x.trigger_price))}</td>
                  <td className="num mono">{x.size === "0" ? "Whole position" : `${usd(x.size)} ${SYMBOL}`}</td>
                  <td className="mono small">#{x.position_id}</td>
                  <td><button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => cancel(x.order_id)}>Cancel</button></td>
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
                {r.kind === "open" ? "Opening" : "Closing"} {r.is_long ? "long" : "short"} {m?.symbol ?? ""} · {usd(r.size)} {SYMBOL} · waiting for the keeper ({timeAgo(r.created_at)})
              </span>
              {canCancel && PERP_ENGINE && (
                <div>
                  <button
                    className="btn btn-sm"
                    disabled={tx.busy}
                    onClick={async () => {
                      const ok = await tx.run([{ label: "Cancel request", params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "cancelRequest", args: [BigInt(r.request_id)], chainId: curveilChain.id } as never }]);
                      if (ok) void qc.invalidateQueries({ queryKey: ["perp-positions"] });
                    }}
                  >
                    Cancel for a full refund
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
  const v = p.valuation;
  const net = v ? BigInt(v.pnl) - BigInt(v.funding) : null;
  const lev = BigInt(p.collateral) > 0n ? Number((BigInt(p.size) * 100n) / BigInt(p.collateral)) / 100 : null;
  return (
    <>
      <div className="row-between">
        <span className="row-between" style={{ gap: 8 }}>
          <strong>{m?.symbol ?? `Market ${p.market}`}</strong>
          <span className={`tag ${p.isLong ? "tag-live" : "tag-short"}`}>{p.isLong ? "Long" : "Short"}</span>
          {lev !== null && p.status === "open" && <span className="small muted mono">{lev.toFixed(2)}×</span>}
          {tag}
        </span>
        <span className="small muted mono">#{p.id}</span>
      </div>
      {p.status === "open" ? (
        <dl className="kv stats">
          <div><dt>Size</dt><dd className="mono">{usd(p.size)}</dd></div>
          <div><dt>Collateral</dt><dd className="mono">{usd(p.collateral)}</dd></div>
          <div><dt>PnL after funding</dt><dd className={`mono ${net === null || signedUsd(net) === "0.00" ? "" : net < 0n ? "bad-text" : "good-text"}`}>{signedUsd(net)}</dd></div>
          <div><dt>Entry</dt><dd className="mono">{fmtUsdPrice(BigInt(p.entryPrice))}</dd></div>
          <div><dt>Mark</dt><dd className="mono">{fmtUsdPrice(p.markPrice ? BigInt(p.markPrice) : null)}</dd></div>
          <div><dt>Liquidation</dt><dd className={`mono ${v?.liquidatable ? "bad-text" : "warn-text"}`}>{v ? fmtUsdPrice(BigInt(v.liquidationPrice)) : "–"}</dd></div>
        </dl>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {p.status === "pending" ? "Open request waiting." : `Position ${p.status}. Paid out ${usd(p.paidOut)} ${SYMBOL}.`}
        </p>
      )}
      {v?.liquidatable && <p className="notice bad small" style={{ margin: 0 }}>This position is below maintenance margin at the mark price and can be liquidated now.</p>}
    </>
  );
}

const FRACTIONS = [25, 50, 100] as const;

function CloseForm({ p, m, o }: { p: LivePosition; m: PerpMarket; o: PerpsOverview }) {
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
      { label: `Request close of ${pct}%`, params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "requestClose", args: [BigInt(p.id), size, limit, execFee], chainId: curveilChain.id } as never },
    ]);
    if (r) {
      kickKeeper();
      void qc.invalidateQueries({ queryKey: ["perp-positions"] });
    }
  }
  return (
    <CloseControls pct={pct} setPct={setPct} slippage={slippage} setSlippage={setSlippage} size={size} limit={limit} execFee={execFee} closeFeeBps={m.config?.closeFeeBps}>
      <WalletAction verb="close">
        <button className="btn btn-primary btn-block" disabled={tx.busy || !limit || p.pendingClose !== "0"} onClick={go}>{tx.busy ? "Check your wallet…" : p.pendingClose !== "0" ? "Waiting for the keeper…" : `Close ${pct}%`}</button>
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
  return (
    <div className="stack">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="seg" role="group" aria-label="Share to close" style={{ marginTop: 0 }}>
          {FRACTIONS.map((f) => (
            <button key={f} type="button" aria-pressed={pct === f} onClick={() => setPct(f)}>{f}%</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Price limit" style={{ marginTop: 0 }}>
          {SLIPPAGES_BPS.map((b) => (
            <button key={b} type="button" aria-pressed={slippage === b} onClick={() => setSlippage(b)}>{b / 100}%</button>
          ))}
        </div>
      </div>
      <dl className="rows">
        <div><dt>Size to close</dt><dd className="mono">{usd(size)} {SYMBOL}</dd></div>
        <div><dt>Fill no worse than</dt><dd className="mono">{fmtUsdPrice(limit)}</dd></div>
        <div><dt>Close fee + execution fee</dt><dd className="mono">{fmtBps(closeFeeBps)} of size + {usd(execFee, 4)} {SYMBOL}</dd></div>
      </dl>
      {children}
    </div>
  );
}

function MarginForm({ p }: { p: LivePosition }) {
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
    if (allowance < amount) steps.push({ label: "Approve", params: { address: USDG, abi: erc20Abi, functionName: "approve", args: [PERP_ENGINE, amount], chainId: curveilChain.id } });
    steps.push({ label: "Add margin", params: { address: PERP_ENGINE, abi: perpEngineAbi, functionName: "addCollateral", args: [BigInt(p.id), amount], chainId: curveilChain.id } as never });
    if (await tx.run(steps)) {
      setInput("");
      void wallet.refetch();
      void qc.invalidateQueries({ queryKey: ["perp-positions"] });
    }
  }
  const short = amount !== null && bal !== undefined && amount > bal;
  return (
    <div className="stack">
      <AmountField label="Add collateral" value={input} onChange={setInput} symbol={SYMBOL} decimals={USDG_DECIMALS} balance={bal !== undefined ? usd(bal) : undefined} onMax={() => bal !== undefined && setInput(formatUnits(bal, USDG_DECIMALS))}>
        <span className="token-tag">{SYMBOL}</span>
      </AmountField>
      <p className="small muted" style={{ margin: 0 }}>Adding margin lowers leverage and moves the liquidation price away. It needs no price, so it applies at once.</p>
      <WalletAction verb="add margin">
        <button className="btn btn-primary btn-block" disabled={tx.busy || !amount || short} onClick={go}>{short ? `Not enough ${SYMBOL}` : tx.busy ? "Check your wallet…" : "Add margin"}</button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </div>
  );
}

function OrdersForm({ p, m, o, orders }: { p: LivePosition; m: PerpMarket; o: PerpsOverview; orders: OrderRow[] }) {
  const tx = useTxRunner();
  const qc = useQueryClient();
  const form = useOrderForm(p, m, o);
  async function place() {
    if (!ORDER_MANAGER || !form.ready) return;
    const r = await tx.run([{ label: `Place ${form.kindLabel}`, params: { address: ORDER_MANAGER, abi: orderManagerAbi, functionName: "place", args: form.args, chainId: curveilChain.id } as never }]);
    if (r) {
      form.reset();
      void qc.invalidateQueries({ queryKey: ["perp-orders"] });
    }
  }
  async function cancel(id: string) {
    if (!ORDER_MANAGER) return;
    if (await tx.run([{ label: "Cancel order", params: { address: ORDER_MANAGER, abi: orderManagerAbi, functionName: "cancel", args: [BigInt(id)], chainId: curveilChain.id } as never }]))
      void qc.invalidateQueries({ queryKey: ["perp-orders"] });
  }
  return (
    <div className="stack">
      <OrderList orders={orders} onCancel={cancel} busy={tx.busy} />
      <OrderFields form={form} />
      <WalletAction verb="place orders">
        <button className="btn btn-primary btn-block" disabled={tx.busy || !form.ready} onClick={place}>{tx.busy ? "Check your wallet…" : form.problem ?? `Place ${form.kindLabel}`}</button>
      </WalletAction>
      <TxStatus phase={tx.phase} />
    </div>
  );
}

/** Take-profit / stop-loss form state. A stop-loss fills at any price once triggered; a take-profit within the limit. */
export function useOrderForm(p: LivePosition, m: PerpMarket, o: PerpsOverview) {
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
    ? "Enter a trigger price"
    : kind === 1 && !favourable(p.isLong)
      ? `Take-profit must be ${p.isLong ? "above" : "below"} the mark`
      : kind === 2 && !favourable(!p.isLong)
        ? `Stop-loss must be ${p.isLong ? "below" : "above"} the mark`
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
    kindLabel: kind === 1 ? "take-profit" : "stop-loss",
    args: [BigInt(p.id), kind, t ?? 0n, size, limit, execFee, 0n] as const,
    body: { kind, triggerPrice: t ?? 0n, size, acceptablePrice: limit, executionFee: execFee, expiresAt: 0n },
    reset: () => setTrigger(""),
  };
}

export function OrderFields({ form }: { form: ReturnType<typeof useOrderForm> }) {
  return (
    <>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="seg" role="group" aria-label="Order kind" style={{ marginTop: 0 }}>
          <button type="button" aria-pressed={form.kind === 1} onClick={() => form.setKind(1)}>Take-profit</button>
          <button type="button" aria-pressed={form.kind === 2} onClick={() => form.setKind(2)}>Stop-loss</button>
        </div>
        <div className="seg" role="group" aria-label="Share to close" style={{ marginTop: 0 }}>
          {FRACTIONS.map((f) => (
            <button key={f} type="button" aria-pressed={form.pct === f} onClick={() => form.setPct(f)}>{f}%</button>
          ))}
        </div>
      </div>
      <AmountField label="Trigger price (USD)" value={form.trigger} onChange={form.setTrigger} decimals={18}>
        <span className="token-tag">USD</span>
      </AmountField>
      <p className="small muted" style={{ margin: 0 }}>
        {form.kind === 1 ? "Fills within 1% of the trigger." : "Fills at the first price past the trigger, whatever it is, so the exit is certain."} The keeper earns {usd(form.execFee, 4)} {SYMBOL} from the proceeds when it fills.
      </p>
    </>
  );
}

export function OrderList({ orders, onCancel, busy }: { orders: OrderRow[]; onCancel: (id: string) => void; busy: boolean }) {
  if (orders.length === 0) return <p className="small muted" style={{ margin: 0 }}>No active orders on this position.</p>;
  return (
    <ul className="activity-list">
      {orders.map((x) => (
        <li key={x.order_id}>
          <span className="mono small">
            {x.kind === "take_profit" ? "Take-profit" : "Stop-loss"} at {fmtUsdPrice(BigInt(x.trigger_price))} · {x.size === "0" ? "whole position" : `${usd(x.size)} ${SYMBOL}`}
          </span>
          <button className="btn btn-sm" disabled={busy} onClick={() => onCancel(x.order_id)}>Cancel</button>
        </li>
      ))}
    </ul>
  );
}

function History({ positions, requests, o }: { positions: LivePosition[]; requests: RequestRow[]; o: PerpsOverview }) {
  if (positions.length === 0 && requests.length === 0) return <p className="small muted px-empty">No settled requests or closed positions yet.</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table className="data px-table">
        <thead><tr><th>Time</th><th>Market</th><th>Action</th><th className="num">Size</th><th>Result</th><th>Tx</th></tr></thead>
        <tbody>
          {requests.map((r) => {
            const m = o.markets.find((x) => x.id === r.market_id);
            return (
              <tr key={r.request_id}>
                <td className="small muted">{timeAgo(r.settled_at ?? r.created_at)}</td>
                <td><span className="px-mk"><strong>{m?.base ?? "–"}</strong><span className={r.is_long ? "good-text" : "bad-text"}>{r.is_long ? "Long" : "Short"}</span></span></td>
                <td>{r.kind === "open" ? "Open" : "Close"}</td>
                <td className="num mono">{usd(r.size)}</td>
                <td className="small">{r.outcome === "executed" ? <span className="good-text">Filled at {fmtUsdPrice(r.price ? BigInt(r.price) : null)}</span> : <span className="warn-text">Cancelled: {REASON_TEXT[r.reason ?? ""] ?? r.reason}</span>}</td>
                <td className="mono small"><a href={explorerTx(r.tx_hash)} target="_blank" rel="noreferrer">{shortAddress(r.tx_hash)}</a></td>
              </tr>
            );
          })}
          {positions.map((p) => (
            <tr key={`p-${p.id}`}>
              <td className="small muted">–</td>
              <td><span className="px-mk"><strong>{p.symbol?.split("-")[0] ?? "–"}</strong><span className={p.isLong ? "good-text" : "bad-text"}>{p.isLong ? "Long" : "Short"}</span></span></td>
              <td>Position #{p.id} {p.status}</td>
              <td className="num mono">–</td>
              <td className="small">Paid out {usd(p.paidOut)} {SYMBOL}</td>
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
      if (allowance < amount) steps.push({ label: "Approve", params: { address: USDG, abi: erc20Abi, functionName: "approve", args: [PERP_VAULT, amount], chainId: curveilChain.id } });
      steps.push({ label: "Deposit", params: { address: PERP_VAULT, abi: perpVaultAbi, functionName: "deposit", args: [amount, min], chainId: curveilChain.id } as never });
    } else {
      steps.push({ label: "Redeem", params: { address: PERP_VAULT, abi: perpVaultAbi, functionName: "redeem", args: [amount, min, address], chainId: curveilChain.id } as never });
    }
    if (await tx.run(steps)) {
      setInput("");
      void wallet.refetch();
      void mine.refetch();
      void qc.invalidateQueries({ queryKey: ["perps"] });
    }
  }

  const lockText = v.lockSeconds >= 7_200 ? `${Math.round(v.lockSeconds / 3_600)} hours` : `${Math.round(v.lockSeconds / 60)} minutes`;
  return (
    <div className="swap-layout px-lp">
      <div className="panel stack">
        <div className="row-between">
          <p className="eyebrow" style={{ margin: 0 }}>Liquidity vault</p>
          <span className="tag tag-public">Public</span>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          The vault is every trader's counterparty. It earns what traders lose, 80% of trading fees and the funding imbalance, and pays what they win. Share value moves with open positions.
        </p>
        <dl className="kv stats">
          <div><dt>Value</dt><dd className="mono">{v.totalAssets !== null ? usd(v.totalAssets, 0) : "pricing…"}</dd></div>
          <div><dt>Share price</dt><dd className="mono">{v.sharePrice !== null ? v.sharePrice.toFixed(4) : "–"}</dd></div>
          <div><dt>Reserved</dt><dd className="mono">{util.toFixed(1)}%</dd></div>
        </dl>
        <dl className="rows">
          <div><dt>Free to redeem</dt><dd className="mono">{usd(v.freeLiquidity, 0)} {SYMBOL}</dd></div>
          <div><dt>Most it can reserve</dt><dd className="mono">{fmtBps(v.maxUtilizationBps)} of its balance</dd></div>
          <div><dt>Deposit lock</dt><dd>{lockText}</dd></div>
        </dl>
        {v.totalAssets === null && <p className="small muted" style={{ margin: 0 }}>A market with open positions has no recent recorded price, so shares cannot be priced. The keeper records one every few minutes.</p>}
      </div>
      <div className="panel stack">
        <div className="seg fill" role="group" aria-label="Vault action" style={{ marginTop: 0 }}>
          <button type="button" aria-pressed={tab === "deposit"} onClick={() => { setTab("deposit"); setInput(""); }}>Deposit</button>
          <button type="button" aria-pressed={tab === "redeem"} onClick={() => { setTab("redeem"); setInput(""); }}>Redeem</button>
        </div>
        <AmountField
          label={tab === "deposit" ? "Deposit" : "Redeem shares"}
          value={input}
          onChange={setInput}
          symbol={tab === "deposit" ? SYMBOL : "cvPLP"}
          decimals={tab === "deposit" ? USDG_DECIMALS : 18}
          balance={tab === "deposit" ? (bal !== undefined ? usd(bal) : undefined) : fmtAmount(shares, 18)}
          onMax={() => (tab === "deposit" ? bal !== undefined && setInput(formatUnits(bal, USDG_DECIMALS)) : setInput(formatUnits(shares, 18)))}
          balanceLabel={tab === "deposit" ? "Balance" : "Shares"}
          error={problem === `Not enough ${SYMBOL}` || problem === "More than your shares" ? problem : null}
        >
          <span className="token-tag">{tab === "deposit" ? SYMBOL : "cvPLP"}</span>
        </AmountField>
        <dl className="rows summary">
          <div><dt>{tab === "deposit" ? "Shares you get" : `${SYMBOL} you get`}</dt><dd className="mono">{out !== undefined ? (tab === "deposit" ? fmtAmount(out, 18) : usd(out)) : amount && preview.isLoading ? <Sk w="9ch" /> : "–"}</dd></div>
          <div><dt>Your shares</dt><dd className="mono">{fmtAmount(shares, 18)} {mine.data?.value ? `≈ ${usd(mine.data.value)} ${SYMBOL}` : ""}</dd></div>
          {locked && <div><dt>Unlocks</dt><dd>{new Date(unlockAt * 1000).toLocaleString()}</dd></div>}
        </dl>
        <WalletAction verb={tab}>
          <button className="btn btn-primary btn-block" disabled={tx.busy || Boolean(problem)} onClick={go}>
            {tx.busy ? "Check your wallet…" : problem ?? (tab === "deposit" ? (allowance < (amount ?? 0n) ? "Approve and deposit" : "Deposit") : "Redeem")}
          </button>
        </WalletAction>
        <TxStatus phase={tx.phase} />
        <p className="small muted" style={{ margin: 0 }}>
          Deposits lock for {lockText}. Redemptions are limited to {SYMBOL} not reserved for open positions' maximum profit. Both reject a fill more than 0.5% below the quote.
        </p>
      </div>
    </div>
  );
}

export { usd as fmtUsdg, SYMBOL as USDG_SYMBOL, WAD as PRICE_ONE };
