/**
 * Dithered art: scenes rendered as a grid of electric-blue dots with ordered (Bayer) dithering,
 * so shading and depth come from dot density. Each scene is a function from a cell to a
 * brightness from 0 to 1. Animated scenes run only while on screen, and hold still when the
 * reader asks for reduced motion.
 */
import { useEffect, useRef } from "react";

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map((v) => (v + 0.5) / 64);
/** Dot colours from dim to bright; brightness 0 draws nothing. */
const INKS = ["#0f2a7a", "#2563ff", "#7aa2ff", "#e4ecff"];
/** Warning dots, used when a scene returns a negative brightness. */
const RED_INKS = ["#3d1420", "#9c3346", "#ff7a7a", "#ffd2d2"];

/**
 * Brightness of cell (i, j) of a cols × rows grid at time t (seconds), from 0 to 1.
 * A value from 0 to −1 draws the same brightness in warning red.
 */
export type Scene = (i: number, j: number, cols: number, rows: number, t: number) => number;
type Prepared = { cols: number; rows: number; scene: Scene };

function paint(ctx: CanvasRenderingContext2D, p: Prepared, cell: number, t: number) {
  const { cols, rows, scene } = p;
  ctx.clearRect(0, 0, cols * cell, rows * cell);
  const dot = Math.max(1, cell - 1);
  const levels = INKS.length;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const raw = scene(i, j, cols, rows, t);
      const v = Math.abs(raw);
      if (v <= 0.004) continue;
      const scaled = Math.min(0.9999, v) * levels;
      const base = Math.floor(scaled);
      const level = base + (scaled - base > BAYER[(j & 7) * 8 + (i & 7)]! ? 1 : 0);
      if (level === 0) continue;
      ctx.fillStyle = (raw < 0 ? RED_INKS : INKS)[level - 1]!;
      ctx.fillRect(i * cell, j * cell, dot, dot);
    }
  }
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A dithered canvas. `make` builds the scene for a grid size (it may precompute masks);
 * `cols` follows the canvas width at `cell` CSS pixels per dot, rows keep the aspect ratio.
 */
export function DitherCanvas({ make, aspect, cell = 4, animate = false, fps = 20, className = "", label }: {
  make: (cols: number, rows: number) => Scene;
  aspect: number; // height / width
  cell?: number;
  animate?: boolean;
  fps?: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let prepared: Prepared | null = null;
    let raf = 0, visible = false, last = -1;
    const t0 = performance.now();
    const still = !animate || reducedMotion();

    const size = () => {
      const w = Math.max(cell * 8, Math.round(canvas.clientWidth));
      const cols = Math.max(8, Math.floor(w / cell));
      const rows = Math.max(8, Math.round(cols * aspect));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = cols * cell * dpr;
      canvas.height = rows * cell * dpr;
      canvas.style.height = `${rows * cell}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      prepared = { cols, rows, scene: make(cols, rows) };
      paint(ctx, prepared, cell, 0);
    };
    const loop = (now: number) => {
      raf = 0;
      if (!visible || !prepared) return;
      if (now - last >= 1000 / fps) { last = now; paint(ctx, prepared, cell, (now - t0) / 1000); }
      raf = requestAnimationFrame(loop);
    };
    size();
    document.fonts?.ready.then(() => { if (ref.current) size(); });
    const ro = new ResizeObserver(() => size());
    ro.observe(canvas);
    const io = new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      if (visible && !still && !raf) raf = requestAnimationFrame(loop);
    });
    io.observe(canvas);
    return () => { ro.disconnect(); io.disconnect(); cancelAnimationFrame(raf); };
  }, [make, aspect, cell, animate, fps]);
  return <canvas ref={ref} className={`dither ${className}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/**
 * An SVG fill made of the same ordered dots: cells of an 8 × 8 Bayer tile whose threshold is
 * below `density` are drawn. Use inside <defs> and fill with url(#id).
 */
export function DotPattern({ id, color, density, cell = 4 }: { id: string; color: string; density: number; cell?: number }) {
  const dot = Math.max(1, cell - 1);
  return (
    <pattern id={id} width={cell * 8} height={cell * 8} patternUnits="userSpaceOnUse">
      {BAYER.map((b, k) => (b < density ? <rect key={k} x={(k % 8) * cell} y={Math.floor(k / 8) * cell} width={dot} height={dot} fill={color} /> : null))}
    </pattern>
  );
}

/* ---------- Scenes ---------- */
// Scene builders are created once at module level so they stay stable between renders.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** A lit planet with a tilted, banded ring; the light drifts slowly around it. */
export function makePlanet(): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows, t) => {
    const x = ((i + 0.5) / cols) * 2 - 1, y = ((j + 0.5) / rows) * 2 - 1;
    const a = 2.3 + 0.35 * Math.sin(t * 0.25);
    const L = [Math.cos(a) * 0.62, -0.55, Math.sin(a) * 0.62 + 0.45];
    const ll = Math.hypot(L[0]!, L[1]!, L[2]!);
    const lx = L[0]! / ll, ly = L[1]! / ll, lz = L[2]! / ll;
    const R = 0.46;
    // Ring plane through the centre, tilted towards the viewer.
    const nx = 0.18, ny = -0.93, nz = 0.32;
    const zr = -(nx * x + ny * y) / nz;
    const rho = Math.sqrt(x * x + y * y + zr * zr);
    const r2 = x * x + y * y;
    const zs = r2 < R * R ? Math.sqrt(R * R - r2) : -Infinity;
    const onRing = rho > R * 1.38 && rho < R * 1.98;
    if (onRing && zr > zs) {
      const u = (rho - R * 1.38) / (R * 0.6);
      const bands = 0.55 + 0.45 * Math.cos(u * 26) * Math.cos(u * 7.3);
      const gap = u > 0.58 && u < 0.64 ? 0.15 : 1;
      // Planet shadow on the ring.
      const d = x * lx + y * ly + zr * lz;
      const px = x - d * lx, py = y - d * ly, pz = zr - d * lz;
      const shadow = d < 0 && px * px + py * py + pz * pz < R * R ? 0.25 : 1;
      return clamp01((0.18 + 0.5 * bands) * gap * shadow * (1 - 0.35 * u));
    }
    if (zs > -Infinity) {
      const lam = Math.max(0, (x * lx + y * ly + zs * lz) / R);
      const rim = Math.pow(1 - zs / R, 3) * 0.25;
      return clamp01(0.04 + 0.96 * Math.pow(lam, 1.15) + rim);
    }
    // Faint halo and a few stars.
    const halo = Math.max(0, 0.1 - (Math.sqrt(r2) - R) * 0.9);
    const star = ((i * 73856093) ^ (j * 19349663)) % 997 === 0 ? 0.55 + 0.45 * Math.sin(t * 2 + i) : 0;
    return Math.max(halo, star);
  };
}

/** A bevelled shield with a keyhole, lit from the top left. */
export function makeShield(): (cols: number, rows: number) => Scene {
  return (cols, rows) => {
    // Rasterise the outline at grid resolution, then a chamfer distance transform gives the bevel.
    const c = document.createElement("canvas");
    c.width = cols; c.height = rows;
    const g = c.getContext("2d")!;
    g.scale(cols / 200, rows / 240);
    g.fillStyle = "#fff";
    g.fill(new Path2D("M100 14 L182 42 V118 C182 172 148 208 100 228 C52 208 18 172 18 118 V42 Z"));
    const outline = g.getImageData(0, 0, cols, rows).data;
    g.globalCompositeOperation = "destination-out";
    g.fill(new Path2D("M100 84a21 21 0 0 1 10.5 39.2l6.5 43.8h-34l6.5-43.8A21 21 0 0 1 100 84Z"));
    const px = g.getImageData(0, 0, cols, rows).data;
    const INF = 1e9, d = new Float32Array(cols * rows);
    for (let k = 0; k < cols * rows; k++) d[k] = px[k * 4 + 3]! > 127 ? INF : 0;
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : d[y * cols + x]!);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const k = y * cols + x; if (d[k]) d[k] = Math.min(d[k]!, at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414); }
    for (let y = rows - 1; y >= 0; y--) for (let x = cols - 1; x >= 0; x--) { const k = y * cols + x; if (d[k]) d[k] = Math.min(d[k]!, at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414); }
    const bevel = Math.max(3, cols * 0.1);
    const h = (x: number, y: number) => smooth(0, bevel, at(x, y));
    return (i, j) => {
      const dist = at(i, j);
      if (dist === 0) {
        if (outline[(j * cols + i) * 4 + 3]! > 127) return 0; // the keyhole
        // Glow just outside the edge.
        let near = INF;
        for (let r = 1; r <= 4 && near === INF; r++) if (at(i + r, j) || at(i - r, j) || at(i, j + r) || at(i, j - r)) near = r;
        return near === INF ? 0 : 0.2 / near;
      }
      const gx = h(i + 1, j) - h(i - 1, j), gy = h(i, j + 1) - h(i, j - 1);
      const nx = -gx * 2.2, ny = -gy * 2.2, nz = 1, nl = Math.hypot(nx, ny, nz);
      const lam = Math.max(0, (nx * -0.55 + ny * -0.6 + nz * 0.58) / nl);
      const face = 0.2 + 0.28 * (1 - j / rows);
      return clamp01(dist < bevel ? 0.08 + lam * 0.95 : face);
    };
  };
}

/** Water: rows of swell that brighten towards the bottom and drift slowly. */
export function makeWaves(): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows, t) => {
    const x = i / cols, y = j / rows;
    const swell = Math.sin(x * 18 + t * 0.6 + y * 9) * 0.5 + Math.sin(x * 41 - t * 0.9 + y * 4) * 0.25 + Math.sin(x * 7 + t * 0.3) * 0.25;
    const crest = Math.pow(0.5 + 0.5 * swell, 4);
    const depth = Math.pow(y, 2.2) * 0.42;
    const edge = smooth(0, 0.15, x) * smooth(0, 0.15, 1 - x);
    return clamp01((depth + crest * 0.5 * y) * edge);
  };
}

/** A word set in Geist, brightest at the top, for the footer. */
export function makeWord(word: string): (cols: number, rows: number) => Scene {
  return (cols, rows) => {
    const c = document.createElement("canvas");
    c.width = cols; c.height = rows;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    let size = rows * 1.05;
    g.font = `600 ${size}px "Geist Variable", system-ui, sans-serif`;
    const w = g.measureText(word).width;
    if (w > cols * 0.96) { size *= (cols * 0.96) / w; g.font = `600 ${size}px "Geist Variable", system-ui, sans-serif`; }
    g.fillText(word, cols / 2, rows * 0.86);
    const px = g.getImageData(0, 0, cols, rows).data;
    return (i, j) => {
      const a = px[(j * cols + i) * 4 + 3]! / 255;
      return a * (0.95 - 0.7 * (j / rows));
    };
  };
}

/** Shimmering dots: what an observer sees in place of a hidden value. */
export function makeNoise(): (cols: number, rows: number) => Scene {
  return () => (i, j, _cols, _rows, t) => {
    const f = Math.floor(t * 8);
    const h = Math.sin(i * 127.1 + j * 311.7 + f * 74.7) * 43758.5453;
    const v = h - Math.floor(h);
    return v < 0.45 ? 0 : 0.2 + (v - 0.45) * 1.3;
  };
}

/**
 * Liquidity bins across the page, like a DLMM pool: quote below the active bin, base above it.
 * The active bin follows the pointer when there is one and drifts on its own otherwise.
 */
export function makeBins(pointer: { x: number | null }): (cols: number, rows: number) => Scene {
  return (cols) => {
    const bw = Math.max(3, Math.round(cols / 62));
    const nb = Math.ceil(cols / bw);
    const jitter = Array.from({ length: nb }, (_, b) => { const h = Math.sin(b * 91.7) * 43758.5453; return h - Math.floor(h); });
    let lastT = -1, active = nb * 0.5, heights: number[] = [];
    const frame = (t: number) => {
      const target = pointer.x === null ? 0.5 + 0.2 * Math.sin(t * 0.32) : pointer.x;
      active += (target * nb - active) * (lastT < 0 ? 1 : 0.18);
      lastT = t;
      heights = jitter.map((r, b) => {
        const d = (b - nb / 2) / (nb * 0.24);
        const shape = 0.14 + 0.66 * Math.exp(-d * d) + 0.14 * r;
        return clamp01(shape + 0.05 * Math.sin(b * 0.8 + t * 1.1));
      });
    };
    return (i, j, cols, rows, t) => {
      if (t !== lastT) frame(t);
      const x = i / cols;
      const edge = smooth(0, 0.1, x) * smooth(0, 0.1, 1 - x);
      const h0 = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
      const speck = h0 - Math.floor(h0);
      const bg = speck > 0.9 ? 0.1 + (speck - 0.9) * 0.8 : 0;
      if (i % bw === bw - 1) return bg * 0.6;
      const b = Math.floor(i / bw);
      const top = rows * (1 - heights[b]! * edge);
      if (j < top) return bg;
      // Solid ink levels: dim for quote, blue for base, white for the active bin, a bright cap on top.
      const depth = (j - top) / Math.max(1, rows - top);
      const a = Math.round(active);
      if (b === a) return clamp01(1 - depth * 0.3);
      if (j - top < 1) return 0.74;
      return (b < a ? 0.249 : 0.499) * (1 - depth * 0.25);
    };
  };
}

/** Encrypted notes: rows of small blocks that shimmer, with a bright sweep passing through. */
export function makeNotes(): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows, t) => {
    const bw = 7, bh = 3;
    const bx = Math.floor(i / bw), by = Math.floor(j / bh);
    if (i % bw === bw - 1 || j % bh === bh - 1) return 0;
    const nbx = Math.ceil(cols / bw);
    const h = Math.sin(bx * 91.3 + by * 47.7 + Math.floor(t * 2 + bx * 0.37) * 13.1) * 43758.5453;
    const base = 0.18 + 0.3 * (h - Math.floor(h));
    const sweep = Math.exp(-(((bx + by * 0.6 - ((t * 5) % (nbx + 8)) + 4) / 1.6) ** 2));
    const p = Math.sin(i * 12.9898 + j * 78.233 + Math.floor(t * 8) * 3.7) * 43758.5453;
    const on = p - Math.floor(p) > 0.3 ? 1 : 0.35;
    return clamp01((base + sweep * 0.7) * on * smooth(0, 0.45, j / rows));
  };
}

/** A price line drifting left above a dashed liquidation line. */
export function makeLiqLine(): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows, t) => {
    const x = i + t * 7;
    const y = rows * (0.42 + 0.16 * Math.sin(x / 11) + 0.07 * Math.sin(x / 3.9) + 0.04 * Math.sin(x / 1.7));
    const liq = Math.round(rows * 0.84);
    const fade = smooth(0, 0.35, j / rows) * smooth(0, 0.08, i / cols);
    if (j === liq) return (i % 4 < 2 ? 0.5 : 0) * fade;
    const d = Math.abs(j - y);
    if (d < 0.9) return fade * (i > cols - 3 ? 1 : 0.78);
    if (j > y && j < liq) return fade * 0.12 * (1 - (j - y) / (liq - y));
    return 0;
  };
}

export const PLANET = makePlanet();
export const SHIELD = makeShield();
export const WAVES = makeWaves();
export const NOISE = makeNoise();

