/**
 * Hero art: a round dithered lens that rebuilds itself into each product, with the matching
 * label lit underneath, above a U-shaped ribbon of dithered silk along the bottom.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { DitherCanvas, type Scene } from "../Dither";
import { usePrefersReducedMotion } from "../../lib/motion";

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hash = (i: number, j: number) => {
  let h = (i * 374761393 + j * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/* ---------- Silk ---------- */

/**
 * A ribbon of dithered silk bent into a U along the bottom of the hero: high at both edges,
 * dipping off the bottom in the middle, with the price curve glowing along it.
 */
export function makeSilkU(): (cols: number, rows: number) => Scene {
  return (cols, rows) => {
    const aspect = cols / rows;
    return (i, j, _c, _r, t) => {
      const x = (i + 0.5) / cols, y = (j + 0.5) / rows;
      const u = 2 * x - 1;
      const mid = 1.05 - 0.36 * u * u + 0.012 * Math.sin(x * 9 + t * 0.4);
      const half = 0.085 + 0.05 * u * u;
      const off = (y - mid) / half; // -1 at the ribbon's top edge, 1 at its bottom edge
      if (off < -1.25 || off > 1.4) return 0;
      const X = x * aspect * 1.1, Y = off * 0.9;
      const f = (X: number, Y: number) => 0.07 * Math.sin(2.6 * X + 2 * Y + t * 0.5) + 0.04 * Math.sin(5 * X - 3.5 * Y - t * 0.7) + 0.015 * Math.sin(11 * X + 6 * Y + t * 1.1);
      const e = 0.004;
      const dzx = (f(X + e, Y) - f(X - e, Y)) / (2 * e), dzy = (f(X, Y + e) - f(X, Y - e)) / (2 * e);
      const lam = Math.max(0, (0.55 * dzx + 0.5 * dzy + 0.67) / Math.hypot(dzx, dzy, 1));
      const body = clamp(1.25 - Math.abs(off)) ** 1.4;
      let v = (0.06 + Math.pow(lam, 3) * 0.6) * body;
      const line = -0.25 + 0.12 * Math.sin(x * 7 - t * 0.35);
      v += Math.exp(-(((off - line) / 0.12) ** 2)) * (0.35 + 0.45 * lam);
      return clamp(v);
    };
  };
}

/** Height over width of an element, kept up to date. */
export function useAspect(ref: RefObject<HTMLElement | null>) {
  const [aspect, setAspect] = useState(0.6);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => { const r = el.getBoundingClientRect(); if (r.width) setAspect((a) => (Math.abs(a - r.height / r.width) > 0.01 ? r.height / r.width : a)); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return aspect;
}

/* ---------- Lens ---------- */

export const PRODUCTS = ["Swap", "Provide liquidity", "Launch a token", "Trade perps", "Run a launchpad"];
const HOLD = 3; // seconds per product
const FIT = 0.74; // shape scale inside the ring

// Each product as a brightness field over the 0–1 square (negative is warning red).
const SHAPES: ((x: number, y: number) => number)[] = [
  (x, y) => {
    const top = (Math.abs(y - 0.36) < 0.05 && x > 0.18 && x < 0.66) || (x >= 0.66 && x < 0.8 && Math.abs(y - 0.36) < (0.17 * (0.8 - x)) / 0.14);
    const bot = (Math.abs(y - 0.64) < 0.05 && x > 0.34 && x < 0.82) || (x <= 0.34 && x > 0.2 && Math.abs(y - 0.64) < (0.17 * (x - 0.2)) / 0.14);
    return top ? 0.92 : bot ? 0.55 : 0;
  },
  (x, y) => {
    const N = 15, n = Math.floor(x * N);
    if ((x * N) % 1 > 0.7) return 0;
    const d = (n - (N - 1) / 2) / ((N - 1) / 2);
    const h = 0.1 + 0.7 * Math.exp(-3 * d * d), yy = 0.88 - y;
    if (yy < 0 || yy > h) return 0;
    return n === 8 ? 1 : n < 8 ? 0.3 + (0.2 * yy) / h : 0.5 + (0.25 * yy) / h;
  },
  (x, y) => {
    if (Math.abs(y - 0.16) < 0.008 && Math.floor(x * 60) % 3 !== 0) return 0.5;
    if (x < 0.6) {
      const u = x / 0.6, cy = 0.86 - 0.7 * u * u;
      if (Math.abs(y - cy) < 0.02) return 0.92;
      return y > cy && y < 0.86 ? 0.38 - (y - cy) * 0.3 : 0;
    }
    if (x > 0.66 && x < 0.96) {
      const n = Math.floor((x - 0.66) * 20);
      if (((x - 0.66) * 20) % 1 > 0.68) return 0;
      const h = 0.12 + 0.3 * Math.exp(-((n - 2.5) ** 2) / 4);
      if (y > 0.86 - h && y < 0.86) return 0.62;
    }
    return 0;
  },
  (x, y) => {
    const liq = 0.72, hx = 0.64;
    if (Math.abs(y - liq) < 0.008 && Math.floor(x * 45) % 3 !== 2) return -0.75;
    if (x < hx) {
      const py = 0.3 + 0.08 * Math.sin(x * 9) + 0.42 * Math.max(0, (x - 0.25) / (hx - 0.25)) ** 1.6;
      if (Math.abs(y - Math.min(liq, py)) < 0.02) return x > 0.4 ? 1 : 0.75;
    }
    if (Math.hypot(x - hx, y - liq) < 0.05 && (Math.abs(x - hx - (y - liq)) < 0.012 || Math.abs(x - hx + (y - liq)) < 0.012)) return -1;
    if (Math.abs(y - 0.3) < 0.006 && Math.floor(x * 45) % 3 === 0) return 0.45;
    if (y > liq + 0.04 && y < 0.9 && hash(Math.floor(x * 100), Math.floor(y * 100)) < 0.1) return -0.4;
    return 0;
  },
  (x, y) => {
    const L = 0.12, R = 0.88, T = 0.1, B = 0.9;
    if (x < L || x > R || y < T || y > B) return 0;
    if (x - L < 0.02 || R - x < 0.02 || y - T < 0.02 || B - y < 0.02) return 0.75;
    if (y < 0.2) return Math.abs(y - 0.155) < 0.015 && x < 0.24 && Math.floor(x * 120) % 3 < 2 ? 0.5 : 0.1;
    if (x > 0.18 && x < 0.3 && y > 0.25 && y < 0.37) return 0.95;
    if (x > 0.34 && x < 0.6 && Math.abs(y - 0.31) < 0.025) return 0.75;
    if (x > 0.66 && x < 0.82 && y > 0.26 && y < 0.36) return 0.62;
    for (let r = 0; r < 3; r++) {
      const ry = 0.5 + r * 0.13;
      if (Math.abs(y - ry) < 0.045 && x > 0.18 && x < 0.82) {
        const fill = [0.75, 0.55, 0.35][r]!;
        if (x > 0.5 && x < 0.5 + 0.3 * fill && Math.abs(y - ry) < 0.012) return 0.8;
        if (x > 0.5 && x < 0.8 && Math.abs(y - ry) < 0.012) return 0.2;
        if (x > 0.2 && x < 0.3 && Math.abs(y - ry) < 0.016) return 0.7;
        return 0.08;
      }
    }
    return 0;
  },
];

/** Current product and how far the dissolve into the next one has got, at `sec` seconds. */
function phase(sec: number) {
  const k = Math.floor(sec / HOLD) % SHAPES.length;
  const p = clamp(((sec % HOLD) / HOLD - 0.75) / 0.25);
  return { k, next: (k + 1) % SHAPES.length, p };
}

export function makeLens(clock: { current: { start: number; still: boolean } }): (cols: number, rows: number) => Scene {
  return () => (i, j, cols, rows) => {
    const c = clock.current;
    const sec = c.still ? 0 : (performance.now() - c.start) / 1000;
    const { k, next, p } = phase(sec);
    const x = (i + 0.5) / cols, y = (j + 0.5) / rows;
    const rr = Math.hypot(x - 0.5, y - 0.5);
    if (rr > 0.52) return 0;
    // Shrink the shapes so their corners stay inside the ring.
    const sx = 0.5 + (x - 0.5) / FIT, sy = 0.5 + (y - 0.5) / FIT;
    const a = SHAPES[k]!(sx, sy), b = SHAPES[next]!(sx, sy);
    let v = p > hash(i, j) ? b : a;
    if (p > 0 && p < 1 && Math.abs(p - hash(i, j)) < 0.025 && (a || b)) v = 0.95;
    const ang = Math.atan2(y - 0.5, x - 0.5);
    if (!v && rr < 0.5) {
      // Background dots twinkle on their own beat and drift slowly round the centre.
      const beat = Math.floor(sec * 1.6 + hash(i, j + 3) * 8);
      if (hash(i, j + 9 + beat * 31) > 0.975) v = 0.1 + 0.16 * (0.5 - rr) + 0.12 * hash(i + beat, j);
      // A faint inner ring of dashes turning the other way.
      if (Math.abs(rr - 0.45) < 0.008 && Math.floor((ang / Math.PI + 1) * 36 - sec * 0.6) % 4 === 0) v = 0.2;
    }
    if (Math.abs(rr - 0.49) < 0.011) {
      // Outer ring: dots that rotate, with a brighter arc sweeping round.
      const turn = ((ang / (2 * Math.PI) + 1 - sec * 0.07) % 1 + 1) % 1;
      if (Math.floor(turn * 140) % 2 === 0) {
        const arc = Math.max(0, 1 - turn / 0.3);
        v = Math.max(Math.abs(v), 0.3 + 0.7 * arc * arc);
      }
    }
    return v;
  };
}

/** The lens canvas plus the product labels, kept in step. */
export function Lens() {
  const reduced = usePrefersReducedMotion();
  const clock = useRef({ start: performance.now(), still: reduced });
  clock.current.still = reduced;
  const make = useMemo(() => makeLens(clock), []);
  const [cur, setCur] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      const { k, next, p } = phase((performance.now() - clock.current.start) / 1000);
      setCur(p > 0.5 ? next : k);
    }, 100);
    return () => window.clearInterval(id);
  }, [reduced]);
  return (
    <>
      <div className="lens">
        <DitherCanvas make={make} aspect={1} cell={4} animate fps={24} label={`Curveil: ${PRODUCTS[cur]}`} />
      </div>
      <ul className="lens-label" aria-label="What you can do on Curveil">
        {PRODUCTS.map((name, i) => <li key={name} aria-current={i === cur ? "true" : undefined}>{name}</li>)}
      </ul>
    </>
  );
}
