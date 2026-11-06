/** A labelled number with an optional note and bar, used by the landing demos. */
export function Stat({ label, value, sub, bar }: { label: string; value: string; sub?: string; bar?: number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
      {bar !== undefined && <span className="stat-bar"><i style={{ width: `${Math.max(2, bar * 100)}%` }} /></span>}
    </div>
  );
}
