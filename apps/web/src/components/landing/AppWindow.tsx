/**
 * An animated market page: candles scroll in, the active liquidity bin follows the price, and
 * trades land in the feed. Shielded trades show the trade, never the trader. Plays by itself.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DitherCanvas, NOISE, type Scene } from "../Dither";
import { useInView, useNarrow, seeded, fmt } from "./play";
import { usePrefersReducedMotion } from "../../lib/motion";

const P0 = 3_000;
const CANDLES = 46;
const BINS = 31;
const STEP = 0.0022;
type Candle = { o: number; h: number; l: number; c: number };
type Trade = { id: number; buy: boolean; eth: number; price: number; owner: string | null };

const OWNERS = ["0x3f2a…91c4", "0x8b10…e2d7", "0x51c9…07ab", "0xa4e2…5b19", "0x9c4e…a2f0"];

function makeFeed() {
  const r = seeded(29);
  let p = P0;
  let id = 0;
  const next = () => {
    const buy = r() < 0.5 + (P0 - p) / P0 * 6;
    const eth = Math.round((0.05 + r() * r() * 2.4) * 1000) / 1000;
    const o = p;
    p = p * (1 + (buy ? 1 : -1) * eth * 0.0011 + (r() - 0.5) * 0.0018);
    const c = p;
    const candle: Candle = { o, c, h: Math.max(o, c) * (1 + r() * 0.0012), l: Math.min(o, c) * (1 - r() * 0.0012) };
    const trade: Trade = { id: id++, buy, eth, price: c, owner: r() < 0.45 ? null : OWNERS[Math.floor(r() * OWNERS.length)]! };
    return { candle, trade };
  };
  const candles: Candle[] = [];
  const trades: Trade[] = [];
  for (let k = 0; k < CANDLES; k++) { const n = next(); candles.push(n.candle); trades.unshift(n.trade); }
  return { next, candles, trades: trades.slice(0, 7) };
}

export function AppWindow() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const reduced = usePrefersReducedMotion();
  const feed = useMemo(makeFeed, []);
  const [state, setState] = useState(() => ({ candles: feed.candles, trades: feed.trades }));
  useEffect(() => {
    if (!inView || reduced) return;
    const id = window.setInterval(() => {
      const n = feed.next();
      setState((s) => ({ candles: [...s.candles.slice(1), n.candle], trades: [n.trade, ...s.trades].slice(0, 7) }));
    }, 1400);
    return () => window.clearInterval(id);
  }, [inView, reduced, feed]);

  const { candles, trades } = state;
  const last = candles[candles.length - 1]!.c;
  const first = candles[0]!.o;
  const change = (last / first - 1) * 100;
  const active = Math.max(0, Math.min(BINS - 1, Math.round(Math.log(last / P0) / Math.log(1 + STEP)) + (BINS - 1) / 2));

  return (
    <div ref={ref} className="app-window">
      <div className="aw-top">
        <div className="aw-pair">
          <span className="aw-coin" aria-hidden="true"><i /><i /></span>
          <strong>ETH / USDG</strong>
          <span className="muted small hide-sm">DLMM pool · 0.22% bins</span>
        </div>
        <div className="aw-price">
          <span className="mono">{fmt(last, 2)}</span>
          <span className={`mono small ${change >= 0 ? "good-text" : "bad-text"}`}>{change >= 0 ? "+" : "−"}{Math.abs(change).toFixed(2)}%</span>
        </div>
        <div className="aw-tabs hide-sm" aria-hidden="true"><span className="on">Chart</span><span>Liquidity</span><span>Positions</span></div>
      </div>
      <div className="aw-body">
        <div className="aw-main">
          <MarketDots candles={candles} active={active} />
          <p className="aw-cap mono">Price above, liquidity bins below · the active bin follows the price</p>
        </div>
        <div className="aw-feed">
          <p className="aw-feed-h"><span className="dot good pulse" aria-hidden="true" /> Trades</p>
          <ul aria-label="Recent trades">
            {trades.map((t) => (
              <li key={t.id}>
                <span className={t.buy ? "good-text" : "bad-text"}>{t.buy ? "Buy" : "Sell"}</span>
                <span className="mono">{t.eth.toFixed(3)} ETH</span>
                <span className="mono muted">{fmt(t.price, 0)}</span>
                <span className="aw-owner">
                  {t.owner ? <span className="mono">{t.owner}</span> : <span className="aw-hidden" role="img" aria-label="Owner hidden"><DitherCanvas make={NOISE} aspect={0.2} cell={3} animate fps={10} /></span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="aw-legend small"><span className="tag tag-shielded">Shielded</span> trades show the trade, not the trader.</p>
        </div>
      </div>
    </div>
  );
}

/** Share of the canvas used by the price chart; the bins sit below it. */
const CHART = 0.7;
const GAP = 0.06;
/** Room on the right for the price tag, as a share of the width. */
const TAG = 0.09;

type Src = { candles: Candle[]; active: number };
/** Candles, the last price and the bins, drawn as dithered dots. Reads `src` on every frame. */
function makeMarket(src: { current: Src }): (cols: number, rows: number) => Scene {
  let seen: Candle[] | null = null, hi = 0, span = 1, last = 0;
  return () => (i, j, cols, rows, t) => {
    const { candles, active } = src.current;
    if (candles !== seen) {
      seen = candles;
      hi = Math.max(...candles.map((c) => c.h));
      span = Math.max(hi - Math.min(...candles.map((c) => c.l)), 1e-9);
      last = candles[candles.length - 1]!.c;
    }
    const y = (j + 0.5) / rows;
    const x = (i + 0.5) / cols;
    if (y < CHART) {
      const price = hi + span * 0.08 - (y / CHART) * span * 1.16;
      const half = (0.5 / rows / CHART) * span * 1.16;
      if (x > 1 - TAG) return Math.abs(price - last) <= half ? 0.9 : 0;
      const slot = (1 - TAG) / candles.length;
      const n = Math.floor(x / slot);
      const c = candles[n];
      if (!c) return 0;
      const up = c.c >= c.o;
      const off = Math.abs(x - (n + 0.5) * slot) / slot;
      const top = Math.max(c.o, c.c) + half, bot = Math.min(c.o, c.c) - half;
      const lit = n === candles.length - 1 ? 0.2 * Math.sin(t * 6) : 0;
      if (off < 0.34 && price <= top && price >= bot) return (up ? 0.74 : 0.4) + lit;
      if (off < 0.5 / (cols * slot) + 0.02 && price <= c.h && price >= c.l) return up ? 0.6 : 0.33;
      if (Math.abs(price - last) <= half && i % 3 !== 2) return 0.55;
      // Faint grid every quarter.
      const g = (y / CHART) * 4;
      return Math.abs(g - Math.round(g)) < 0.5 / rows * 4 / CHART && i % 4 === 0 && g > 0.5 ? 0.18 : 0;
    }
    if (y < CHART + GAP) return 0;
    const u = (y - CHART - GAP) / (1 - CHART - GAP); // 0 at the top of the bins, 1 at the floor
    const b = Math.floor(x * BINS);
    const inner = (x * BINS) % 1;
    if (inner > 0.82) return 0;
    const d = (b - (BINS - 1) / 2) / ((BINS - 1) / 2);
    const h = 0.18 + 0.82 * Math.exp(-5 * d * d);
    if (1 - u > h) return 0;
    const depth = (1 - u) / h; // 1 at the top of the bar
    if (b === active) return 0.85 + 0.15 * depth;
    return (b < active ? 0.2 : 0.42) + depth * 0.2;
  };
}

function MarketDots({ candles, active }: { candles: Candle[]; active: number }) {
  const narrow = useNarrow(560);
  const shown = narrow ? candles.slice(-24) : candles;
  const src = useRef<Src>({ candles: shown, active });
  src.current = { candles: shown, active };
  const make = useMemo(() => makeMarket(src), []);
  const last = shown[shown.length - 1]!.c;
  const hi = Math.max(...shown.map((c) => c.h)), lo = Math.min(...shown.map((c) => c.l));
  const span = Math.max(hi - lo, 1e-9);
  const tagY = ((hi + span * 0.08 - last) / (span * 1.16)) * CHART * 100;
  return (
    <div className="aw-dots">
      <DitherCanvas make={make} aspect={narrow ? 0.62 : 0.44} cell={narrow ? 3 : 4} animate fps={12} label={`Sample price chart, last ${fmt(last, 2)}`} />
      <span className="aw-tag mono" style={{ top: `${tagY}%` }}>{fmt(last, 0)}</span>
    </div>
  );
}
