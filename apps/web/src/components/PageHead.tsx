/**
 * The head of every app page, set like the landing page's section heads: a mono kicker with its
 * first word in blue, a large white title, a muted lead and, on wide screens, a small dithered
 * scene for the page on the right.
 */
import { useRef, type ReactNode } from "react";
import { DitherCanvas, makeBins, makeLiqLine, type Scene } from "./Dither";
import { SHIELD_SWEEP } from "./landing/Fields";
import { useAspect } from "./landing/HeroArt";

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const hash = (i: number, j: number) => { const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return h - Math.floor(h); };

/** Swap: routes fan out from one token to the other, direct or through a middle token, with pulses running along them. */
function makeRoute(): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows, t) => {
    const x = (i + 0.5) / cols, mid = rows * 0.5;
    const A = 0.1, B = 0.9;
    const cx = i + 0.5, cy = j + 0.5;
    // The two tokens at the ends, and a middle token on each two-hop route.
    const node = (nx: number, ny: number, r: number) => Math.hypot(cx - nx * cols, cy - ny) < r;
    if (node(A, mid, 3.2) || node(B, mid, 3.2)) return 0.95;
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const spread = (k - 2) * rows * 0.2;
      const bulge = Math.sin(Math.PI * clamp((x - A) / (B - A)));
      const y = mid + spread * Math.pow(bulge, 0.75);
      if (k !== 2 && node(0.5, mid + spread, 2.2)) return 0.8;
      if (x < A || x > B || Math.abs(cy - y) > 0.7) continue;
      const p = (x - t * 0.09 - k * 0.23) % 1;
      const q = ((p < 0 ? p + 1 : p) - 0.5) / 0.03;
      v = Math.max(v, (k === 2 ? 0.45 : 0.28) + 0.65 * Math.exp(-(q * q)));
    }
    return clamp(v);
  };
}

/** Liquidity: price bins that ease between the spot, curve and bid-ask shapes. */
function makeShapes(): (cols: number, rows: number) => Scene {
  return (cols) => {
    const bw = Math.max(4, Math.round(cols / 34));
    const nb = Math.floor(cols / bw);
    const shape = (k: number, b: number) => {
      const d = (b + 0.5) / nb - 0.5;
      if (k === 0) return 0.5;
      if (k === 1) return 0.12 + 0.78 * Math.exp(-((d / 0.2) ** 2));
      return 0.14 + 0.76 * Math.min(1, (d / 0.5) ** 2 * 1.1);
    };
    return (i, j, _c, rows, t) => {
      if (i % bw === bw - 1) return 0;
      const b = Math.floor(i / bw);
      if (b >= nb) return 0;
      const phase = (t / 4 + 1) % 3, k = Math.floor(phase), f = smooth(0.7, 1, phase - k);
      const h = shape(k, b) * (1 - f) + shape((k + 1) % 3, b) * f;
      const top = rows * (1 - h * 0.92);
      if (j < top) return 0;
      const active = b === Math.floor(nb / 2);
      if (active) return 0.95;
      if (j - top < 1) return 0.7;
      return b < nb / 2 ? 0.25 : 0.48;
    };
  };
}

/** Launch: a bonding curve filling towards its graduation threshold, again and again. */
function makeCurve(): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows, t) => {
    const x = (i + 0.5) / cols;
    const curve = (u: number) => rows * (0.92 - 0.8 * Math.pow(u, 1.7));
    const y = curve(x);
    const cycle = (t * 0.085) % 1.25;
    const prog = Math.min(1, cycle) * 0.86;
    const thresholdX = 0.86;
    const edge = smooth(0, 0.06, x);
    // Threshold: a dashed vertical line where the curve graduates.
    if (Math.abs(x - thresholdX) < 0.5 / cols && j % 3 !== 2 && j > curve(thresholdX) - 2) return 0.55;
    if (Math.abs(j + 0.5 - y) < 0.75) return (x <= prog ? 0.95 : 0.32) * edge;
    if (j > y && x <= prog) {
      const lead = x > prog - 1.5 / cols;
      if (lead) return 0.9;
      const depth = (j - y) / (rows - y + 1);
      return (0.46 - depth * 0.18) * edge * (hash(i, j) > 0.12 ? 1 : 0.4);
    }
    return hash(i, j) > 0.985 ? 0.14 : 0;
  };
}

export const PAGE_ART = {
  bins: makeBins({ x: null }),
  route: makeRoute(),
  shapes: makeShapes(),
  curve: makeCurve(),
  liq: makeLiqLine(),
  shield: SHIELD_SWEEP,
} as const;
export type PageArtKind = keyof typeof PAGE_ART;

function Art({ kind }: { kind: PageArtKind }) {
  const ref = useRef<HTMLDivElement>(null);
  const aspect = useAspect(ref);
  return (
    <div ref={ref} className={`page-art art-${kind}`} aria-hidden="true">
      <DitherCanvas make={PAGE_ART[kind]} aspect={aspect} cell={4} animate fps={12} />
    </div>
  );
}

export function PageHead({ kicker, label, title, lead, art, children }: {
  kicker: ReactNode;
  label?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  art?: PageArtKind;
  children?: ReactNode;
}) {
  return (
    <header className={`page-head${art ? " with-art" : ""}`}>
      <div className="page-head-text">
        <p className="eyebrow"><span className="eyebrow-n">{kicker}</span>{label && <> {label}</>}</p>
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </div>
      {art && <Art kind={art} />}
    </header>
  );
}
