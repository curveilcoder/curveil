/**
 * Liquidity by bin: value of each bin in token1 terms, with X shown as the public colour and
 * Y as ink. Used for live pair state and for deposit previews.
 */
export type BinBar = { id: number; x: number; y: number; highlight?: boolean };

export function BinChart({ bins, activeId, height = 160, label, formatPrice, symbols = ["token X", "token Y"] }: { bins: BinBar[]; activeId: number | null; height?: number; label: string; formatPrice?: (id: number) => string; symbols?: [string, string] }) {
  if (bins.length === 0) return <p className="small muted">No liquidity in this range.</p>;
  const max = Math.max(...bins.map((b) => b.x + b.y), 1e-18);
  const w = 100 / bins.length;
  const first = bins[0]!.id;
  const last = bins[bins.length - 1]!.id;
  return (
    <figure className="bin-chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ width: "100%", height }}>
        {bins.map((b, i) => {
          const hy = ((b.y / max) * (height - 8)) || 0;
          const hx = ((b.x / max) * (height - 8)) || 0;
          return (
            <g key={b.id} opacity={b.highlight === false ? 0.35 : 1}>
              <rect x={i * w + w * 0.1} width={w * 0.8} y={height - hy} height={hy} fill="var(--ink)" />
              <rect x={i * w + w * 0.1} width={w * 0.8} y={height - hy - hx} height={hx} fill="var(--chart)" />
              {b.id === activeId && <rect x={i * w} width={w} y={0} height={height} fill="none" stroke="var(--muted)" strokeWidth={0.4} vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />}
            </g>
          );
        })}
      </svg>
      <figcaption className="bin-legend small muted">
        <span><span className="swatch" style={{ background: "var(--chart)" }} /> {symbols[0]}</span>
        <span><span className="swatch" style={{ background: "var(--ink)" }} /> {symbols[1]}</span>
        {activeId !== null && <span><span className="swatch" style={{ border: "1px dashed var(--muted)" }} /> active bin</span>}
        {formatPrice && <span className="mono" style={{ marginLeft: "auto" }}>{formatPrice(first)} – {formatPrice(last)}</span>}
      </figcaption>
    </figure>
  );
}
