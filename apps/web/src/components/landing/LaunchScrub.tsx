/**
 * Launch demo: a token's life plays out on the standard template, from the first buy to the
 * LP escrow. Reserves rise with buys and fall with sells; at the threshold the curve stops and
 * its reserves seed a DAMM pool whose LP shares are locked.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { DitherCanvas, type Scene } from "../Dither";
import { usePlayhead, useNarrow, seeded, fmt } from "./play";
import { Stat } from "./Stat";
import { useT } from "../../lib/i18n";

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
const STAGES_ZH = ["已创建", "交易中", "可毕业", "已毕业", "LP 托管"] as const;
const STAGE_TEXT_ZH = [
  "创建者选择一个经过审核的模板。供应量、曲线、费率、门槛和锁仓期在任何人交易前就已固定。",
  "买卖双方在联合曲线上交易。只有净储备计入毕业进度，手续费从不计入，所以卖出会降低进度。",
  "达到门槛后，曲线交易停止。任何人都可以触发迁移，但没人能改变迁移的去向。",
  "储备和代币注入一个 DAMM 资金池。如果价格容差或最低 LP 检查不通过，迁移会回滚。",
  "LP 份额进入托管：创建者的 20% 锁定 180 天，协议的 80% 锁定 365 天。",
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
  const tx = useT();
  const stages = tx<readonly string[]>(STAGES, STAGES_ZH);
  const stageText = tx(STAGE_TEXT, STAGE_TEXT_ZH);
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
        <ol className="stage-row" aria-label={tx("Launch lifecycle", "发行生命周期")}>
          {stages.map((s, n) => (
            <li key={n} data-state={n === stage ? "active" : n < stage ? "done" : undefined} aria-current={n === stage ? "step" : undefined}>
              <span className="mono">{String(n + 1).padStart(2, "0")}</span> {s}
            </li>
          ))}
        </ol>
        <figure className="demo-chart" aria-label={tx("Net reserves over the launch", "发行过程中的净储备")}>
          <div className="dot-stage">
          <DitherCanvas make={make} aspect={H / W} cell={narrow ? 3 : 4} animate fps={20} />
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tx(`${STAGES[stage]}: ${fmt(res)} of ${fmt(THRESHOLD)} USDG`, `${STAGES_ZH[stage]}：${fmt(res)} / ${fmt(THRESHOLD)} USDG`)}>
            <line x1={x0} x2={W - 12} y1={sy(THRESHOLD)} y2={sy(THRESHOLD)} stroke="var(--muted)" strokeDasharray="4 5" />
            <text x={x0 + 4} y={sy(THRESHOLD) - 8} fontSize={fs} fill="var(--muted)">{tx(`Graduation at ${fmt(THRESHOLD)} USDG`, `毕业门槛 ${fmt(THRESHOLD)} USDG`)}</text>
            {!graduated && <rect x={sx(k) - 4} y={sy(res) - 4} width={8} height={8} fill="#ffffff" />}
            <line x1={x0} x2={x1} y1={y0 + 0.5} y2={y0 + 0.5} stroke="var(--line-strong)" />
            <text x={x0} y={y0 + 20} fontSize={fs} fill="var(--faint)">{tx("First buy", "首笔买入")}</text>
            <text x={x1} y={y0 + 20} fontSize={fs} fill="var(--faint)" textAnchor="end">{tx("Threshold", "门槛")}</text>
            {/* Pool side */}
            <g className={`pool-side ${graduated ? "on" : ""}`}>
              <rect x={x1 + 22} y={y1 + 18} width={poolW} height={y0 - y1 - 18} rx={6} />
              <text x={poolMid} y={y1 + 44} textAnchor="middle" className="t1">{tx("DAMM pool", "DAMM 资金池")}</text>
              <text x={poolMid} y={y1 + 62} textAnchor="middle" className="t2">{narrow ? tx("from the curve", "来自曲线") : tx("seeded by the curve", "由曲线注入")}</text>
            </g>
          </svg>
          </div>
          <div className="timeline" aria-hidden="true">
            <span className="timeline-bar"><i style={{ width: `${t * 100}%` }} /></span>
            <span className="mono small demo-scrub-val">{stage === 4 ? tx(`Day ${day} of escrow`, `托管第 ${day} 天`) : stage >= 2 ? tx("Curve closed", "曲线已关闭") : tx(`Trade ${k}`, `第 ${k} 笔交易`)}</span>
          </div>
          <div className="demo-legend small">
            <span><i className="lg line" /> {tx("Buys", "买入")}</span><span><i className="lg sell" /> {tx("Sells lower progress", "卖出降低进度")}</span><span><i className="lg dash" /> {tx("Graduation threshold", "毕业门槛")}</span>
          </div>
        </figure>
        <div className="stat-row">
          <Stat label={tx("Net reserves", "净储备")} value={`${fmt(res)} USDG`} sub={tx(`${progress.toFixed(1)}% of the threshold`, `已达门槛的 ${progress.toFixed(1)}%`)} bar={progress / 100} />
          <Stat label={tx("Curve price", "曲线价格")} value={`${curvePrice(res).toFixed(6)}`} sub={tx("USDG per token, set by the template", "每个代币的 USDG 价格，由模板决定")} />
          <div className="stat escrow" data-on={graduated || undefined}>
            <span className="stat-label">{tx("LP escrow", "LP 托管")}</span>
            <Lock who={tx("Creator 20%", "创建者 20%")} days={180} day={day} on={graduated} />
            <Lock who={tx("Protocol 80%", "协议 80%")} days={365} day={day} on={graduated} />
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{stages[stage]}. {stageText[stage]}</p>
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
  const t = useT();
  return (
    <div className="lock-row">
      <span className="small">{who}</span>
      <span className="lock-bar"><i style={{ width: `${on ? Math.min(100, (day / days) * 100) : 0}%` }} /></span>
      <span className="mono small faint">{!on ? t(`${days} d`, `${days} 天`) : open ? t("Unlocked", "已解锁") : t(`${days - day} d left`, `剩 ${days - day} 天`)}</span>
    </div>
  );
}
