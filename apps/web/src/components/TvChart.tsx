import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/perps";

type Props = {
  candles: (Candle & { v?: number })[];
  /** Live price: drawn as a dashed line and folded into the newest candle. */
  mark: number | null;
  /** Label on the live price line. */
  markTitle?: string;
  height?: number;
  /** Changes when the data set changes (market, range), so the view refits instead of keeping the old zoom. */
  resetKey: string;
  /** Candles (default) or a line through the closes. */
  mode?: "candles" | "line";
  /** Price text for the axis and legend. Defaults to a fixed number of decimals for the price's size. */
  fmt?: (n: number) => string;
  /**
   * With fewer candles than this, they start at the left edge with room to the right, the way a new
   * market fills in, instead of being stretched across the whole width.
   */
  minBars?: number;
  /** Shown instead of the chart when there are no candles. */
  empty?: string;
  /** Smallest price band the auto-scale zooms to, as a share of the price (0.01 is 1%). */
  minBand?: number;
};

const css = (name: string, fallback: string) =>
  (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

/** Decimals that suit a price: 2 from 10 up, 3 from 1, 5 below. */
const decimalsFor = (p: number) => (p >= 10 ? 2 : p >= 1 ? 3 : 5);
const fixed = (n: number) => {
  const d = decimalsFor(Math.abs(n));
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
/** Smallest price step worth showing: about four significant digits of the price. */
const stepFor = (p: number) => (p > 0 && Number.isFinite(p) ? 10 ** (Math.floor(Math.log10(p)) - 4) : 0.01);

/**
 * Auto-scale that never zooms into less than a band of `share` around the price. Without it a
 * price that barely moves (a quiet launch) fills the whole height, so a 0.003% wiggle looks like
 * a jump and every axis label reads the same.
 */
type Range = { priceRange: { minValue: number; maxValue: number } | null } | null;
const atLeastBand = (share: number) => (base: () => Range) => {
  const r = base();
  if (!r?.priceRange) return r;
  const { minValue, maxValue } = r.priceRange;
  const mid = (minValue + maxValue) / 2;
  const band = Math.abs(mid) * share;
  if (maxValue - minValue >= band) return r;
  return { ...r, priceRange: { minValue: mid - band / 2, maxValue: mid + band / 2 } };
};

/** The chart library works in UTC; shift times so the axis reads in the viewer's own time zone. */
const local = (t: number) => (t - new Date(t * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

/** The series that holds the live price line, so the line can be taken off it again. */
type Owner = { removePriceLine(line: IPriceLine): void };

type Legend = { t: number; o: number; h: number; l: number; c: number; v?: number };

/**
 * An interactive price chart (TradingView's Lightweight Charts): scroll to zoom, drag to pan,
 * drag the price axis to rescale, double-click the axis to auto-fit again. Volume sits underneath
 * when the candles carry it.
 */
export function TvChart({ candles, mark, markTitle, height = 420, resetKey, mode = "candles", fmt, minBars = 0, empty = "No prices for this range yet.", minBand = 0.002 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markLine = useRef<IPriceLine | null>(null);
  const markOwner = useRef<Owner | null>(null);
  const fitted = useRef<string | null>(null);
  const fmtRef = useRef(fmt ?? fixed);
  fmtRef.current = fmt ?? fixed;
  const [legend, setLegend] = useState<Legend | null>(null);
  const [log, setLog] = useState(false);
  const good = css("--good", "#6fd3a4");
  const bad = css("--bad", "#ff7a7a");
  const hasData = candles.length > 0;

  // Create the chart once there is something to draw.
  useEffect(() => {
    if (!box.current || !hasData) return;
    const muted = css("--muted", "#99a4bd");
    const line = css("--line", "#172036");
    const accent = css("--accent", "#2563ff");
    const c = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: muted,
        fontFamily: css("--font-mono", "ui-monospace, monospace"),
        fontSize: 11,
        attributionLogo: true,
      },
      localization: { priceFormatter: (n: number) => fmtRef.current(n) },
      grid: { vertLines: { color: line, style: LineStyle.Dotted }, horzLines: { color: line, style: LineStyle.Dotted } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: muted, labelBackgroundColor: "#1b2440" }, horzLine: { color: muted, labelBackgroundColor: "#1b2440" } },
      rightPriceScale: { borderColor: line, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false, rightOffset: 4, minBarSpacing: 2 },
      handleScroll: true,
      handleScale: true,
    });
    const p = c.addSeries(CandlestickSeries, {
      upColor: good,
      downColor: bad,
      borderUpColor: good,
      borderDownColor: bad,
      wickUpColor: good,
      wickDownColor: bad,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: atLeastBand(minBand),
    });
    const a = c.addSeries(AreaSeries, {
      lineColor: accent,
      topColor: `${accent}55`,
      bottomColor: `${accent}00`,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: atLeastBand(minBand),
    });
    const v = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    c.subscribeCrosshairMove((param) => {
      if (param.time === undefined) return setLegend(null);
      const bar = param.seriesData.get(p) as { open: number; high: number; low: number; close: number } | undefined;
      const pt = param.seriesData.get(a) as { value: number } | undefined;
      const vol = param.seriesData.get(v) as { value: number } | undefined;
      if (bar) setLegend({ t: param.time as number, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: vol?.value });
      else if (pt) setLegend({ t: param.time as number, o: pt.value, h: pt.value, l: pt.value, c: pt.value, v: vol?.value });
      else setLegend(null);
    });
    chart.current = c;
    price.current = p;
    area.current = a;
    volume.current = v;
    return () => {
      c.remove();
      chart.current = null;
      price.current = null;
      area.current = null;
      volume.current = null;
      markLine.current = null;
      markOwner.current = null;
      fitted.current = null;
    };
    // Colors come from the page theme, which does not change while the chart is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasData, minBand]);

  // Candles, volume and the live price.
  useEffect(() => {
    const p = price.current;
    const a = area.current;
    const v = volume.current;
    const c = chart.current;
    if (!p || !a || !v || !c || candles.length === 0) return;
    const last = candles[candles.length - 1]!;
    const live = mark !== null && Number.isFinite(mark) && mark > 0 ? mark : null;
    const rows = candles.map((k, i) => {
      // Fold the live price into the newest candle so the chart moves between refreshes.
      if (i === candles.length - 1 && live !== null) return { ...k, h: Math.max(k.h, live), l: Math.min(k.l, live), c: live };
      return k;
    });
    const step = stepFor(live ?? last.c);
    p.applyOptions({ priceFormat: { type: "custom", formatter: (n: number) => fmtRef.current(n), minMove: step } });
    a.applyOptions({ priceFormat: { type: "custom", formatter: (n: number) => fmtRef.current(n), minMove: step } });
    const lineMode = mode === "line";
    p.setData(lineMode ? [] : rows.map((k) => ({ time: local(k.t), open: k.o, high: k.h, low: k.l, close: k.c })));
    a.setData(lineMode ? rows.map((k) => ({ time: local(k.t), value: k.c })) : []);
    const hasVolume = rows.some((k) => typeof k.v === "number");
    v.setData(hasVolume ? rows.map((k) => ({ time: local(k.t), value: k.v ?? 0, color: k.c >= k.o ? `${good}55` : `${bad}55` })) : []);
    const host: Owner & { createPriceLine: ISeriesApi<"Area">["createPriceLine"] } = lineMode ? a : p;
    if (markLine.current && markOwner.current) markOwner.current.removePriceLine(markLine.current);
    markOwner.current = host;
    markLine.current = host.createPriceLine({
      price: live ?? last.c,
      color: css("--ink", "#eef2fa"),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: markTitle ?? (live !== null ? "Mark" : "Last"),
    });
    const key = `${resetKey}:${mode}`;
    if (fitted.current !== key) {
      if (minBars > 0 && rows.length < minBars) {
        // Few candles: start at the left edge and leave the rest of the width for what comes next.
        c.timeScale().setVisibleLogicalRange({ from: -0.5, to: minBars - 0.5 });
      } else {
        c.timeScale().fitContent();
      }
      fitted.current = key;
    }
  }, [candles, mark, markTitle, resetKey, mode, minBars, good, bad]);

  const toggleLog = () => {
    const next = !log;
    chart.current?.priceScale("right").applyOptions({ mode: next ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    setLog(next);
  };
  const reset = () => {
    chart.current?.priceScale("right").applyOptions({ autoScale: true });
    if (minBars > 0 && candles.length < minBars) chart.current?.timeScale().setVisibleLogicalRange({ from: -0.5, to: minBars - 0.5 });
    else chart.current?.timeScale().fitContent();
  };

  if (!hasData) {
    return (
      <div className="chart-empty" style={{ minHeight: height }}>
        <p className="small muted" style={{ margin: 0 }}>{empty}</p>
      </div>
    );
  }

  // Legend times are already shifted to local time (see `local`), so they are printed as UTC.
  const lastCandle = candles[candles.length - 1];
  const shown = legend ?? (lastCandle ? { ...lastCandle, t: local(lastCandle.t) } : null);
  const f = fmtRef.current;
  const vol = (n: number) => n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const lineMode = mode === "line";

  return (
    <div className="tvc">
      <div className="tvc-bar">
        {shown ? (
          <div className="tvc-legend mono" aria-live="off">
            <span>{new Date(shown.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}</span>
            {lineMode ? (
              <span>Price <b>{f(shown.c)}</b></span>
            ) : (
              <>
                <span>O <b>{f(shown.o)}</b></span>
                <span>H <b>{f(shown.h)}</b></span>
                <span>L <b>{f(shown.l)}</b></span>
                <span>C <b className={shown.c >= shown.o ? "good-text" : "bad-text"}>{f(shown.c)}</b></span>
              </>
            )}
            {typeof shown.v === "number" && <span>Vol <b>{vol(shown.v)}</b></span>}
          </div>
        ) : <span />}
        <div className="tvc-tools">
          <button type="button" onClick={reset} title="Fit the chart again and turn auto-scale back on">Reset</button>
          <button type="button" className={log ? "on" : ""} aria-pressed={log} onClick={toggleLog} title="Logarithmic price scale">Log</button>
        </div>
      </div>
      <div ref={box} className="tvc-plot" style={{ height }} />
      <p className="tvc-hint small">Scroll to zoom, drag to move, drag the price axis to rescale. Double-click the axis to fit again.</p>
    </div>
  );
}
