import { useId } from "react";
import { useT, tNow } from "../lib/i18n";

/**
 * Execution prices of recent trades, oldest to newest. Says so; it is not a candle feed.
 * With `axis`, the high, low and latest price are labelled and the line gets a soft fill.
 */
export function PriceChart({ points, height = 140, axis = false, fmt = (n: number) => n.toPrecision(5), up }: {
  points: { t: number; price: number }[];
  height?: number;
  axis?: boolean;
  fmt?: (n: number) => string;
  /** Colours the line by direction over the shown range; omitted keeps the neutral chart colour. */
  up?: boolean | null;
}) {
  const t = useT();
  const gid = useId().replace(/:/g, "");
  if (points.length < 2) {
    return (
      <div className="chart-empty" style={{ minHeight: axis ? height : undefined }}>
        <p className="small muted" style={{ margin: 0 }}>{t("Not enough trades yet to draw a price line. It appears after the second trade.", "成交数量还不足以绘制价格线，第二笔成交后会显示。")}</p>
      </div>
    );
  }
  const ps = points.map((p) => p.price);
  const lo0 = Math.min(...ps);
  const hi = Math.max(...ps);
  const span = hi - lo0 || hi * 0.01 || 1;
  // A flat line sits in the middle of the plot, not on its floor.
  const lo = hi === lo0 ? lo0 - span / 2 : lo0;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const dt = t1 - t0;
  const pad = axis ? 14 : 6;
  // Trades in one block share a timestamp; when time cannot separate them, space them evenly.
  const x = (p: { t: number }, i: number) => (dt > 0 ? (p.t - t0) / dt : i / (points.length - 1)) * 100;
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p, i).toFixed(2)},${y(p.price).toFixed(2)}`).join(" ");
  const last = points[points.length - 1]!;
  const colour = up === true ? "var(--good)" : up === false ? "var(--bad)" : "var(--chart)";
  const label = tNow(`Execution price of the last ${points.length} trades, from ${lo0.toPrecision(5)} to ${hi.toPrecision(5)}`, `最近 ${points.length} 笔成交的执行价格，从 ${lo0.toPrecision(5)} 到 ${hi.toPrecision(5)}`);

  if (!axis) {
    return (
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ width: "100%", height }}>
        <path d={line} fill="none" stroke={colour} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  const date = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + (dt < 86_400 * 2 ? ` ${new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "");
  return (
    <figure className="pchart" style={{ margin: 0 }}>
      <div className="pchart-plot" style={{ height }}>
        <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ width: "100%", height, display: "block" }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colour} stopOpacity="0.28" />
              <stop offset="100%" stopColor={colour} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2="100" y1={height * f} y2={height * f} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />)}
          <path d={`${line} L100,${height} L0,${height} Z`} fill={`url(#${gid})`} stroke="none" />
          <path d={line} fill="none" stroke={colour} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          <line x1="0" x2="100" y1={y(last.price)} y2={y(last.price)} stroke={colour} strokeOpacity="0.5" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="pchart-dot" style={{ top: y(last.price), background: colour, boxShadow: `0 0 0 4px color-mix(in srgb, ${colour} 25%, transparent)` }} aria-hidden="true" />
        <span className="pchart-y" style={{ top: y(hi) }}>{fmt(hi)}</span>
        {lo0 !== hi && <span className="pchart-y" style={{ top: y(lo) }}>{fmt(lo)}</span>}
        <span className="pchart-y pchart-last" style={{ top: y(last.price), background: colour }}>{fmt(last.price)}</span>
      </div>
      <figcaption className="pchart-x"><span>{date(t0)}</span><span>{date(t1)}</span></figcaption>
    </figure>
  );
}
