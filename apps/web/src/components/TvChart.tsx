import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** Trading-terminal frame: a toolbar above, a legend on the chart and a scale bar below. */
  terminal?: Terminal;
};

type Terminal = {
  /** First legend line, such as "ETH / USD · 1h · Coinbase". */
  title: string;
  /** Left of the top toolbar (the candle sizes). */
  toolbar?: ReactNode;
  /** Left of the bottom bar (the period presets). */
  presets?: ReactNode;
  /** After a refit, show only the newest this many seconds. */
  windowSec?: number | null;
  /** Screenshot file name, without the extension. */
  fileName?: string;
};

type ScaleMode = "normal" | "log" | "pct";

/** "UTC+7" for the viewer's own zone. */
const zoneLabel = () => {
  const m = -new Date().getTimezoneOffset();
  const h = Math.trunc(Math.abs(m) / 60);
  const mm = Math.abs(m) % 60;
  return `UTC${m >= 0 ? "+" : "-"}${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
};

function useClock(on: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now.toLocaleTimeString("en-GB", { hour12: false });
}

const ICON = {
  candles: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 1.5v13M11.5 1.5v13" /><rect x="2.75" y="4" width="3.5" height="7" rx="0.5" /><rect x="9.75" y="6" width="3.5" height="5" rx="0.5" /></svg>,
  line: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 12.5 5.5 7.5l3 3 6-7" /></svg>,
  full: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>,
  exit: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" /></svg>,
  shot: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.8l1.2-1.5h3l1.2 1.5h1.8A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /><circle cx="8" cy="8.5" r="2.4" /></svg>,
  chev: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>,
  live: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 4 4-4 4M9 4l4 4-4 4" /></svg>,
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

type Legend = { t: number; o: number; h: number; l: number; c: number; v?: number; prev?: number };

/**
 * An interactive price chart (TradingView's Lightweight Charts): scroll to zoom, drag to pan,
 * drag the price axis to rescale, double-click the axis to auto-fit again. Volume sits underneath
 * when the candles carry it.
 */
export function TvChart({ candles, mark, markTitle, height = 420, resetKey, mode: modeProp = "candles", fmt, minBars = 0, empty = "No prices for this range yet.", minBand = 0.002, terminal }: Props) {
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
  const [kind, setKind] = useState<"candles" | "line">(modeProp);
  const mode = terminal ? kind : modeProp;
  const [scale, setScale] = useState<ScaleMode>("normal");
  const [auto, setAuto] = useState(true);
  const [showVol, setShowVol] = useState(true);
  const [legendOpen, setLegendOpen] = useState(true);
  const [away, setAway] = useState(false);
  const [full, setFull] = useState(false);
  const [axisW, setAxisW] = useState(64);
  const root = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<Candle[]>([]);
  const windowRef = useRef<number | null | undefined>(terminal?.windowSec);
  windowRef.current = terminal?.windowSec;
  const clock = useClock(!!terminal);
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
      // The terminal legend sits over the top of the plot, so leave it more room there.
      rightPriceScale: { borderColor: line, scaleMargins: { top: terminal ? 0.2 : 0.08, bottom: 0.22 } },
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
      const i = typeof param.logical === "number" ? Math.round(param.logical) : -1;
      const prev = i > 0 ? rowsRef.current[i - 1]?.c : undefined;
      if (bar) setLegend({ t: param.time as number, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: vol?.value, prev });
      else if (pt) setLegend({ t: param.time as number, o: pt.value, h: pt.value, l: pt.value, c: pt.value, v: vol?.value, prev });
      else setLegend(null);
    });
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      const n = rowsRef.current.length;
      setAway(!!r && n > 0 && r.to < n - 1.5);
      const w = c.priceScale("right").width();
      if (w > 0) setAxisW((old) => (old === w ? old : w));
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
    rowsRef.current = rows;
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
      fitView(c, rows);
      fitted.current = key;
    }
    const w = c.priceScale("right").width();
    if (w > 0) setAxisW(w);
  }, [candles, mark, markTitle, resetKey, mode, minBars, good, bad]);

  /** Fit the candles: few of them start at the left edge; a window shows only the newest stretch. */
  function fitView(c: IChartApi, rows: Candle[]) {
    const win = windowRef.current;
    if (minBars > 0 && rows.length < minBars) {
      // Few candles: start at the left edge and leave the rest of the width for what comes next.
      c.timeScale().setVisibleLogicalRange({ from: -0.5, to: minBars - 0.5 });
    } else if (win && rows.length > 1) {
      const end = rows[rows.length - 1]!.t;
      const first = Math.max(0, rows.findIndex((k) => k.t >= end - win));
      c.timeScale().setVisibleLogicalRange({ from: first - 0.5, to: rows.length - 1 + 4 });
    } else {
      c.timeScale().fitContent();
    }
  }

  // Fullscreen follows the browser, so Esc leaves it too.
  useEffect(() => {
    if (!terminal) return;
    const on = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [terminal]);

  // Dragging the price axis turns auto-scale off; keep the "auto" button honest.
  const syncAuto = () => {
    const opts = chart.current?.priceScale("right").options();
    if (opts) setAuto(opts.autoScale);
  };
  const setScaleMode = (m: ScaleMode) => {
    const next = scale === m ? "normal" : m;
    chart.current?.priceScale("right").applyOptions({ mode: next === "log" ? PriceScaleMode.Logarithmic : next === "pct" ? PriceScaleMode.Percentage : PriceScaleMode.Normal });
    setScale(next);
  };
  const autoOn = () => {
    chart.current?.priceScale("right").applyOptions({ autoScale: true });
    setAuto(true);
  };
  const toggleVol = () => {
    const next = !showVol;
    volume.current?.applyOptions({ visible: next });
    setShowVol(next);
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.();
  };
  const screenshot = () => {
    const c = chart.current;
    if (!c) return;
    const shot = c.takeScreenshot();
    const out = document.createElement("canvas");
    out.width = shot.width;
    out.height = shot.height;
    const g = out.getContext("2d");
    if (!g) return;
    g.fillStyle = css("--bg-deep", "#03050b");
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(shot, 0, 0);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `${terminal?.fileName ?? "curveil-chart"}.png`;
    a.click();
  };

  const toggleLog = () => {
    const next = !log;
    chart.current?.priceScale("right").applyOptions({ mode: next ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    setLog(next);
  };
  const reset = () => {
    chart.current?.priceScale("right").applyOptions({ autoScale: true });
    if (chart.current) fitView(chart.current, rowsRef.current.length ? rowsRef.current : candles);
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

  if (terminal) {
    const chg = shown && shown.prev !== undefined ? shown.c - shown.prev : shown ? shown.c - shown.o : 0;
    const base = shown ? (shown.prev ?? shown.o) : 0;
    const pct = base ? (chg / base) * 100 : 0;
    const tone = chg >= 0 ? "good-text" : "bad-text";
    const hasVol = candles.some((k) => typeof (k as { v?: number }).v === "number");
    return (
      <div ref={root} className={`tvc tvc-term${full ? " is-full" : ""}`}>
        <div className="tvc-top">
          <div className="tvc-top-l">{terminal.toolbar}</div>
          <div className="tvc-icons" role="group" aria-label="Chart tools">
            <button type="button" className="tvc-ico" onClick={() => setKind(lineMode ? "candles" : "line")} title={lineMode ? "Show candles" : "Show a line"} aria-label={lineMode ? "Show candles" : "Show a line"}>{lineMode ? ICON.candles : ICON.line}</button>
            <span className="tvc-sep" aria-hidden="true" />
            <button type="button" className="tvc-ico" onClick={toggleFull} title={full ? "Exit full screen" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"}>{full ? ICON.exit : ICON.full}</button>
            <button type="button" className="tvc-ico" onClick={screenshot} title="Save the chart as an image" aria-label="Save the chart as an image">{ICON.shot}</button>
          </div>
        </div>
        <div className="tvc-stage" style={full ? undefined : { height }} onPointerUp={syncAuto} onWheel={syncAuto} onDoubleClick={syncAuto}>
          <div ref={box} className="tvc-plot" />
          <div className="tvc-ov" aria-live="off">
            <div className="tvc-ov-title">{terminal.title}</div>
            {legendOpen && shown && (
              <>
                <div className="tvc-ov-row mono">
                  {lineMode ? <span><b>{f(shown.c)}</b></span> : (
                    <>
                      <span>O <b className={tone}>{f(shown.o)}</b></span>
                      <span>H <b className={tone}>{f(shown.h)}</b></span>
                      <span>L <b className={tone}>{f(shown.l)}</b></span>
                      <span>C <b className={tone}>{f(shown.c)}</b></span>
                    </>
                  )}
                  <span className={tone}>{chg >= 0 ? "+" : "−"}{Math.abs(chg).toLocaleString("en-US", { minimumFractionDigits: decimalsFor(Math.abs(base)), maximumFractionDigits: decimalsFor(Math.abs(base)) })} ({chg >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>
                </div>
                <div className="tvc-ov-row tvc-ov-time mono">{new Date(shown.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}</div>
                {hasVol && (
                  <button type="button" className={`tvc-ov-vol${showVol ? "" : " off"}`} onClick={toggleVol} aria-pressed={showVol} title={showVol ? "Hide volume" : "Show volume"}>
                    Volume{typeof shown.v === "number" && showVol ? <b className="mono">{vol(shown.v)}</b> : null}
                  </button>
                )}
              </>
            )}
            <button type="button" className={`tvc-ov-fold${legendOpen ? "" : " closed"}`} onClick={() => setLegendOpen((v) => !v)} aria-expanded={legendOpen} aria-label={legendOpen ? "Hide the legend" : "Show the legend"}>{ICON.chev}</button>
          </div>
          <div className="tvc-float" style={{ right: axisW + 8 }}>
            {away && <button type="button" className="tvc-live" onClick={() => chart.current?.timeScale().scrollToRealTime()} title="Jump to the latest candle" aria-label="Jump to the latest candle">{ICON.live}</button>}
            <div className="tvc-scalebar">
              <span className="tvc-clock mono" title="Your local time">{clock} {zoneLabel()}</span>
              <span className="tvc-sep" aria-hidden="true" />
              <button type="button" className={scale === "pct" ? "on" : ""} aria-pressed={scale === "pct"} onClick={() => setScaleMode("pct")} title="Percentage scale">%</button>
              <button type="button" className={scale === "log" ? "on" : ""} aria-pressed={scale === "log"} onClick={() => setScaleMode("log")} title="Logarithmic scale">log</button>
              <button type="button" className={auto ? "on" : ""} aria-pressed={auto} onClick={autoOn} title="Auto-fit the price scale">auto</button>
              <button type="button" onClick={reset} title="Fit the chart again">reset</button>
            </div>
          </div>
        </div>
        {terminal.presets && <div className="tvc-foot"><div className="tvc-foot-l">{terminal.presets}</div></div>}
      </div>
    );
  }

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
