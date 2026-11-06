import type { Candle } from "./perps";

const STEPS = [60, 300, 900, 1800, 3600, 4 * 3600, 12 * 3600, 86_400, 7 * 86_400];

/**
 * Candles from a list of trade prices (oldest first). The bucket size grows with the time span so
 * there are at most `max` candles, and each candle opens at the previous close so the bodies join up.
 *
 * Time stays even across the chart: a bucket with no trade gets a flat candle at the last price, and
 * with `until` (usually now) flat candles carry the last price up to that time. Without this, two
 * trades a day apart would sit side by side and the line between them would mislead.
 */
export function tradeCandles(points: { t: number; price: number }[], max = 60, until?: number): Candle[] {
  if (points.length === 0) return [];
  const first = points[0]!.t;
  const end = Math.max(points[points.length - 1]!.t, until ?? 0);
  const span = Math.max(1, end - first);
  const step = STEPS.find((s) => span / s <= max - 1) ?? STEPS[STEPS.length - 1]!;
  const out: Candle[] = [];
  let prev: number | null = null;
  for (const p of points) {
    const t = Math.floor(p.t / step) * step;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, p.price);
      last.l = Math.min(last.l, p.price);
      last.c = p.price;
    } else {
      // Flat candles for the quiet buckets since the last trade.
      if (last) for (let q = last.t + step; q < t; q += step) out.push({ t: q, o: last.c, h: last.c, l: last.c, c: last.c });
      const o = prev ?? p.price;
      out.push({ t, o, h: Math.max(o, p.price), l: Math.min(o, p.price), c: p.price });
    }
    prev = p.price;
  }
  const last = out[out.length - 1]!;
  const stop = Math.floor(end / step) * step;
  for (let q = last.t + step; q <= stop; q += step) out.push({ t: q, o: last.c, h: last.c, l: last.c, c: last.c });
  return out;
}
