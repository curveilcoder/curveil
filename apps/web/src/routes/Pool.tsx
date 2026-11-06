import { useMemo, useState } from "react";
import { PageHead } from "../components/PageHead";
import { Loading, Sk, SkRows } from "../components/Skeleton";
import { Link, useParams } from "@tanstack/react-router";
import { useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { TokenDisc, TokenPair } from "../components/TokenPair";
import { BinChart } from "../components/BinChart";
import { PriceChart } from "../components/PriceChart";
import { CopyAddress } from "../components/CopyAddress";
import { IndexerNote } from "../components/ModuleStatus";
import { useMarkets, usePoolSwaps, pairLabel, kindLabel, binPrice, type MarketPool, type SwapEvent, type TokenRef } from "../lib/markets";
import { dlmmPairAbi } from "../lib/abis";
import { explorerTx, shortAddress, QUOTE } from "../lib/config";
import { fmtAmount, fmtBps, fmtNumber, fmtPrice, timeAgo } from "../lib/format";
import { justCreated } from "../lib/launch";

const RADIUS = 30;
const HOUR = 3_600;
const DAY = 86_400;
const SWAP_LIMIT = 200;
const RANGES = [["1D", DAY], ["1W", 7 * DAY], ["All", 0]] as const;
type ChartKind = "price" | "volume" | "liquidity";

function BackLink() {
  return (
    <Link to="/pools" className="tk-back">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Pools
    </Link>
  );
}

export function Pool() {
  const { pool: address } = useParams({ from: "/pools/$pool" });
  const markets = useMarkets();
  const pool = markets.data?.find((p) => p.address.toLowerCase() === address.toLowerCase());

  if (markets.isLoading || (!pool && justCreated(address))) return <PoolSkeleton />;
  if (!pool) {
    return (
      <div className="wrap">
        <PageHead kicker="Explore" label="Pool" title="Pool not found" lead={<>No Curveil pool is indexed at <span className="mono">{address}</span> on this network.</>} />
        <Link to="/pools" className="btn">All pools</Link>
      </div>
    );
  }
  return <PoolView pool={pool} />;
}

/** The pool page while the pool list loads: the same layout, values as skeletons. */
function PoolSkeleton() {
  return (
    <div className="wrap tk pl" aria-busy="true">
      <Loading label="Loading the pool" />
      <BackLink />
      <header className="tk-head">
        <div className="tk-id">
          <Sk w={77} h={48} style={{ borderRadius: 24 }} />
          <div className="tk-id-text">
            <div className="tk-name"><h1><Sk w="6em" h="0.85em" /></h1></div>
            <p className="tk-meta"><Sk w="34ch" /></p>
          </div>
        </div>
        <div className="pl-actions">
          <span className="btn" aria-disabled="true">Swap</span>
          <span className="btn btn-primary" aria-disabled="true">Add liquidity</span>
        </div>
      </header>
      <div className="tk-grid">
        <div className="tk-main">
          <section className="tk-chart">
            <div className="tk-chart-top"><div><p className="tk-price"><Sk w="9ch" /></p><p className="tk-change"><Sk w="9ch" /></p></div></div>
            <Sk block w="100%" h={260} />
          </section>
          <section className="stack">
            <h2 className="pl-h2">Transactions</h2>
            <div className="table-scroll" tabIndex={0}>
              <table className="data">
                <thead><tr><th>Time</th><th>Type</th><th className="num">Value</th><th className="num"><Sk w="4ch" /></th><th className="num"><Sk w="4ch" /></th><th>Wallet</th></tr></thead>
                <tbody><SkRows cols={6} rows={5} num={[2, 3, 4]} /></tbody>
              </table>
            </div>
          </section>
        </div>
        <aside className="tk-side">
          <div className="panel pl-panel">
            <h2 className="pl-h3">Stats</h2>
            <Sk block w="100%" h={10} />
            <dl className="pl-stats">
              {["TVL", "Volume 24h", "Fees 24h", "Swaps 24h", "Fee now"].map((l) => <div key={l}><dt>{l}</dt><dd><Sk w="8ch" /></dd></div>)}
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Execution price of a swap as token1 per token0. */
function swapPrice(s: SwapEvent, pool: MarketPool): number {
  const inIs0 = s.tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
  const a0 = Number(inIs0 ? s.amountIn : s.amountOut) / 10 ** pool.token0.decimals;
  const a1 = Number(inIs0 ? s.amountOut : s.amountIn) / 10 ** pool.token1.decimals;
  return a1 / a0;
}

function PoolView({ pool }: { pool: MarketPool }) {
  const swaps = usePoolSwaps(pool.address, SWAP_LIMIT);
  const quoteSym = QUOTE?.symbol ?? "quote";
  const hasQuote = pool.token0.isQuote || pool.token1.isQuote;
  // Price the non-quote token in the quote token by default, like "1 ETH = 3,400 USDC".
  const [inverted, setInverted] = useState(pool.token0.isQuote && !pool.token1.isQuote);
  const base = inverted ? pool.token1 : pool.token0;
  const counter = inverted ? pool.token0 : pool.token1;
  const orient = (p: number) => (inverted ? 1 / p : p);
  const [range, setRange] = useState<number>(DAY);
  const [kind, setKind] = useState<ChartKind>("price");
  const now = Math.floor(Date.now() / 1000);

  const points = useMemo(() => {
    const pts = (swaps.data ?? [])
      .slice()
      .reverse()
      .map((s) => ({ t: s.timestamp, price: orient(swapPrice(s, pool)) }))
      .filter((p) => Number.isFinite(p.price) && p.price > 0);
    // After the last trade the pool sits at its current price until the next one.
    if (pts.length && pool.price) {
      const last = pts[pts.length - 1]!.t;
      pts.push({ t: last, price: orient(pool.price) }, { t: Math.max(now, last), price: orient(pool.price) });
    }
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swaps.data, pool, inverted]);

  const shown = useMemo(() => {
    if (!range) return points;
    const from = now - range;
    const inside = points.filter((p) => p.t >= from);
    const before = points.filter((p) => p.t < from).pop();
    return before ? [{ t: from, price: before.price }, ...inside] : inside;
  }, [points, range, now]);

  const current = pool.price ? orient(pool.price) : null;
  const change = shown.length > 1 ? (shown[shown.length - 1]!.price - shown[0]!.price) / shown[0]!.price : null;
  const up = change === null ? null : change >= 0;

  // Volume per swap: its value in the quote token, or the token1 side when the pool has no quote token.
  const volUnit = hasQuote ? quoteSym : pool.token1.symbol;
  const volumes = useMemo(
    () =>
      (swaps.data ?? []).map((s) => {
        const inIs1 = s.tokenIn.toLowerCase() === pool.token1.address.toLowerCase();
        const v = hasQuote ? s.quoteValue ?? 0 : Number(inIs1 ? s.amountIn : s.amountOut) / 10 ** pool.token1.decimals;
        return { t: s.timestamp, v };
      }),
    [swaps.data, pool, hasQuote],
  );
  const capped = (swaps.data?.length ?? 0) >= SWAP_LIMIT;
  const oldest = swaps.data?.length ? swaps.data[swaps.data.length - 1]!.timestamp : null;
  const rangeVolume = volumes.filter((v) => !range || v.t >= now - range).reduce((a, v) => a + v.v, 0);
  const rangeLabel = range === DAY ? "past day" : range === 7 * DAY ? "past week" : "all indexed trades";

  const kinds: [ChartKind, string][] = [["price", "Price"], ["volume", "Volume"], ...(pool.kind === "dlmm" ? [["liquidity", "Liquidity"] as [ChartKind, string]] : [])];

  return (
    <div className="wrap tk pl has-mbar">
      <BackLink />

      <header className="tk-head">
        <div className="tk-id">
          <TokenPair pool={pool} size={48} />
          <div className="tk-id-text">
            <div className="tk-name">
              <h1>{pairLabel(pool)}</h1>
              <span className={`tag ${pool.kind === "dlmm" ? "tag-public" : "tag-illustration"}`}>{kindLabel(pool)}</span>
              <span className="tag tag-illustration mono">{fmtBps(pool.fees.currentBps)}</span>
            </div>
            <p className="tk-meta">
              <CopyAddress value={pool.address} />
              <a href={explorerTx(pool.createdTx)} target="_blank" rel="noreferrer">Created in block {pool.createdBlock.toLocaleString("en-US")}</a>
              {pool.creator && <span>by <Link className="mono" to="/profile/$address" params={{ address: pool.creator }}>{shortAddress(pool.creator)}</Link></span>}
              {pool.launch && <span>Graduated from <Link to="/launch/$token" params={{ token: pool.launch }}>a launch</Link></span>}
            </p>
          </div>
        </div>
        <div className="pl-actions">
          <Link to="/swap" search={{ from: counter.address, to: base.address }} className="btn">Swap</Link>
          <Link to="/pools/$pool/add" params={{ pool: pool.address }} className="btn btn-primary">Add liquidity</Link>
        </div>
      </header>

      <div className="tk-grid">
        <div className="tk-main">
          <section className="tk-chart" aria-labelledby="pl-price">
            <div className="tk-chart-top">
              <div>
                {kind === "volume" ? (
                  <>
                    <p id="pl-price" className="tk-price mono">{fmtNumber(rangeVolume, rangeVolume < 100 ? 2 : 0)} <span>{volUnit}</span></p>
                    <p className="tk-change muted">Volume, {rangeLabel}</p>
                  </>
                ) : (
                  <>
                    <p id="pl-price" className="tk-price mono">
                      {current !== null ? fmtPrice(current) : "–"} <span>{counter.symbol}</span>
                    </p>
                    <p className="tk-change">
                      <button type="button" className="pl-invert" onClick={() => setInverted((v) => !v)} aria-label={`Show the price of ${counter.symbol} instead`}>
                        1 {base.symbol} = {current !== null ? fmtPrice(current) : "–"} {counter.symbol}
                        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      {kind === "price" && (
                        <span className={change === null ? "muted" : change >= 0 ? "good-text" : "bad-text"}>
                          {change === null ? "" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%`}
                        </span>
                      )}
                    </p>
                  </>
                )}
              </div>
              <div className="pl-toggles">
                <div className="seg" role="group" aria-label="Chart" style={{ marginTop: 0 }}>
                  {kinds.map(([k, label]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
                </div>
                {kind !== "liquidity" && (
                  <div className="seg" role="group" aria-label="Chart range" style={{ marginTop: 0 }}>
                    {RANGES.map(([label, secs]) => <button key={label} type="button" aria-pressed={range === secs} onClick={() => setRange(secs)}>{label}</button>)}
                  </div>
                )}
              </div>
            </div>
            {kind === "liquidity" ? (
              <LiveBins pool={pool} />
            ) : swaps.isLoading ? (
              <Sk block w="100%" h={260} />
            ) : kind === "price" ? (
              <PriceChart points={shown} height={260} axis fmt={(n) => fmtPrice(n)} up={up} />
            ) : (
              <VolumeChart items={volumes} range={range} now={now} unit={volUnit} />
            )}
            {kind !== "liquidity" && (
              <p className="small muted" style={{ margin: 0 }}>
                {kind === "price" ? `${counter.symbol} per ${base.symbol}, one point per indexed trade.` : `Traded value in ${volUnit}${hasQuote ? "" : ` (the ${pool.token1.symbol} side of each trade)`}.`}
                {capped && oldest ? ` Drawn from the latest ${SWAP_LIMIT} trades, back to ${new Date(oldest * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` : ""}
              </p>
            )}
          </section>

          <section className="stack">
            <div className="row-between">
              <h2 className="pl-h2">Transactions</h2>
              <IndexerNote />
            </div>
            <Transactions pool={pool} swaps={swaps} base={base} quoteSym={quoteSym} hasQuote={hasQuote} />
          </section>
        </div>

        <aside className="tk-side" aria-label="Pool stats">
          <div className="panel pl-panel">
            <h2 className="pl-h3">Stats</h2>
            <Balances pool={pool} />
            <dl className="pl-stats">
              <div><dt>TVL</dt><dd>{pool.tvlQuote !== null ? <>{fmtNumber(pool.tvlQuote, 0)} <span>{quoteSym}</span></> : "–"}</dd></div>
              <div><dt>Volume 24h</dt><dd>{fmtNumber(pool.volume24hQuote, 0)} <span>{quoteSym}</span></dd></div>
              <div><dt>Fees 24h</dt><dd>{fmtNumber(pool.fees24hQuote, 2)} <span>{quoteSym}</span></dd></div>
              <div><dt>Swaps 24h</dt><dd>{pool.swaps24h.toLocaleString("en-US")}</dd></div>
              <div><dt>Fee now</dt><dd>{fmtBps(pool.fees.currentBps)}</dd></div>
            </dl>
            <p className="small muted" style={{ margin: 0 }}>
              {pool.kind === "damm"
                ? `Base fee ${fmtBps(pool.fees.baseBps)}, rising with volatility to at most ${fmtBps(pool.fees.maxBps)}.`
                : `Fixed fee ${fmtBps(pool.fees.baseBps)} with bin step ${pool.binStep} (${((pool.binStep ?? 0) / 100).toFixed(2)}% between bins).`}{" "}
              {100 - pool.fees.protocolShareBps / 100}% of fees go to liquidity providers, {pool.fees.protocolShareBps / 100}% to the protocol.
              {!hasQuote && ` Values in ${quoteSym} are shown only for pools that trade against it.`}
            </p>
          </div>

          <div className="panel pl-panel">
            <h2 className="pl-h3">Links</h2>
            <dl className="pl-links">
              <div><dt><TokenPair pool={pool} size={18} /> {pairLabel(pool)}</dt><dd><CopyAddress value={pool.address} /></dd></div>
              {[pool.token0, pool.token1].map((t) => (
                <div key={t.address}><dt><TokenDisc token={t} /> {t.symbol}</dt><dd><CopyAddress value={t.address} /></dd></div>
              ))}
            </dl>
          </div>
        </aside>
      </div>

      <div className="tk-mbar" role="region" aria-label="Pool actions">
        <div className="tk-mbar-price">
          <span className="tk-label">{base.symbol}</span>
          <strong className="mono">{current !== null ? fmtPrice(current) : "–"} <span>{counter.symbol}</span></strong>
        </div>
        <Link to="/swap" search={{ from: counter.address, to: base.address }} className="btn">Swap</Link>
        <Link to="/pools/$pool/add" params={{ pool: pool.address }} className="btn btn-primary">Add</Link>
      </div>
    </div>
  );
}

/** What the pool holds, and the split by value. */
function Balances({ pool }: { pool: MarketPool }) {
  const a0 = pool.reserves.amount0 ?? 0;
  const a1 = pool.reserves.amount1 ?? 0;
  const v0 = pool.price ? a0 * pool.price : 0;
  const share0 = v0 + a1 > 0 ? v0 / (v0 + a1) : 0.5;
  return (
    <div className="pl-balances">
      <span className="tk-label">Pool balances</span>
      <div className="pl-bal-row">
        <span className="mono">{fmtAmount(pool.reserves.raw0, pool.token0.decimals, 4)} <span className="muted">{pool.token0.symbol}</span></span>
        <span className="mono">{fmtAmount(pool.reserves.raw1, pool.token1.decimals, 2)} <span className="muted">{pool.token1.symbol}</span></span>
      </div>
      <div className="split-bar" role="img" aria-label={`${Math.round(share0 * 100)}% ${pool.token0.symbol} and ${Math.round((1 - share0) * 100)}% ${pool.token1.symbol} by value`}>
        <div style={{ width: `${share0 * 100}%`, background: "var(--chart)" }} />
        <div style={{ width: `${(1 - share0) * 100}%`, background: "var(--ink)" }} />
      </div>
    </div>
  );
}

function Transactions({ pool, swaps, base, quoteSym, hasQuote }: { pool: MarketPool; swaps: ReturnType<typeof usePoolSwaps>; base: TokenRef; quoteSym: string; hasQuote: boolean }) {
  const [shown, setShown] = useState(25);
  const rows = swaps.data ?? [];
  return (
    <>
      <div className="table-scroll" tabIndex={0}>
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              {hasQuote && <th className="num">Value ({quoteSym})</th>}
              <th className="num">{pool.token0.symbol}</th>
              <th className="num">{pool.token1.symbol}</th>
              <th>Wallet</th>
            </tr>
          </thead>
          <tbody>
            {swaps.isLoading && <SkRows cols={hasQuote ? 6 : 5} rows={5} num={hasQuote ? [2, 3, 4] : [2, 3]} />}
            {swaps.isError && <tr><td colSpan={6} className="muted">Trades could not be loaded. <button className="btn btn-sm" onClick={() => swaps.refetch()}>Retry</button></td></tr>}
            {!swaps.isLoading && rows.length === 0 && !swaps.isError && <tr><td colSpan={6} className="muted">No trades yet. The first one appears here a few seconds after it confirms.</td></tr>}
            {rows.slice(0, shown).map((s) => {
              const inIs0 = s.tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
              const buy = s.tokenOut.toLowerCase() === base.address.toLowerCase();
              return (
                <tr key={`${s.txHash}-${s.logIndex}`}>
                  <td className="small"><a href={explorerTx(s.txHash)} target="_blank" rel="noreferrer" title={new Date(s.timestamp * 1000).toLocaleString()}>{timeAgo(s.timestamp)}</a></td>
                  <td className={`small ${buy ? "good-text" : "bad-text"}`}>{buy ? "Buy" : "Sell"} {base.symbol}</td>
                  {hasQuote && <td className="num mono">{s.quoteValue !== null ? fmtNumber(s.quoteValue, 2) : "–"}</td>}
                  <td className="num mono">{fmtAmount(inIs0 ? s.amountIn : s.amountOut, pool.token0.decimals)}</td>
                  <td className="num mono">{fmtAmount(inIs0 ? s.amountOut : s.amountIn, pool.token1.decimals)}</td>
                  <td className="mono small"><Link to="/profile/$address" params={{ address: s.recipient }}>{shortAddress(s.recipient)}</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && <button type="button" className="btn btn-sm pl-more" onClick={() => setShown((n) => n + 25)}>Show more trades</button>}
    </>
  );
}

/** Traded value per hour (1D), per six hours (1W) or per day (All). */
function VolumeChart({ items, range, now, unit, height = 260 }: { items: { t: number; v: number }[]; range: number; now: number; unit: string; height?: number }) {
  const step = range === DAY ? HOUR : range ? 6 * HOUR : DAY;
  const oldest = items.length ? Math.min(...items.map((i) => i.t)) : now;
  const from = range ? now - range : Math.min(oldest, now - 7 * DAY);
  const start = Math.floor(from / step) * step;
  const n = Math.min(200, Math.max(1, Math.ceil((now - start) / step)));
  const buckets = Array.from({ length: n }, (_, i) => ({ t: start + i * step, v: 0 }));
  for (const it of items) {
    const i = Math.floor((it.t - start) / step);
    if (i >= 0 && i < n) buckets[i]!.v += it.v;
  }
  const max = Math.max(...buckets.map((b) => b.v));
  if (!(max > 0)) {
    return (
      <div className="chart-empty" style={{ minHeight: height }}>
        <p className="small muted" style={{ margin: 0 }}>No trades in this range.</p>
      </div>
    );
  }
  const w = 100 / n;
  const top = height - 10;
  const date = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + (step < DAY ? ` ${new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "");
  return (
    <figure className="pchart" style={{ margin: 0 }}>
      <div className="pchart-plot" style={{ height }}>
        <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={`Traded value per ${step === HOUR ? "hour" : step === DAY ? "day" : "six hours"}, up to ${fmtNumber(max, 2)} ${unit}`} style={{ width: "100%", height, display: "block" }}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2="100" y1={height * f} y2={height * f} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />)}
          {buckets.map((b, i) => {
            const h = (b.v / max) * top;
            return b.v > 0 ? <rect key={b.t} x={i * w + w * 0.15} width={w * 0.7} y={height - h} height={h} fill="var(--chart)"><title>{`${date(b.t)}: ${fmtNumber(b.v, 2)} ${unit}`}</title></rect> : null;
          })}
        </svg>
        <span className="pchart-y" style={{ top: height - top }}>{fmtNumber(max, max < 100 ? 2 : 0)}</span>
        <span className="pchart-y" style={{ top: height }}>0</span>
      </div>
      <figcaption className="pchart-x"><span>{date(start)}</span><span>{date(start + (n - 1) * step)}</span></figcaption>
    </figure>
  );
}

function LiveBins({ pool }: { pool: MarketPool }) {
  const active = pool.activeId ?? 0;
  const ids = useMemo(() => Array.from({ length: RADIUS * 2 + 1 }, (_, i) => active - RADIUS + i), [active]);
  const bins = useReadContract({ address: pool.address, abi: dlmmPairAbi, functionName: "getBins", args: [ids], query: { enabled: pool.activeId !== null, refetchInterval: 15_000 } });
  const price = (id: number) => binPrice(id, pool.binStep!, pool.token0.decimals, pool.token1.decimals);
  const bars = (bins.data ?? []).map((b, i) => {
    const id = ids[i]!;
    const x = Number(formatUnits(b.x, pool.token0.decimals)) * price(id);
    const y = Number(formatUnits(b.y, pool.token1.decimals));
    return { id, x, y };
  });
  if (bins.isError) return <p className="notice bad">Could not read bins from the chain.</p>;
  return (
    <>
      {bins.isLoading
        ? <Sk block h={260} w="100%" />
        : <BinChart bins={bars} activeId={pool.activeId} height={240} label={`Liquidity in ${bars.length} bins around the active price`} formatPrice={(id) => fmtPrice(price(id))} symbols={[pool.token0.symbol, pool.token1.symbol]} />}
      <p className="small muted" style={{ margin: 0 }}>
        Liquidity in the {RADIUS * 2 + 1} bins around the active bin ({active.toLocaleString("en-US")}, at {fmtPrice(price(active))} {pool.token1.symbol}), valued in {pool.token1.symbol}. Read live from the pair contract.
      </p>
    </>
  );
}
