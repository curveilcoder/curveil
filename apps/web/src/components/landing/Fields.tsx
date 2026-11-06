/**
 * Dithered backgrounds for the middle of the landing page, one per section, drawn with the
 * same dots as the hero so the art carries on below it.
 */
import { makeShield, type Scene } from "../Dither";

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hash = (i: number, j: number) => {
  const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * A floor grid running to a horizon near the top, moving slowly towards the viewer. The app
 * window stands on it. Lines fade with distance and towards the sides.
 */
export function makeHorizon(): (cols: number, rows: number) => Scene {
  return (cols, rows) => {
    const aspect = cols / rows;
    const H = 0.2; // horizon, from the top, just behind the window's bottom edge
    const KX = 0.9, KZ = 1.2;
    // Floor coordinates of a screen point: one grid square per unit, rows scrolling towards the viewer.
    const depth = (y: number) => 1 / (Math.max(0, (y - H) / (1 - H)) + 0.04);
    const fx = (x: number, y: number) => (x - 0.5) * aspect * depth(y) * KX + 0.5;
    const fz = (y: number, t: number) => depth(y) * KZ - t * 0.45;
    // A cell is on a line when the line crosses it, so lines stay unbroken at any slope.
    const crosses = (a: number, b: number) => Math.floor(a) !== Math.floor(b);
    return (i, j, _c, _r, t) => {
      const x0 = i / cols, x1 = (i + 1) / cols, y0 = j / rows, y1 = (j + 1) / rows;
      if (y0 < H) return 0;
      const d = ((y0 + y1) / 2 - H) / (1 - H); // 0 at the horizon, 1 at the bottom
      const c = [fx(x0, y0), fx(x1, y0), fx(x0, y1), fx(x1, y1)];
      const lo = Math.min(...c), hi = Math.max(...c);
      // Skip lines packed a few dots apart near the horizon, and columns that run too flat there.
      const perCell = Math.abs(fx(x1, y0) - fx(x0, y0));
      const xc = (x0 + x1) / 2, travel = Math.abs(fx(xc, y0) - fx(xc, y1)) / perCell;
      const onCol = perCell < 0.22 && travel < 4 && crosses(lo, hi);
      const za = fz(y0, t), zb = fz(y1, t);
      const onRow = Math.abs(za - zb) < 0.3 && crosses(za, zb);
      if (!onCol && !onRow) return 0;
      const side = Math.exp(-((((x0 + x1) / 2 - 0.5) / 0.5) ** 2));
      const v = onRow && onCol ? 0.95 : 0.5;
      return clamp(v * (0.35 + 0.65 * Math.pow(d, 0.9)) * (0.45 + 0.55 * side));
    };
  };
}

/**
 * A wall of small dithered tiles, one per launchpad, each lighting up on its own beat:
 * many brands, one set of contracts.
 */
export function makeTiles(): (cols: number, rows: number) => Scene {
  return (cols, rows) => {
    const size = 11; // cells per tile, gap included
    return (i, j, _c, _r, t) => {
      const ti = Math.floor(i / size), tj = Math.floor(j / size);
      const li = i % size, lj = j % size;
      if (li >= size - 2 || lj >= size - 2) return 0;
      const x = (i + 0.5) / cols, y = (j + 0.5) / rows;
      const fade = Math.exp(-(((x - 0.5) / 0.62) ** 2) - (((y - 0.5) / 0.62) ** 2));
      const r = hash(ti, tj);
      const beat = (t * (0.18 + r * 0.22) + r * 7) % 1;
      const lit = beat < 0.22 ? Math.sin((beat / 0.22) * Math.PI) : 0;
      const edge = li === 0 || lj === 0 || li === size - 3 || lj === size - 3;
      const base = edge ? 0.16 : 0;
      const v = (base + lit * (edge ? 0.6 : 0.3)) * fade;
      return v < 0.03 ? 0 : clamp(v);
    };
  };
}

export const HORIZON = makeHorizon();
export const TILES = makeTiles();

/** The dithered shield with a slow band of light sweeping across its face, for the Vault. */
export function makeShieldSweep(): (cols: number, rows: number) => Scene {
  const base = makeShield();
  return (cols, rows) => {
    const scene = base(cols, rows);
    return (i, j, c, r, t) => {
      const v = scene(i, j, c, r, t);
      if (v <= 0.15) return v;
      const p = ((t * 0.22) % 1.6) - 0.3; // sweep position, with a pause between passes
      const s = (i / cols) * 0.6 + (j / rows) * 0.4;
      return clamp(v + 0.45 * Math.exp(-(((s - p) / 0.07) ** 2)));
    };
  };
}
export const SHIELD_SWEEP = makeShieldSweep();
