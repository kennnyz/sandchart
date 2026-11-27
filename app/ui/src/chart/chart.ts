import type { CandleColumns, Candles, Instrument, LiveCandle, TimeframeCode } from "../backend/types";
import { chartDebug } from "./debug";
import { alignOffset, hasOwnPane, layoutPanes, overlayRange, paneRange, seriesValues, type IndicatorLayer } from "./indicators";
import { draw, plotSize, priceAxisWidth, RenderBuffers, type Crosshair, type Series } from "./render";
import type { IndicatorFrame } from "./renderIndicators";
import { autoscale, PriceScale, type PriceScaleMode } from "./scale";
import { AXIS_FONT, PRICE_AXIS_WIDTH, type ChartTheme } from "./theme";
import { gestureZoomFactor, panBy, visibleRange, xToIndex, zoomAt, type Viewport } from "./viewport";

const DEFAULT_BAR_WIDTH = 8;
/** Empty bars between the last candle and the price axis after a reset. */
const RIGHT_MARGIN_BARS = 5;
/** `onNeedOlder` fires when the left edge is this close to the first candle. */
const NEED_OLDER_BARS = 100;
/** Bars that must stay on screen at either edge while panning. */
const KEEP_VISIBLE_BARS = 5;
const MINUTE = 60_000;

/** Bar duration of every timeframe, to recover the timeframe from the data. */
const TF_STEPS: [TimeframeCode, number][] = [
  ["1m", MINUTE], ["3m", 3 * MINUTE], ["5m", 5 * MINUTE], ["15m", 15 * MINUTE], ["30m", 30 * MINUTE],
  ["1h", 60 * MINUTE], ["2h", 120 * MINUTE], ["4h", 240 * MINUTE], ["6h", 360 * MINUTE],
  ["8h", 480 * MINUTE], ["12h", 720 * MINUTE], ["1d", 1440 * MINUTE], ["3d", 4320 * MINUTE],
  ["1w", 10_080 * MINUTE], ["1M", 43_200 * MINUTE],
];

function inferTimeframe(s: Series): TimeframeCode {
  if (s.count < 2) return "1h";
  let step = Infinity;
  // The smallest of the last few gaps: a missing bar must not double the step.
  for (let i = Math.max(1, s.count - 5); i < s.count; i++) step = Math.min(step, s.time[i]! - s.time[i - 1]!);
  let best: TimeframeCode = "1h";
  let bestDiff = Infinity;
  for (const [code, ms] of TF_STEPS) {
    const diff = Math.abs(Math.log(step / ms));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = code;
    }
  }
  return best;
}

function emptySeries(capacity: number): Series {
  return {
    time: new Float64Array(capacity),
    open: new Float64Array(capacity),
    high: new Float64Array(capacity),
    low: new Float64Array(capacity),
    close: new Float64Array(capacity),
    volume: new Float64Array(capacity),
    count: 0,
  };
}

const KEYS = ["time", "open", "high", "low", "close", "volume"] as const;
const NO_BARS = new Float64Array(0);
const NO_TICKS: number[] = [];
const PANE_PADDING = 0.08;

/** WebKit's non-standard GestureEvent (trackpad pinch in Safari / WKWebView). */
interface GestureEventLike extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

type Drag = { kind: "pan" | "price"; pointerId: number; lastX: number; lastY: number };

/**
 * Candlestick chart on one Canvas 2D: main pane, price axis on the right, time axis
 * at the bottom. Draws on requestAnimationFrame only when something changed.
 */
export class Chart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly buffers = new RenderBuffers();
  private readonly resizeObserver: ResizeObserver;
  private series = emptySeries(0);
  private instrument: Instrument | null = null;
  private tf: TimeframeCode = "1h";
  private atHistoryStart = false;
  private olderPending = false;
  private view: Viewport = { barWidth: DEFAULT_BAR_WIDTH, rightIndex: 0 };
  private mode: PriceScaleMode = "linear";
  private autoScale = true;
  /** Price range while autoscale is off. */
  private manualRange: [number, number] = [0, 1];
  private width = 0;
  private height = 0;
  /** Price axis width in CSS px: PRICE_AXIS_WIDTH or wider to fit the labels. */
  private axisWidth = PRICE_AXIS_WIDTH;
  private dpr = 1;
  private frame = 0;
  private mouse: { x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private crosshairIndex: number | null = null;
  private needOlderCb: (() => void) | null = null;
  private crosshairCb: ((index: number | null) => void) | null = null;
  private historyLabel: ((firstTime: number) => [string, string]) | null = null;
  private destroyed = false;
  /** WebKit gesture events exist (macOS WKWebView); Chromium and WebView2 send ctrl+wheel. */
  private readonly hasGestures = "ongesturestart" in window;
  private gestureScale = 1;
  private gestureActive = false;
  /** Indicator layers and own panes, updated in place every frame. */
  private readonly ind: IndicatorFrame = { layers: [], offsets: [], tickMul: 1, priceH: 0, panes: [] };
  /** Plot height `ind.priceH` and the pane rows were laid out for; -1 forces a new layout. */
  private layoutH = -1;

  constructor(
    private readonly host: HTMLElement,
    private theme: ChartTheme,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none";
    this.canvas.style.cursor = "crosshair";
    host.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    if (this.hasGestures) {
      this.canvas.addEventListener("gesturestart", this.onGestureStart);
      this.canvas.addEventListener("gesturechange", this.onGestureChange);
      this.canvas.addEventListener("gestureend", this.onGestureEnd);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    // Canvas text does not make the browser load a web font by itself, and
    // `document.fonts.ready` can resolve before the axis font was ever requested.
    // Ask for it explicitly, then re-measure the axis from scratch: labels drawn
    // with a fallback font have a different width.
    void document.fonts
      ?.load(AXIS_FONT)
      .catch(() => undefined)
      .then(() => {
        if (this.destroyed) return;
        this.axisWidth = PRICE_AXIS_WIDTH;
        this.invalidate();
      });
  }

  // ---- Public API ----

  setData(c: Candles): void {
    const n = c.time.length;
    const s = emptySeries(n + 1024);
    for (const k of KEYS) s[k].set(c[k]);
    s.count = n;
    this.series = s;
    this.instrument = c.instrument;
    this.tf = inferTimeframe(s);
    this.atHistoryStart = c.atHistoryStart || n === 0;
    this.olderPending = false;
    this.axisWidth = PRICE_AXIS_WIDTH;
    this.resetView();
  }

  /** Drops every candle: an empty plot until the next `setData`. */
  clear(): void {
    this.series = emptySeries(0);
    this.instrument = null;
    this.atHistoryStart = false;
    this.olderPending = false;
    this.axisWidth = PRICE_AXIS_WIDTH;
    this.resetView();
  }

  /**
   * Ends an older-page request that failed: `onNeedOlder` fires again right away if
   * the view still needs older candles. Until this call the chart does not ask again.
   */
  releaseOlder(): void {
    this.olderPending = false;
    this.checkNeedOlder();
  }

  /** Text of the start-of-history marker (two lines) for the time of the first candle. */
  setHistoryLabel(fn: ((firstTime: number) => [string, string]) | null): void {
    this.historyLabel = fn;
    this.invalidate();
  }

  /** Adds older candles in front; the view stays on the same bars. */
  prependData(c: Candles): void {
    this.olderPending = false;
    if (c.atHistoryStart) this.atHistoryStart = true;
    const old = this.series;
    const firstTime = old.count > 0 ? old.time[0]! : Infinity;
    let n = 0;
    while (n < c.time.length && c.time[n]! < firstTime) n++;
    if (n === 0) {
      // Nothing older came back: this is the start of history.
      this.atHistoryStart = true;
      this.invalidate();
      return;
    }
    const s = emptySeries(old.count + n + 1024);
    for (const k of KEYS) {
      s[k].set((c[k] as CandleColumns[typeof k]).slice(0, n));
      s[k].set(old[k].subarray(0, old.count), n);
    }
    s.count = old.count + n;
    this.series = s;
    if (old.count < 2) this.tf = inferTimeframe(s);
    this.view = { barWidth: this.view.barWidth, rightIndex: this.view.rightIndex + n };
    this.afterViewChange();
  }

  /** Applies a live bar: replaces the last candle or appends a newer one. */
  updateLast(c: LiveCandle): void {
    const s = this.series;
    if (s.count === 0) return;
    const lastTime = s.time[s.count - 1]!;
    if (c.time < lastTime) return;
    if (c.time > lastTime) {
      if (s.count === s.time.length) this.grow();
      const following = this.view.rightIndex >= this.series.count - 1;
      this.series.count++;
      if (following) this.view = { barWidth: this.view.barWidth, rightIndex: this.view.rightIndex + 1 };
    }
    const t = this.series;
    const i = t.count - 1;
    t.time[i] = c.time;
    t.open[i] = c.open;
    t.high[i] = c.high;
    t.low[i] = c.low;
    t.close[i] = c.close;
    t.volume[i] = c.volume;
    this.afterViewChange();
  }

  setPriceMode(m: PriceScaleMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.autoScale = true;
    this.invalidate();
  }

  /**
   * Indicator layers to draw, in order; `priceScale` is the instrument's, so that a
   * `pane: price` value times `10 ** priceScale` is in price ticks. Each layer with an
   * own-pane series (and no error) gets its own pane under the price plot.
   */
  setIndicators(layers: IndicatorLayer[], priceScale: number): void {
    const ind = this.ind;
    ind.layers = layers;
    ind.tickMul = 10 ** priceScale;
    ind.offsets = layers.map(() => null);
    ind.panes = [];
    layers.forEach((l, i) => {
      if (hasOwnPane(l)) ind.panes.push({ layer: i, top: 0, height: 0, scale: null, ticks: NO_TICKS });
    });
    this.layoutH = -1;
    this.afterViewChange();
  }

  /**
   * Values of every aligned layer at chart bar `index`, for the legend: instance to
   * series id to value. Non-finite values are left out, so an instance can map to an
   * empty map; a layer without a result or not aligned with the bars is missing.
   */
  indicatorValues(index: number): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    const s = this.series;
    if (index < 0 || index >= s.count) return out;
    for (const layer of this.ind.layers) {
      const c = layer.computed;
      if (!c || layer.error !== null) continue;
      const offset = alignOffset(s.time, s.count, c.firstTime);
      if (offset === null) continue;
      const k = index - offset;
      const values = new Map<string, number>();
      for (const spec of layer.meta.series) {
        const v = k >= 0 ? seriesValues(c, spec.id)?.[k] : undefined;
        if (v !== undefined && Number.isFinite(v)) values.set(spec.id, v);
      }
      out.set(layer.instance, values);
    }
    return out;
  }

  setTheme(t: ChartTheme): void {
    this.theme = t;
    this.invalidate();
  }

  resetView(): void {
    this.view = { barWidth: DEFAULT_BAR_WIDTH, rightIndex: this.series.count - 1 + RIGHT_MARGIN_BARS };
    this.autoScale = true;
    this.afterViewChange();
  }

  onNeedOlder(cb: () => void): void {
    this.needOlderCb = cb;
    this.checkNeedOlder();
  }

  onCrosshair(cb: (index: number | null) => void): void {
    this.crosshairCb = cb;
  }

  /** Candle `index` of the current series (indices shift by the size of every prepend). */
  candle(index: number): LiveCandle | null {
    const s = this.series;
    if (index < 0 || index >= s.count) return null;
    return {
      time: s.time[index]!,
      open: s.open[index]!,
      high: s.high[index]!,
      low: s.low[index]!,
      close: s.close[index]!,
      volume: s.volume[index]!,
      closed: index < s.count - 1,
    };
  }

  get count(): number {
    return this.series.count;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    if (this.hasGestures) {
      this.canvas.removeEventListener("gesturestart", this.onGestureStart);
      this.canvas.removeEventListener("gesturechange", this.onGestureChange);
      this.canvas.removeEventListener("gestureend", this.onGestureEnd);
    }
    this.canvas.remove();
    this.needOlderCb = null;
    this.crosshairCb = null;
  }

  // ---- Internals ----

  private grow(): void {
    const old = this.series;
    const s = emptySeries(old.time.length * 2 + 1024);
    for (const k of KEYS) s[k].set(old[k].subarray(0, old.count));
    s.count = old.count;
    this.series = s;
  }

  private invalidate(): void {
    if (this.frame !== 0 || this.destroyed) return;
    this.frame = requestAnimationFrame(this.render);
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.afterViewChange();
  }

  private plot() {
    return plotSize(this.width, this.height, this.axisWidth);
  }

  private clampView(): void {
    const { plotW } = this.plot();
    const n = this.series.count;
    if (n === 0 || plotW <= 0) return;
    const v = this.view;
    const lo = Math.min(n - 1, KEEP_VISIBLE_BARS);
    const hi = n - 1 + plotW / v.barWidth - KEEP_VISIBLE_BARS;
    if (v.rightIndex < lo) this.view = { barWidth: v.barWidth, rightIndex: lo };
    else if (v.rightIndex > hi) this.view = { barWidth: v.barWidth, rightIndex: hi };
  }

  /** Call after any change of data, viewport or mouse position. */
  private afterViewChange(): void {
    this.clampView();
    this.updateCrosshair();
    this.checkNeedOlder();
    this.invalidate();
  }

  private checkNeedOlder(): void {
    if (!this.needOlderCb || this.atHistoryStart || this.olderPending || this.series.count === 0) return;
    const { plotW } = this.plot();
    if (plotW <= 0) return;
    if (xToIndex(this.view, 0, plotW) < NEED_OLDER_BARS) {
      this.olderPending = true;
      this.needOlderCb();
    }
  }

  private updateCrosshair(): void {
    const { plotW, plotH } = this.plot();
    const m = this.mouse;
    let index: number | null = null;
    if (m && m.x >= 0 && m.x < plotW && m.y >= 0 && m.y < plotH) {
      const i = Math.round(xToIndex(this.view, m.x, plotW));
      if (i >= 0 && i < this.series.count) index = i;
    }
    if (index !== this.crosshairIndex) {
      this.crosshairIndex = index;
      this.crosshairCb?.(index);
    }
  }

  /** Lays out the price plot and own panes for the current plot height. */
  private priceH(): number {
    const { plotH } = this.plot();
    const ind = this.ind;
    if (plotH !== this.layoutH) {
      this.layoutH = plotH;
      const layout = layoutPanes(plotH, ind.panes.length);
      ind.priceH = layout.priceH;
      ind.panes.forEach((p, i) => {
        p.top = layout.panes[i]!.top;
        p.height = layout.panes[i]!.height;
      });
    }
    return ind.priceH;
  }

  /** Chart index of value 0 of every layer; a binary search each, so it runs per frame. */
  private refreshOffsets(): void {
    const { layers, offsets } = this.ind;
    const s = this.series;
    for (let i = 0; i < layers.length; i++) {
      const c = layers[i]!.computed;
      offsets[i] = c ? alignOffset(s.time, s.count, c.firstTime) : null;
    }
  }

  private priceScale(priceH: number): PriceScale {
    this.refreshOffsets();
    if (!this.autoScale) return new PriceScale(this.manualRange[0], this.manualRange[1], priceH, this.mode);
    const { plotW } = this.plot();
    const s = this.series;
    const range = visibleRange(this.view, plotW, s.count);
    const ind = this.ind;
    const extra = ind.layers.length > 0 ? overlayRange(ind.layers, ind.offsets, range[0], range[1], ind.tickMul) : null;
    const [min, max] = autoscale(s.low, s.high, range, 0.08, this.mode, extra);
    return new PriceScale(min, max, priceH, this.mode);
  }

  /** Value scale and labels of every own pane over the visible bars. */
  private updatePanes(): void {
    const { plotW } = this.plot();
    const [first, last] = visibleRange(this.view, plotW, this.series.count);
    const ind = this.ind;
    for (const p of ind.panes) {
      const offset = ind.offsets[p.layer] ?? null;
      const range = offset === null || last < first ? null : paneRange(ind.layers[p.layer]!, offset, first, last);
      if (range && p.height > 0) {
        const [lo, hi] = autoscale(NO_BARS, NO_BARS, [0, -1], PANE_PADDING, "linear", range);
        p.scale = new PriceScale(lo, hi, p.height, "linear");
        p.ticks = p.scale.ticks(3);
      } else {
        p.scale = null;
        p.ticks = NO_TICKS;
      }
    }
  }

  private readonly render = (): void => {
    this.frame = 0;
    if (this.destroyed) return;
    if (window.devicePixelRatio !== this.dpr) {
      this.resize();
      return;
    }
    const started = performance.now();
    const { plotH } = this.plot();
    const priceH = this.priceH();
    const decimals = this.instrument?.priceScale ?? 0;
    const s = this.series;
    const lastClose = s.count > 0 ? s.close[s.count - 1]! : NaN;
    let scale = this.priceScale(priceH);
    this.updatePanes();
    const m = this.mouse;
    const axis = priceAxisWidth(
      this.ctx,
      this.buffers,
      this.dpr,
      scale,
      decimals,
      lastClose,
      m && m.y < priceH ? m.y : null,
      this.ind.panes,
    );
    // Grow-only within one series, so the plot does not jitter as labels change length.
    if (axis.width > this.axisWidth) {
      this.axisWidth = axis.width;
      this.clampView();
      this.updateCrosshair();
      this.checkNeedOlder();
      scale = this.priceScale(priceH);
      this.updatePanes();
    }
    const { plotW } = this.plot();
    const inPlot = m !== null && m.x >= 0 && m.x < plotW && m.y >= 0 && m.y < plotH;
    const crosshair: Crosshair | null = inPlot ? { x: m.x, y: m.y, index: this.crosshairIndex } : null;
    const historyStart =
      this.atHistoryStart && s.count > 0 && this.historyLabel ? this.historyLabel(s.time[0]!) : null;
    draw(
      {
        ctx: this.ctx,
        dpr: this.dpr,
        width: this.width,
        height: this.height,
        axisWidth: this.axisWidth,
        series: s,
        view: this.view,
        scale,
        priceDecimals: decimals,
        tf: this.tf,
        crosshair,
        historyStart,
        theme: this.theme,
        indicators: this.ind,
      },
      this.buffers,
    );
    const debug = chartDebug();
    if (debug) {
      if (debug.drawMs.length >= 10_000) debug.drawMs.length = 0;
      debug.drawMs.push(performance.now() - started);
      debug.axisWidth = this.axisWidth;
      debug.widestLabel = axis.widest;
      debug.widestText = axis.widestText;
      debug.canvasWidth = this.width;
      debug.plotWidth = plotW;
      debug.historyLabel = historyStart ? historyStart.join("|") : null;
      debug.panes = this.ind.panes.length;
    }
  };

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = this.local(e);
    const { plotW } = this.plot();
    const onPriceAxis = p.x >= plotW && p.y < this.priceH();
    this.drag = { kind: onPriceAxis ? "price" : "pan", pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
    if (this.drag.kind === "pan") this.canvas.style.cursor = "grabbing";
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = this.local(e);
    this.mouse = p;
    const { plotW } = this.plot();
    const priceH = this.priceH();
    const d = this.drag;
    if (d && d.pointerId === e.pointerId) {
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      if (d.kind === "pan") {
        this.view = panBy(this.view, dx);
        if (!this.autoScale) this.shiftPrice(dy, priceH);
      } else {
        this.stretchPrice(dy, priceH);
      }
    } else {
      this.canvas.style.cursor = p.x >= plotW && p.y < priceH ? "ns-resize" : "crosshair";
    }
    this.afterViewChange();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.drag?.pointerId !== e.pointerId) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const p = this.local(e);
    this.canvas.style.cursor = p.x >= this.plot().plotW && p.y < this.priceH() ? "ns-resize" : "crosshair";
  };

  private readonly onPointerLeave = (): void => {
    if (this.drag) return;
    this.mouse = null;
    this.afterViewChange();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // During a WebKit pinch the gesture events zoom; do not zoom twice.
    if (this.gestureActive && e.ctrlKey) return;
    const p = this.local(e);
    this.mouse = p;
    const { plotW } = this.plot();
    // Pixel deltas from a trackpad or wheel; line deltas from some mice.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const dy = e.deltaY * unit;
    const dx = e.deltaX * unit;
    if (Math.abs(dx) > Math.abs(dy) && !e.ctrlKey) {
      // Horizontal two-finger scroll pans.
      this.view = panBy(this.view, -dx);
    } else {
      // Pinch arrives as a wheel event with ctrlKey and needs a stronger factor.
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
      const anchor = Math.min(Math.max(0, p.x), plotW);
      this.view = zoomAt(this.view, anchor, plotW, factor);
    }
    this.afterViewChange();
  };

  private readonly onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.gestureActive = true;
    this.gestureScale = (e as GestureEventLike).scale || 1;
  };

  private readonly onGestureChange = (e: Event): void => {
    e.preventDefault();
    const g = e as GestureEventLike;
    const factor = gestureZoomFactor(this.gestureScale, g.scale);
    this.gestureScale = g.scale;
    if (factor === 1) return;
    const p = this.local(g);
    const { plotW } = this.plot();
    this.view = zoomAt(this.view, Math.min(Math.max(0, p.x), plotW), plotW, factor);
    this.afterViewChange();
  };

  private readonly onGestureEnd = (e: Event): void => {
    e.preventDefault();
    this.gestureActive = false;
    this.gestureScale = 1;
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    const p = this.local(e);
    if (p.x < this.plot().plotW || p.y >= this.priceH()) return;
    this.autoScale = true;
    this.invalidate();
  };

  private freezeScale(priceH: number): void {
    if (!this.autoScale) return;
    const s = this.priceScale(priceH);
    this.manualRange = [s.min, s.max];
    this.autoScale = false;
  }

  /** Drag on the price axis: down widens the range, up narrows it, around its centre. */
  private stretchPrice(dy: number, priceH: number): void {
    if (dy === 0 || priceH <= 0) return;
    this.freezeScale(priceH);
    const factor = Math.exp(dy * 0.005);
    const [lo, hi] = this.toScaleSpace(this.manualRange);
    const mid = (lo + hi) / 2;
    const half = Math.max(((hi - lo) / 2) * factor, 1e-9);
    this.manualRange = this.fromScaleSpace([mid - half, mid + half]);
  }

  /** Vertical drag on the plot while autoscale is off moves the price range. */
  private shiftPrice(dy: number, priceH: number): void {
    if (dy === 0 || priceH <= 0) return;
    const [lo, hi] = this.toScaleSpace(this.manualRange);
    const shift = (dy / priceH) * (hi - lo);
    this.manualRange = this.fromScaleSpace([lo + shift, hi + shift]);
  }

  private toScaleSpace([lo, hi]: [number, number]): [number, number] {
    return this.mode === "log" ? [Math.log(Math.max(1, lo)), Math.log(Math.max(1, hi))] : [lo, hi];
  }

  private fromScaleSpace([lo, hi]: [number, number]): [number, number] {
    return this.mode === "log" ? [Math.exp(lo), Math.exp(hi)] : [lo, hi];
  }
}

