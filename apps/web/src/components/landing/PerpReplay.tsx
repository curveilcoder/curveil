/**
 * Perps replay: the last 30 days of real prices (6-hour candles from Coinbase, one of the
 * oracle's sources) replay against each position's entry and liquidation price, then it moves
 * on to the next position. It plays by itself; picking a position is optional. If the prices
 * cannot be loaded, it falls back to a sample path and says so.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePlayhead, useNarrow, seeded, fmt } from "./play";
import { DotPattern } from "../Dither";
import { usePerpCandles, usePerpsOverview } from "../../lib/perps";
import { useT } from "../../lib/i18n";

const SAMPLE_PTS = 120;

/** Fallback only: a seeded path shaped like a dip and recovery, used when live prices are unavailable. */
function samplePath(e: number, seed: number): number[] {
  const r = seeded(seed);
  let n = 0;
  return Array.from({ length: SAMPLE_PTS }, (_, k) => {
    n = 0.75 * n + 0.25 * (r() - 0.5) * 0.05;
    const u = k / (SAMPLE_PTS - 1);
    return e * (1 - 0.18 * Math.exp(-(((u - 0.42) / 0.15) ** 2)) + 0.05 * u + (k === 0 ? 0 : n));
  });
}

const PRESETS = [
  { market: 1, base: "ETH", side: "long", lev: 5, ref: 3_000 },
  { market: 2, base: "BTC", side: "long", lev: 3, ref: 100_000 },
  { market: 1, base: "ETH", side: "short", lev: 4, ref: 3_000 },
  { market: 3, base: "SOL", side: "long", lev: 2, ref: 150 },
] as const;
const COLL = 1_000;
const priceDigits = (p: number) => (p >= 1_000 ? 0 : p >= 10 ? 2 : 4);

export function PerpReplay({ head }: { head?: ReactNode }) {
  const t = useT();
  const sideName = (s: "long" | "short") => (s === "long" ? t("long", "做多") : t("short", "做空"));
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const { market, base, side, lev, ref: refPrice } = PRESETS[idx]!;
  const coll = COLL;
  const ph = usePlayhead(ref, 5, { loop: false, rest: 1 });
  const eth = usePerpCandles(1, "1m");
  const btc = usePerpCandles(2, "1m");
  const sol = usePerpCandles(3, "1m");
  const q = market === 1 ? eth : market === 2 ? btc : sol;
  const overview = usePerpsOverview();
  const cfg = overview.data?.markets.find((x) => x.id === market)?.config;
  const MM = cfg ? Number(cfg.maintenanceMarginBps) / 10_000 : 0.02;
  const live = (q.data?.candles.length ?? 0) >= 20;
  const loading = !live && q.isLoading;
  const path = useMemo(() => (live ? q.data!.candles.map((c) => c.c) : samplePath(refPrice, 11 + idx * 7)), [live, q.data, refPrice, idx]);
  const PTS = path.length;
  const perDay = live ? Math.max(1, Math.round(86_400 / (q.data!.granularity || 21_600))) : 4;
  const E = path[0]!;
  const { restart } = ph;
  useEffect(() => { restart(); }, [idx, live, restart]);

  const liq = side === "long" ? E * (1 - 1 / lev + MM) : E * (1 + 1 / lev - MM);
  const hitAt = path.findIndex((p) => (side === "long" ? p <= liq : p >= liq));
  const k = Math.round(ph.t * (PTS - 1));
  const end = hitAt >= 0 && hitAt <= k ? hitAt : k;
  const liquidated = hitAt >= 0 && hitAt <= k;
  const pNow = path[end]!;
  const pnl = (side === "long" ? 1 : -1) * lev * (pNow / E - 1) * coll;
  const dist = (Math.abs(liq - E) / E) * 100;
  const days = Math.max(1, Math.round(PTS / perDay));
  const dayOf = (n: number) => Math.min(days, Math.max(1, Math.ceil((n + 1) / perDay)));
  const d = priceDigits(E);
  const { pause, playing, reduced } = ph;
  useEffect(() => { if (liquidated && playing) pause(); }, [liquidated, playing, pause]);
  // When a replay ends, hold the result for a moment, then move to the next position.
  const finished = !playing && (liquidated || ph.t >= 1);
  useEffect(() => {
    if (!finished || reduced) return;
    const id = window.setTimeout(() => setIdx((i) => (i + 1) % PRESETS.length), 2600);
    return () => window.clearTimeout(id);
  }, [finished, reduced]);

  const lo = Math.max(E * 0.55, Math.min(...path, liq) * 0.97);
  const hi = Math.min(E * 1.45, Math.max(...path, liq) * 1.03);
  const narrow = useNarrow(560);
  const fs = narrow ? 14 : 11;
  const W = narrow ? 380 : 640, H = 240, x0 = 8, x1 = W - 8, y0 = 214, y1 = 14;
  const sx = (n: number) => x0 + (n / (PTS - 1)) * (x1 - x0);
  const sy = (v: number) => y0 - ((v - lo) / (hi - lo)) * (y0 - y1);
  const ly = Math.min(y0, Math.max(y1, sy(liq)));
  const offChart = liq < lo || liq > hi;

  return (
    <div ref={ref} className="split split-r">
      <div className="split-side">
        {head}
      </div>
      <div className="split-main">
        <div className="stage-row pos-row" role="group" aria-label={t("Positions, 1,000 USDG margin each", "示例仓位，每个保证金 1,000 USDG")}>
          {PRESETS.map((x, n) => (
            <button key={n} type="button" aria-pressed={idx === n} data-state={idx === n ? "active" : undefined} onClick={() => setIdx(n)} title={t(`${x.base} ${x.side} at ${x.lev}×, opened at the start of the chart`, `${x.base} ${x.lev} 倍${sideName(x.side)}，在图表起点开仓`)}>
              {idx === n && !reduced && <i className="rule-timer" style={{ width: `${ph.t * 100}%` }} />}
              <span className="mono">{String(n + 1).padStart(2, "0")}</span> {x.base} {sideName(x.side)} {x.lev}×
            </button>
          ))}
        </div>
        <figure className="demo-chart perp-chart" aria-label={t(`${base} price over the last ${days} days, with entry and liquidation price`, `${base} 过去 ${days} 天的价格，含开仓价和强平价`)}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={liquidated ? t(`Liquidated on day ${dayOf(hitAt)}`, `第 ${dayOf(hitAt)} 天被强平`) : t(`Position open, ${pnl >= 0 ? "up" : "down"} ${fmt(Math.abs(pnl))} USDG`, `仓位持有中，${pnl >= 0 ? "盈利" : "亏损"} ${fmt(Math.abs(pnl))} USDG`)}>
            <defs><DotPattern id="liq-zone" color="#ff7a7a" density={0.22} cell={3} /></defs>
            {!offChart && (
              <rect x={x0} width={x1 - x0} y={side === "long" ? ly : y1} height={side === "long" ? y0 - ly : ly - y1} fill="url(#liq-zone)" opacity={0.45} />
            )}
            <line x1={x0} x2={x1} y1={sy(E)} y2={sy(E)} stroke="var(--muted)" strokeDasharray="3 5" />
            <text x={x1 - 4} y={sy(E) - 7} textAnchor="end" fontSize={fs} fill="var(--muted)" stroke="var(--bg-deep)" strokeWidth={5} paintOrder="stroke">{t("Entry", "开仓价")} {fmt(E, d)}</text>
            <line x1={x0} x2={x1} y1={ly} y2={ly} stroke="#ff7a7a" strokeDasharray="6 4" />
            <text x={x1 - 4} y={side === "long" && !offChart ? ly + 16 : ly - 7} textAnchor="end" fontSize={fs} fill="#ff7a7a" stroke="var(--bg-deep)" strokeWidth={5} paintOrder="stroke">
              {t("Liquidation", "强平价")} {fmt(liq, d)}{offChart ? t(" · off chart", " · 超出图表") : ""}
            </text>
            {path.slice(0, end + 1).map((p, n) => (
              <rect key={n} x={sx(n) - 2.2} y={sy(p) - 2.2} width={4.4} height={4.4} fill={n === end ? "#ffffff" : n > end - 12 ? "#eef2fa" : "#7aa2ff"} />
            ))}
            {liquidated && (
              <g transform={`translate(${sx(hitAt)}, ${sy(path[hitAt]!)})`}>
                <circle r={11} fill="var(--bg)" stroke="#ff7a7a" strokeWidth={1.5} />
                <path d="M -4.5 -4.5 L 4.5 4.5 M 4.5 -4.5 L -4.5 4.5" stroke="#ff7a7a" strokeWidth={1.8} />
              </g>
            )}
            <text x={x0 + 2} y={H - 6} fontSize={fs} fill="var(--faint)">{live ? t(`${days} days ago`, `${days} 天前`) : t("Day 1", "第 1 天")}</text>
            <text x={x1 - 2} y={H - 6} fontSize={fs} fill="var(--faint)" textAnchor="end">{live ? t("Now", "现在") : t(`Day ${days}`, `第 ${days} 天`)}</text>
          </svg>
          <div className="timeline" aria-hidden="true">
            <span className="timeline-bar"><i style={{ width: `${(end / (PTS - 1)) * 100}%` }} /></span>
            <span className="mono small demo-scrub-val">{t(`Day ${dayOf(end)} of ${days}`, `第 ${dayOf(end)} / ${days} 天`)}</span>
          </div>
        </figure>
        <div className="stat-row">
          <div className="stat"><span className="stat-label">{t("Position size", "仓位规模")}</span><span className="stat-value">{fmt(coll * lev)} USDG</span><span className="stat-sub">{fmt(coll)} × {lev.toFixed(1)}</span></div>
          <div className="stat"><span className="stat-label">{t("Liquidation price", "强平价格")}</span><span className="stat-value bad-text">{fmt(liq, d)}</span><span className="stat-sub">{t(`${dist.toFixed(1)}% ${side === "long" ? "below" : "above"} entry`, `${side === "long" ? "低于" : "高于"}开仓价 ${dist.toFixed(1)}%`)}</span></div>
          <div className={`stat outcome ${liquidated ? "is-bad" : ""}`}>
            <span className="stat-label">{liquidated ? t("Outcome", "结果") : t(`Day ${dayOf(end)}`, `第 ${dayOf(end)} 天`)}</span>
            <span className={`stat-value ${liquidated ? "bad-text" : pnl >= 0 ? "good-text" : ""}`}>
              {liquidated ? t(`Liquidated, day ${dayOf(hitAt)}`, `第 ${dayOf(hitAt)} 天强平`) : `${pnl >= 0 ? "+" : "−"}${fmt(Math.abs(pnl))} USDG`}
            </span>
            <span className="stat-sub">{liquidated ? t("Collateral lost to the liquidation", "保证金因强平而损失") : t("Unrealised, before fees and funding", "未实现盈亏，未计手续费和资金费")}</span>
          </div>
        </div>
        <p className="demo-note small">
          {live
            ? t(`Real ${base} prices from the last ${days} days (6-hour closes from Coinbase, one of the oracle's sources), with the market's ${(MM * 100).toFixed(0)}% maintenance margin. Fees and funding are left out.`, `过去 ${days} 天的真实 ${base} 价格（来自预言机数据源之一 Coinbase 的 6 小时收盘价），按该市场 ${(MM * 100).toFixed(0)}% 的维持保证金计算，未计手续费和资金费。`)
            : loading
              ? t("Loading real prices…", "正在加载真实价格…")
              : t("Live prices could not be loaded, so this shows a sample path. Fees and funding are left out.", "无法加载实时价格，因此这里显示的是示例走势，未计手续费和资金费。")}
        </p>
      </div>
    </div>
  );
}
