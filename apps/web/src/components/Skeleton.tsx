/**
 * Skeleton placeholders for data that is still loading. Labels, headings and anything else known
 * up front render as normal; only the parts that wait on data use these.
 */
import type { CSSProperties } from "react";

/** One shimmering bar, inline by default so it sits where the value will be. */
export function Sk({ w = "6ch", h, block = false, style }: { w?: number | string; h?: number | string; block?: boolean; style?: CSSProperties }) {
  return <span className={`skeleton sk${block ? " sk-block" : ""}`} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

/** Table rows whose cells are skeleton bars. `num` marks right-aligned columns. */
export function SkRows({ cols, rows = 3, num = [] }: { cols: number; rows?: number; num?: number[] }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j} className={num.includes(j) ? "num" : undefined}><Sk w={j === 0 ? "9ch" : "6ch"} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Lines of text still loading, the last one shorter. */
export function SkLines({ lines = 2 }: { lines?: number }) {
  return (
    <span className="sk-lines" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <Sk key={i} block w={i === lines - 1 && lines > 1 ? "60%" : "100%"} />)}
    </span>
  );
}

/** For screen readers: says the region is loading while the bars show. */
export function Loading({ label }: { label: string }) {
  return <span className="sr-only" role="status">{label}</span>;
}

/** A notice whose text is still loading: the box keeps its place, the text is two bars. */
export function SkNotice({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`notice ${className}`} aria-busy="true">
      <Loading label={label} />
      <SkLines lines={2} />
    </div>
  );
}
