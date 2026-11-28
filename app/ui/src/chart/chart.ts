import type { Alert, CandleColumns, Candles, Drawing, Instrument, LiveCandle, PositionOutcome, TimeframeCode } from "../backend/types";
import { AlertLevelLayer } from "./alerts";
import { chartDebug } from "./debug";
import { Coords, MAX_TICKS, type Step } from "./drawings/geometry";
import {
  DrawingLayer,
  type DrawingCommand,
  type MenuAction,
  type MenuEdit,
  type StyleAction,
  type StyleEdit,
  type TextEdit,
  type TextResult,
} from "./drawings/layer";
import { cmdHeld, macContextClick } from "./drawings/keys";
import type { ToolId } from "./drawings/registry";
import type { DrawingChange } from "./drawings/state";
import { alignOffset, hasOwnPane, layoutPanes, overlayRange, paneRange, seriesValues, type IndicatorLayer } from "./indicators";
import { draw, drawingTag, drawOverlay, plotSize, priceAxisWidth, RenderBuffers, type Crosshair, type FrameInput, type Series } from "./render";
import type { IndicatorFrame } from "./renderIndicators";
import { ReplayLayer, snapStart, type Level, type ReplayMarks } from "./replay";
import { autoscale, PriceScale, type PriceScaleMode } from "./scale";
import { AXIS_FONT, PRICE_AXIS_WIDTH, type ChartTheme } from "./theme";
import { gestureZoomFactor, indexToX, panBy, visibleRange, xToIndex, zoomAt, type Viewport } from "./viewport";

const DEFAULT_BAR_WIDTH = 8;
/** Empty bars between the last candle and the price axis after a reset. */
const RIGHT_MARGIN_BARS = 5;
/** In a replay: room right of the cut for the open trade's zone, labels and R. */
const REPLAY_MARGIN_BARS = 24;
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

const STEP_MS = new Map(TF_STEPS);

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

type Drag = { kind: "pan" | "price" | "drawing" | "replay"; pointerId: number; lastX: number; lastY: number };

/**
 * Candlestick chart on two stacked Canvas 2D layers: main pane, price axis on the right,
 * time axis at the bottom. The opaque base layer holds everything that depends on data,
 * view and theme; the transparent overlay above it holds the crosshair, so a mouse move
 * redraws only the overlay. Draws on requestAnimationFrame only when something changed.
 */
export class Chart {
  /** Base layer; it also takes every pointer event (the overlay lets them through). */
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
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
  private baseDirty = false;
  private overlayDirty = false;
  /** Input of the last base frame; the overlay draws against it. */
  private lastFrame: FrameInput | null = null;
  private readonly crosshair: Crosshair = { x: 0, y: 0, index: null };
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
  private drawingCommitCb: ((step: DrawingChange[]) => void) | null = null;
  private drawingToolCb: ((id: ToolId | null) => void) | null = null;
  private drawingTextCb: ((edit: TextEdit | null) => void) | null = null;
  private drawingStyleCb: ((edit: StyleEdit | null) => void) | null = null;
  private drawingMenuCb: ((edit: MenuEdit | null) => void) | null = null;
  /** A replay's trades and cut; its stop and take handles come before drawings for input. */
  private readonly replay = new ReplayLayer();
  private replayOn = false;
  private replayEditCb: ((stop: number, take: number) => void) | null = null;
  /** While a replay start is picked: called with the open time of the clicked bar. */
  private pickCb: ((time: number) => void) | null = null;
  /** Active price alerts of the pair, on the base layer; a press on one selects it. */
  private readonly alertLevels = new AlertLevelLayer();
  private alertClickCb: ((id: string) => void) | null = null;
  /** Drawings: painted on both layers, and first in line for pointer input on the price plot. */
  private readonly drawings = new DrawingLayer({
    invalidate: () => this.invalidate(),
    invalidateOverlay: () => this.invalidateOverlay(),
    commit: (step) => this.drawingCommitCb?.(step),
    tool: (k) => this.drawingToolCb?.(k),
    text: (e) => this.drawingTextCb?.(e),
    style: (e) => this.drawingStyleCb?.(e),
    menu: (e) => this.drawingMenuCb?.(e),
  });

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
    this.overlay = document.createElement("canvas");
    this.overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
    host.appendChild(this.overlay);
    const octx = this.overlay.getContext("2d");
    if (!octx) throw new Error("Canvas 2D is not available");
    this.octx = octx;

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    if (this.hasGestures) {
      this.canvas.addEventListener("gesturestart", this.onGestureStart);
      this.canvas.addEventListener("gesturechange", this.onGestureChange);
      this.canvas.addEventListener("gestureend", this.onGestureEnd);
    }
    window.addEventListener("keydown", this.onModifier);
    window.addEventListener("keyup", this.onModifier);
    window.addEventListener("blur", this.onBlur);
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
    this.drawings.setOwner({ instrument: c.instrument.id, priceScale: c.instrument.priceScale });
    this.tf = inferTimeframe(s);
    // New bars: the next replay marks make room right of the cut again.
    this.replayOn = false;
    this.atHistoryStart = c.atHistoryStart || n === 0;
    this.olderPending = false;
    this.axisWidth = PRICE_AXIS_WIDTH;
    this.resetView();
  }

  /** Drops every candle: an empty plot until the next `setData`. */
  clear(): void {
    this.series = emptySeries(0);
    this.instrument = null;
    this.drawings.setOwner(null);
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

  /** The pair and the price in whole ticks under the mouse on the price plot; null elsewhere. */
  crosshairPrice(): { instrument: Instrument; price: number } | null {
    const m = this.mouse;
    const f = this.lastFrame;
    if (!m || !f || !this.instrument || this.drag) return null;
    if (!(m.x >= 0 && m.x < this.plot().plotW && m.y >= 0 && m.y < this.priceH())) return null;
    const v = Math.round(f.scale.fromY(m.y));
    const price = Math.min(MAX_TICKS, Math.max(f.scale.mode === "log" ? 1 : -MAX_TICKS, v));
    return Number.isSafeInteger(price) ? { instrument: this.instrument, price } : null;
  }

  /** The drawings of the instrument on the chart; selection and undo history start over. */
  setDrawings(list: Drawing[]): void {
    this.drawings.setDrawings(list);
  }

  /** Whether placed and dragged points snap to bar prices (⌘ or Ctrl inverts it per move). */
  setDrawingMagnet(on: boolean): void {
    this.drawings.setMagnet(on);
  }

  /** Picks the tool the next clicks on the price plot place, or none. */
  setDrawingTool(id: ToolId | null): void {
    this.drawings.setTool(id);
  }

  /** Engine outcomes of the positions by drawing id; a position without one shows none. */
  /** The engine stored `sent` as `saved` (rescaled to a new price scale). */
  drawingStored(sent: Drawing, saved: Drawing): void {
    this.drawings.stored(sent, saved);
  }

  setPositionOutcomes(outcomes: ReadonlyMap<string, PositionOutcome>): void {
    this.drawings.setOutcomes(outcomes);
  }

  /** The text editor of a drawing opens (where, in CSS px of the chart) or closes (null). */
  onDrawingText(cb: ((edit: TextEdit | null) => void) | null): void {
    this.drawingTextCb = cb;
  }

  /** Closes the open text editor: save with the text, delete the drawing, or cancel (null). */
  finishDrawingText(result: TextResult): void {
    this.drawings.finishText(result);
  }

  /** The style popover of a drawing opens or shows a change (where, in CSS px of the chart), or closes (null). */
  onDrawingStyle(cb: ((edit: StyleEdit | null) => void) | null): void {
    this.drawingStyleCb = cb;
  }

  /** Changes or deletes the drawing of the open style popover, or closes it (null). */
  drawingStyle(action: StyleAction): void {
    this.drawings.styleAction(action);
  }

  /** The context menu of the selected drawings opens (where, in CSS px of the chart) or closes (null). */
  onDrawingMenu(cb: ((edit: MenuEdit | null) => void) | null): void {
    this.drawingMenuCb = cb;
  }

  /** Runs a context menu item on the drawings it opened for, or closes it (null). */
  drawingMenu(action: MenuAction): void {
    this.drawings.menuAction(action);
  }

  /** Shows every drawing hidden one by one again, as one undo step. */
  showHiddenDrawings(): void {
    this.drawings.showHidden();
  }

  /** Hide all drawings for this session (painting and hit-testing), or show them again. */
  setDrawingsHidden(on: boolean): void {
    this.drawings.setHiddenAll(on);
  }

  /** Undo, redo, delete the selection, cancel, arm the ruler, or edit the text of the selection; false when there was nothing to do. */
  drawingCommand(cmd: DrawingCommand): boolean {
    return this.drawings.command(cmd);
  }

  /** Every change of a drawing by the user, undo and redo included, to be stored. */
  onDrawingCommit(cb: ((step: DrawingChange[]) => void) | null): void {
    this.drawingCommitCb = cb;
  }

  /** The active tool changed on the chart (placed, cancelled). */
  onDrawingTool(cb: ((id: ToolId | null) => void) | null): void {
    this.drawingToolCb = cb;
  }

  /** Every alert; the active price alerts of the chart's pair are drawn as levels. */
  setAlerts(alerts: readonly Alert[]): void {
    this.alertLevels.set(alerts);
    this.invalidate();
  }

  /** A press on an alert level: called with the alert's id. */
  onAlertClick(cb: ((id: string) => void) | null): void {
    this.alertClickCb = cb;
  }

  /** A replay's trades and where its revealed bars end, or none. */
  setReplay(m: ReplayMarks | null): void {
    const entering = m !== null && !this.replayOn;
    this.replayOn = m !== null;
    this.replay.set(m);
    // No drawing anchored after the last revealed bar gives that bar away.
    this.drawings.setCutoff(m ? m.time : null);
    // Entering a replay on the last bar: leave room for the trade right of the cut. New bars keep it.
    if (entering && this.view.rightIndex >= this.series.count - 1) {
      this.view = { barWidth: this.view.barWidth, rightIndex: this.series.count - 1 + REPLAY_MARGIN_BARS };
      this.afterViewChange();
      return;
    }
    this.invalidate();
  }

  /** The stop or take of the open replay trade was dragged and dropped. */
  onReplayEdit(cb: ((stop: number, take: number) => void) | null): void {
    this.replayEditCb = cb;
  }

  /**
   * Picks a replay start: while set, the bar under the mouse is marked and a click on it
   * calls `cb` with its open time instead of panning or drawing. Null ends it.
   */
  setPick(cb: ((time: number) => void) | null): void {
    this.pickCb = cb;
    this.canvas.style.cursor = "crosshair";
    this.invalidateOverlay();
  }

  /** Open time of the first loaded bar at or after `t`, for a replay start picked by date. */
  barAtOrAfter(t: number): number | null {
    return snapStart(this.series.time, this.series.count, t);
  }

  /** Price axis width in CSS px. */
  get priceAxisWidth(): number {
    return this.axisWidth;
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
    window.removeEventListener("keydown", this.onModifier);
    window.removeEventListener("keyup", this.onModifier);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    if (this.hasGestures) {
      this.canvas.removeEventListener("gesturestart", this.onGestureStart);
      this.canvas.removeEventListener("gesturechange", this.onGestureChange);
      this.canvas.removeEventListener("gestureend", this.onGestureEnd);
    }
    this.canvas.remove();
    this.overlay.remove();
    this.lastFrame = null;
    this.needOlderCb = null;
    this.crosshairCb = null;
    this.drawingCommitCb = null;
    this.drawingToolCb = null;
    this.drawingTextCb = null;
    this.drawingStyleCb = null;
    this.drawingMenuCb = null;
    this.replayEditCb = null;
    this.pickCb = null;
  }

  // ---- Internals ----

  private grow(): void {
    const old = this.series;
    const s = emptySeries(old.time.length * 2 + 1024);
    for (const k of KEYS) s[k].set(old[k].subarray(0, old.count));
    s.count = old.count;
    this.series = s;
  }

  /** Redraws both layers on the next frame. */
  private invalidate(): void {
    this.baseDirty = true;
    this.invalidateOverlay();
  }

  /** Redraws only the overlay on the next frame (unless the base is dirty too). */
  private invalidateOverlay(): void {
    this.overlayDirty = true;
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
    this.overlay.width = this.canvas.width;
    this.overlay.height = this.canvas.height;
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

  /** Call after any change of data or viewport. */
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
    let extra = ind.layers.length > 0 ? overlayRange(ind.layers, ind.offsets, range[0], range[1], ind.tickMul) : null;
    // The open replay trade's stop and take stay in view: they are what the user drags.
    const levels = this.replay.scalePrices();
    if (levels.length > 0) {
      const lo = Math.min(...levels);
      const hi = Math.max(...levels);
      extra = extra ? [Math.min(extra[0], lo), Math.max(extra[1], hi)] : [lo, hi];
    }
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
    const debug = chartDebug();
    if (this.baseDirty) {
      this.baseDirty = false;
      this.renderBase();
      if (debug) {
        if (debug.baseMs.length >= 10_000) debug.baseMs.length = 0;
        debug.baseMs.push(performance.now() - started);
        debug.baseDraws++;
      }
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      const overlayStarted = performance.now();
      this.renderOverlay();
      if (debug) {
        if (debug.overlayMs.length >= 10_000) debug.overlayMs.length = 0;
        debug.overlayMs.push(performance.now() - overlayStarted);
        debug.overlayDraws++;
      }
    }
    if (debug) {
      if (debug.drawMs.length >= 10_000) debug.drawMs.length = 0;
      debug.drawMs.push(performance.now() - started);
    }
  };

  private renderBase(): void {
    const priceH = this.priceH();
    const decimals = this.instrument?.priceScale ?? 0;
    const s = this.series;
    const lastClose = s.count > 0 ? s.close[s.count - 1]! : NaN;
    let scale = this.priceScale(priceH);
    this.updatePanes();
    const axis = priceAxisWidth(this.ctx, this.buffers, this.dpr, scale, decimals, lastClose, this.ind.panes);
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
    const historyStart =
      this.atHistoryStart && s.count > 0 && this.historyLabel ? this.historyLabel(s.time[0]!) : null;
    const f: FrameInput = {
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
      historyStart,
      theme: this.theme,
      indicators: this.ind,
    };
    draw(f, this.buffers);
    // Months differ in length: 1M extrapolates by calendar months, not by 30 days.
    const step: Step = this.tf === "1M" ? "month" : (STEP_MS.get(this.tf) ?? 60 * MINUTE);
    const coords = new Coords(s.time, s.count, this.view, scale, plotW, priceH, step, decimals, s);
    // Under the drawings: a line the user drew at the same price stays on top.
    this.alertLevels.paintBase(this.ctx, coords, this.dpr, this.theme, this.instrument);
    for (const p of this.alertLevels.axisPrices()) drawingTag(this.ctx, f, this.buffers, p, this.theme.muted);
    this.drawings.paintBase(this.ctx, coords, this.dpr, this.theme, (p, color) =>
      drawingTag(this.ctx, f, this.buffers, p, color),
    );
    this.replay.paintBase(this.ctx, coords, this.dpr, this.theme);
    for (const p of this.replay.axisPrices()) drawingTag(this.ctx, f, this.buffers, p, this.theme.muted);
    this.lastFrame = f;
    const debug = chartDebug();
    if (debug) {
      debug.axisWidth = this.axisWidth;
      debug.widestLabel = axis.widest;
      debug.widestText = axis.widestText;
      debug.canvasWidth = this.width;
      debug.plotWidth = plotW;
      debug.historyLabel = historyStart ? historyStart.join("|") : null;
      debug.panes = this.ind.panes.length;
      debug.lastBarTime = s.count > 0 ? s.time[s.count - 1]! : null;
      debug.indicatorLastTimes = this.ind.layers.flatMap((l) => (l.computed ? [l.computed.lastTime] : []));
    }
  }

  private renderOverlay(): void {
    const f = this.lastFrame;
    if (!f) return;
    const { plotW, plotH } = this.plot();
    const m = this.mouse;
    const inPlot = m !== null && m.x >= 0 && m.x < plotW && m.y >= 0 && m.y < plotH;
    const ch = this.crosshair;
    if (inPlot) {
      ch.x = m.x;
      ch.y = m.y;
      ch.index = this.crosshairIndex;
    }
    const octx = this.octx;
    drawOverlay(f, octx, inPlot ? ch : null, this.buffers, () => {
      this.drawings.paintOverlay(octx, this.dpr, this.theme, (p, color) => drawingTag(octx, f, this.buffers, p, color));
      if (this.pickCb && inPlot && this.crosshairIndex !== null) {
        const x = indexToX(this.view, this.crosshairIndex, plotW);
        this.replay.paintPick(octx, x, plotW, plotH, this.dpr, this.theme);
      }
    });
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    // On macOS Ctrl+click is a right click: `contextmenu` opens our menu instead.
    if (e.button !== 0 || macContextClick(e)) return;
    const p = this.local(e);
    const { plotW } = this.plot();
    const priceH = this.priceH();
    const onPriceAxis = p.x >= plotW && p.y < priceH;
    if (this.pickCb) {
      // Picking a replay start: a click on a bar picks it; nothing else happens.
      this.mouse = p;
      this.updateCrosshair();
      const i = this.crosshairIndex;
      if (i !== null && p.y < this.plot().plotH) this.pickCb(this.series.time[i]!);
      return;
    }
    // The open replay trade's stop and take come first, then drawings: a tool places, a press on a drawing selects it.
    const level: Level | null = this.inPricePlot(p) ? this.replay.handleAt(p.x, p.y) : null;
    if (level) this.replay.startDrag(level);
    const onDrawing =
      !level && this.inPricePlot(p) && this.drawings.pointerDown(p.x, p.y, e.shiftKey, cmdHeld(e));
    // An alert level selects its alert; the press still pans, as on an empty plot.
    const alert = !level && !onDrawing ? this.alertLevels.hit(p.x, p.y) : null;
    if (alert) this.alertClickCb?.(alert);
    const kind = level ? "replay" : onDrawing ? "drawing" : onPriceAxis ? "price" : "pan";
    this.drag = { kind, pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
    if (kind === "pan") this.canvas.style.cursor = "grabbing";
    else this.updateCursor(p);
  };

  private inPricePlot(p: { x: number; y: number }): boolean {
    return p.x >= 0 && p.x < this.plot().plotW && p.y >= 0 && p.y < this.priceH();
  }

  private updateCursor(p: { x: number; y: number }): void {
    if (this.pickCb) {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    const onPriceAxis = p.x >= this.plot().plotW && p.y < this.priceH();
    const onLevel = this.replay.dragging || (this.inPricePlot(p) && this.replay.handleAt(p.x, p.y) !== null);
    const onAlert = !this.drag && this.alertLevels.hit(p.x, p.y) !== null;
    this.canvas.style.cursor =
      onPriceAxis || onLevel ? "ns-resize" : (this.drawings.cursor() ?? (onAlert ? "pointer" : "crosshair"));
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const p = this.local(e);
    this.mouse = p;
    const priceH = this.priceH();
    const d = this.drag;
    if (d?.kind === "replay" && d.pointerId === e.pointerId) {
      this.replay.moveDrag(p.y);
      this.updateCrosshair();
      this.invalidate();
      return;
    }
    if (d?.kind === "drawing" && d.pointerId === e.pointerId) {
      this.drawings.pointerMove(p.x, p.y, e.shiftKey, cmdHeld(e));
      this.updateCrosshair();
      this.invalidateOverlay();
      return;
    }
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
      this.afterViewChange();
      return;
    }
    if (this.inPricePlot(p)) this.drawings.pointerMove(p.x, p.y, e.shiftKey, cmdHeld(e));
    else this.drawings.leave();
    this.updateCursor(p);
    // Only the mouse moved: the base layer stays as it is.
    this.updateCrosshair();
    this.invalidateOverlay();
  };

  /** ⌘ (Ctrl) pressed or let go with the mouse still: drawings snap (and preview it) at once. */
  private readonly onModifier = (e: KeyboardEvent): void => {
    if (e.key !== "Meta" && e.key !== "Control") return;
    this.drawings.modifiers(cmdHeld(e));
  };

  /** The window lost focus: a ⌘ let go elsewhere never sends its keyup here. */
  private readonly onBlur = (): void => this.drawings.modifiers(false);

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.drag?.pointerId !== e.pointerId) return;
    const kind = this.drag.kind;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const p = this.local(e);
    if (kind === "replay") {
      // A cancelled pointer leaves the levels as they were.
      const levels = e.type === "pointercancel" ? (this.replay.endDrag(), null) : this.replay.endDrag();
      if (levels) this.replayEditCb?.(levels.stop, levels.take);
      this.invalidate();
    }
    if (kind === "drawing") {
      // A cancelled pointer (a system gesture) stores nothing.
      if (e.type === "pointercancel") this.drawings.abort();
      else this.drawings.pointerUp(p.x, p.y, e.shiftKey, cmdHeld(e));
      this.invalidateOverlay();
    }
    this.updateCursor(p);
  };

  private readonly onPointerLeave = (): void => {
    if (this.drag) return;
    this.drawings.leave();
    this.mouse = null;
    this.updateCrosshair();
    this.invalidateOverlay();
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

  /** Our own menu on a drawing; never the web view's over it (the window blocks it elsewhere, except in dev). */
  private readonly onContextMenu = (e: MouseEvent): void => {
    if (!import.meta.env.DEV) e.preventDefault();
    if (this.drag || this.pickCb) return;
    const p = this.local(e);
    if (this.inPricePlot(p) && this.drawings.contextMenu(p.x, p.y)) e.preventDefault();
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    const p = this.local(e);
    if (this.inPricePlot(p)) {
      this.drawings.doubleClick(p.x, p.y);
      return;
    }
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

