/**
 * Launch demo: a token's life plays out on the standard template, from the first buy to the
 * LP escrow. Reserves rise with buys and fall with sells; at the threshold the curve stops and
 * its reserves seed a DAMM pool whose LP shares are locked.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { DitherCanvas, type Scene } from "../Dither";
import { usePlayhead, useNarrow, seeded, fmt } from "./play";
import { Stat } from "./Stat";

const THRESHOLD = 25_000;
const N = 90;
const STAGES = ["Created", "Trading", "Graduation ready", "Graduated", "LP escrow"] as const;
const STAGE_TEXT = [
  "The creator picks a reviewed template. Supply, curve, fees, threshold and locks are fixed before anyone trades.",
  "Buyers and sellers trade on the bonding curve. Only net reserves count towards graduation, never fees, so sells lower progress.",
  "The threshold is reached and curve trading stops. Anyone can trigger migration; nobody can change where it goes.",
  "Reserves and tokens seed a DAMM pool. Migration reverts if price tolerance or minimum LP checks fail.",
  "LP shares sit in escrow: the creator's 20% for 180 days, the protocol's 80% for 365 days.",
];
// Where each stage starts on the 0–1 timeline.
const AT = [0, 0.04, 0.72, 0.8, 0.9];

function reservePath(): number[] {
  const r = seeded(7);
  const inc = Array.from({ length: N }, (_, k) => {
    const sell = (k >= 27 && k <= 33) || (k >= 57 && k <= 61) || r() < 0.08;
    return sell ? -(250 + r() * 650) : 260 + r() * 520;
  });
  const c = [0];
  for (const d of inc) c.push(Math.max(0, c[c.length - 1]! + d));
  const s = THRESHOLD / Math.max(...c);
  const out = c.map((v) => v * s);
  const hit = out.findIndex((v) => v >= THRESHOLD - 1e-6);
  return out.slice(0, hit + 1).map((v) => Math.min(THRESHOLD, v));
}

const curvePrice = (res: number) => 0.00001 * Math.pow(1 + (3 * res) / THRESHOLD, 2);

export function LaunchScrub({ head }: { head?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const ph = usePlayhead(ref, 18, { rest: 0.5 });
  const path = useMemo(reservePath, []);
  const t = ph.t;
  const stage = AT.reduce((acc, a, n) => (t >= a ? n : acc), 0);
  const k = Math.round(Math.min(1, Math.max(0, (t - AT[1]!) / (AT[2]! - AT[1]!))) * (path.length - 1));
  const res = path[k]!;
  const progress = (res / THRESHOLD) * 100;
  const day = stage === 4 ? Math.min(365, Math.round(((t - AT[4]!) / (1 - AT[4]!)) * 400)) : 0;
  const graduated = stage >= 3;

  const narrow = useNarrow(560);
  const fs = narrow ? 14 : 11;
  const W = narrow ? 380 : 640, H = 230, x0 = 20, y0 = 196, y1 = 26;
  const poolW = narrow ? 96 : 154, x1 = W - 12 - poolW - 22, nBins = narrow ? 5 : 9;
  const poolMid = x1 + 22 + poolW / 2;
  const sx = (n: number) => x0 + (n / (path.length - 1)) * (x1 - x0);
  const sy = (v: number) => y0 - (v / THRESHOLD) * (y0 - y1);
  const src = useRef<CurveSrc>(null!);
  src.current = { path, k, graduated, W, H, x0, x1, y0, y1, poolX: x1 + 22, poolW, nBins };
  const make = useMemo(() => makeCurve(src), []);

  return (
    <div ref={ref} className="split">
      <div className="split-side">
        {head}
      </div>
      <div className="split-main">
        <ol className="stage-row" aria-label="Launch lifecycle">
          {STAGES.map((s, n) => (
            <li key={s} data-state={n === stage ? "active" : n < stage ? "done" : undefined} aria-current={n === stage ? "step" : undefined}>
              <span className="mono">{String(n + 1).padStart(2, "0")}</span> {s}
            </li>
          ))}
        </ol>
        <figure className="demo-chart" aria-label="Net reserves over the launch">
          <div className="dot-stage">
          <DitherCanvas make={make} aspect={H / W} cell={narrow ? 3 : 4} animate fps={20} />
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${STAGES[stage]}: ${fmt(res)} of ${fmt(THRESHOLD)} USDG`}>
            <line x1={x0} x2={W - 12} y1={sy(THRESHOLD)} y2={sy(THRESHOLD)} stroke="var(--muted)" strokeDasharray="4 5" />
            <text x={x0 + 4} y={sy(THRESHOLD) - 8} fontSize={fs} fill="var(--muted)">Graduation at {fmt(THRESHOLD)} USDG</text>
            {!graduated && <rect x={sx(k) - 4} y={sy(res) - 4} width={8} height={8} fill="#ffffff" />}
            <line x1={x0} x2={x1} y1={y0 + 0.5} y2={y0 + 0.5} stroke="var(--line-strong)" />
            <text x={x0} y={y0 + 20} fontSize={fs} fill="var(--faint)">First buy</text>
            <text x={x1} y={y0 + 20} fontSize={fs} fill="var(--faint)" textAnchor="end">Threshold</text>
            {/* Pool side */}
            <g className={`pool-side ${graduated ? "on" : ""}`}>
              <rect x={x1 + 22} y={y1 + 18} width={poolW} height={y0 - y1 - 18} rx={6} />
              <text x={poolMid} y={y1 + 44} textAnchor="middle" className="t1">DAMM pool</text>
              <text x={poolMid} y={y1 + 62} textAnchor="middle" className="t2">{narrow ? "from the curve" : "seeded by the curve"}</text>
            </g>
          </svg>
          </div>
          <div className="timeline" aria-hidden="true">
            <span className="timeline-bar"><i style={{ width: `${t * 100}%` }} /></span>
            <span className="mono small demo-scrub-val">{stage === 4 ? `Day ${day} of escrow` : stage >= 2 ? "Curve closed" : `Trade ${k}`}</span>
          </div>
          <div className="demo-legend small">
            <span><i className="lg line" /> Buys</span><span><i className="lg sell" /> Sells lower progress</span><span><i className="lg dash" /> Graduation threshold</span>
          </div>
        </figure>
        <div className="stat-row">
          <Stat label="Net reserves" value={`${fmt(res)} USDG`} sub={`${progress.toFixed(1)}% of the threshold`} bar={progress / 100} />
          <Stat label="Curve price" value={`${curvePrice(res).toFixed(6)}`} sub="USDG per token, set by the template" />
          <div className="stat escrow" data-on={graduated || undefined}>
            <span className="stat-label">LP escrow</span>
            <Lock who="Creator 20%" days={180} day={day} on={graduated} />
            <Lock who="Protocol 80%" days={365} day={day} on={graduated} />
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{STAGES[stage]}. {STAGE_TEXT[stage]}</p>
    </div>
  );
}

type CurveSrc = { path: number[]; k: number; graduated: boolean; W: number; H: number; x0: number; x1: number; y0: number; y1: number; poolX: number; poolW: number; nBins: number };

/**
 * The reserve line and the area under it as dithered dots (sells in red), plus the pool's bins,
 * which light up once the launch graduates. Coordinates follow the SVG drawn on top.
 */
function makeCurve(src: { current: CurveSrc }): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows) => {
    const { path, k, graduated, W, H, x0, x1, y0, y1, poolX, poolW, nBins } = src.current;
    const X = ((i + 0.5) / cols) * W, Y = ((j + 0.5) / rows) * H;
    const cw = W / cols;
    const sy = (v: number) => y0 - (v / THRESHOLD) * (y0 - y1);
    const last = x0 + (k / (path.length - 1)) * (x1 - x0);
    if (X >= x0 && X <= last + cw * 0.5) {
      const f = ((X - x0) / (x1 - x0)) * (path.length - 1);
      const a = Math.min(k, Math.floor(f)), b = Math.min(k, a + 1);
      const v = path[a]! + (path[b]! - path[a]!) * (f - a);
      const ly = sy(v);
      if (Math.abs(Y - ly) <= cw * 0.9) return path[b]! < path[a]! ? -0.8 : 0.78;
      if (Y > ly && Y < y0) return Math.max(0.05, 0.34 - ((Y - ly) / (y0 - y1)) * 0.5);
      return 0;
    }
    // The DAMM pool's bins, under the labels of the pool box.
    const mid = poolX + poolW / 2, slot = 16, span = nBins * slot;
    const bx = X - (mid - span / 2);
    if (bx >= 0 && bx < span && bx % slot < 11) {
      const n = Math.floor(bx / slot);
      const h = 18 + 34 * Math.exp(-((n - (nBins - 1) / 2) ** 2) / 10);
      const top = y0 - 12 - h;
      if (Y >= top && Y <= y0 - 12) {
        const depth = (Y - top) / h; // 0 at the top
        return graduated ? 0.62 - depth * 0.3 : 0.16;
      }
    }
    return 0;
  };
}

function Lock({ who, days, day, on }: { who: string; days: number; day: number; on: boolean }) {
  const open = on && day >= days;
  return (
    <div className="lock-row">
      <span className="small">{who}</span>
      <span className="lock-bar"><i style={{ width: `${on ? Math.min(100, (day / days) * 100) : 0}%` }} /></span>
      <span className="mono small faint">{!on ? `${days} d` : open ? "Unlocked" : `${days - day} d left`}</span>
    </div>
  );
}
