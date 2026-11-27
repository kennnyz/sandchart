import type { Marker, SeriesSpec } from "../backend/types";
import { formatPrice } from "./format";
import { seriesValues, type IndicatorLayer } from "./indicators";
import type { FrameInput, RenderBuffers } from "./render";
import type { PriceScale } from "./scale";
import type { ChartTheme } from "./theme";
import { indexToX, type Viewport } from "./viewport";

/** One own pane of the frame: where it sits (CSS px from the plot top) and its value scale. */
export interface PaneFrame {
  /** Index into `IndicatorFrame.layers`. */
  layer: number;
  top: number;
  height: number;
  /** Null while the layer has no finite value on screen. */
  scale: PriceScale | null;
  /** Up to three label values of `scale`. */
  ticks: number[];
}

/** Indicator state of one frame. The chart keeps one and updates it in place. */
export interface IndicatorFrame {
  layers: IndicatorLayer[];
  /** Chart index of value 0 of each layer, null when the layer is not aligned. */
  offsets: (number | null)[];
  /** `10 ** priceScale`: a `pane: price` value times this is price ticks. */
  tickMul: number;
  /** Height of the price plot in CSS px; the own panes follow below it. */
  priceH: number;
  panes: PaneFrame[];
}

const LINE_WIDTH = 1.5;
const HISTOGRAM_RATIO = 0.72;
const MARKER_SIZE = 6;
const MARKER_GAP = 3;

/** Value label of an own pane: two decimals below 1000, none from 1000 up. */
export function formatPaneValue(v: number): string {
  return Math.abs(v) < 1000 ? formatPrice(Math.round(v * 100), 2) : formatPrice(Math.round(v), 0);
}

function colorOf(th: ChartTheme, layer: IndicatorLayer, spec: SeriesSpec): string {
  const slot = layer.colors[spec.id] ?? spec.color;
  return th.indicatorPalette[slot & 7] ?? th.muted;
}

/** Bars and pixel mapping shared by every series of one pane in one frame. */
interface Ctx2 {
  ctx: CanvasRenderingContext2D;
  view: Viewport;
  plotW: number;
  dpr: number;
  first: number;
  last: number;
  scale: PriceScale;
  /** Multiplier from series values to `scale` units. */
  mul: number;
  /** Pane top in CSS px. */
  top: number;
}

function strokeLine(c: Ctx2, values: Float64Array, offset: number): void {
  const { ctx, view, plotW, dpr, scale, mul, top } = c;
  const from = Math.max(0, c.first - offset);
  const to = Math.min(values.length - 1, c.last - offset);
  ctx.beginPath();
  let pen = false;
  for (let k = from; k <= to; k++) {
    const v = values[k]!;
    if (v - v !== 0) {
      pen = false;
      continue;
    }
    const x = indexToX(view, offset + k, plotW) * dpr;
    const y = (top + scale.toY(v * mul)) * dpr;
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
}

/** Bars from 0; `upColor` for values >= 0, `downColor` below 0. */
function fillHistogram(c: Ctx2, values: Float64Array, offset: number, upColor: string, downColor: string): void {
  const { ctx, view, plotW, dpr, scale, mul, top } = c;
  const from = Math.max(0, c.first - offset);
  const to = Math.min(values.length - 1, c.last - offset);
  const w = Math.max(1, Math.round(view.barWidth * dpr * HISTOGRAM_RATIO));
  const y0 = Math.round((top + scale.toY(0)) * dpr);
  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 0;
    ctx.fillStyle = up ? upColor : downColor;
    for (let k = from; k <= to; k++) {
      const v = values[k]!;
      if (v - v !== 0 || v >= 0 !== up) continue;
      const y = Math.round((top + scale.toY(v * mul)) * dpr);
      const h = Math.abs(y - y0);
      if (h === 0) continue;
      const x = Math.round(indexToX(view, offset + k, plotW) * dpr - w / 2);
      ctx.fillRect(x, Math.min(y, y0), w, h);
    }
  }
}

/** Fill between lines `a` and `b`; a bar where either side is not finite leaves a gap. */
function fillBand(c: Ctx2, a: Float64Array, b: Float64Array, offset: number): void {
  const { ctx, view, plotW, dpr, scale, mul, top } = c;
  const from = Math.max(0, c.first - offset);
  const to = Math.min(a.length - 1, b.length - 1, c.last - offset);
  const ok = (k: number) => a[k]! - a[k]! === 0 && b[k]! - b[k]! === 0;
  ctx.beginPath();
  let k = from;
  while (k <= to) {
    while (k <= to && !ok(k)) k++;
    if (k > to) break;
    const start = k;
    while (k <= to && ok(k)) k++;
    for (let j = start; j < k; j++) {
      const x = indexToX(view, offset + j, plotW) * dpr;
      const y = (top + scale.toY(a[j]! * mul)) * dpr;
      if (j === start) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let j = k - 1; j >= start; j--) {
      ctx.lineTo(indexToX(view, offset + j, plotW) * dpr, (top + scale.toY(b[j]! * mul)) * dpr);
    }
    ctx.closePath();
  }
  ctx.fill();
}

/** Draws the layer's series on one pane in the order bands, histograms, lines. */
function drawLayerSeries(c: Ctx2, th: ChartTheme, layer: IndicatorLayer, offset: number, pane: "price" | "own"): void {
  const computed = layer.computed!;
  const { ctx } = c;
  for (const spec of layer.meta.series) {
    if (spec.pane !== pane || typeof spec.kind !== "object") continue;
    const a = seriesValues(computed, spec.kind.band[0]);
    const b = seriesValues(computed, spec.kind.band[1]);
    if (!a || !b) continue;
    ctx.globalAlpha = th.bandOpacity;
    ctx.fillStyle = colorOf(th, layer, spec);
    fillBand(c, a, b, offset);
    ctx.globalAlpha = 1;
  }
  for (const spec of layer.meta.series) {
    if (spec.pane !== pane || spec.kind !== "histogram") continue;
    const v = seriesValues(computed, spec.id);
    if (!v) continue;
    const picked = layer.colors[spec.id] !== undefined ? colorOf(th, layer, spec) : null;
    fillHistogram(c, v, offset, picked ?? th.up, picked ?? th.down);
  }
  ctx.lineWidth = LINE_WIDTH * c.dpr;
  ctx.lineJoin = "round";
  for (const spec of layer.meta.series) {
    if (spec.pane !== pane || spec.kind !== "line") continue;
    const v = seriesValues(computed, spec.id);
    if (!v) continue;
    ctx.strokeStyle = colorOf(th, layer, spec);
    strokeLine(c, v, offset);
  }
}

function drawable(ind: IndicatorFrame, i: number): number | null {
  const layer = ind.layers[i]!;
  if (layer.error !== null || layer.computed === null) return null;
  return ind.offsets[i] ?? null;
}

/** Bands, histograms and lines on `pane: price`, under the markers; the caller clips. */
export function drawPriceSeries(f: FrameInput, ind: IndicatorFrame, first: number, last: number, plotW: number): void {
  const c: Ctx2 = { ctx: f.ctx, view: f.view, plotW, dpr: f.dpr, first, last, scale: f.scale, mul: ind.tickMul, top: 0 };
  for (let i = 0; i < ind.layers.length; i++) {
    const offset = drawable(ind, i);
    if (offset !== null) drawLayerSeries(c, f.theme, ind.layers[i]!, offset, "price");
  }
}

/** Markers of `pane: price`: `up` under the low, `down` over the high, `dot` at the close. */
export function drawMarkers(
  f: FrameInput,
  ind: IndicatorFrame,
  buf: RenderBuffers,
  first: number,
  last: number,
  plotW: number,
): void {
  const { ctx, dpr, view, theme: th } = f;
  const size = MARKER_SIZE * dpr;
  const gap = MARKER_GAP * dpr;
  for (let i = 0; i < ind.layers.length; i++) {
    const offset = drawable(ind, i);
    if (offset === null) continue;
    const layer = ind.layers[i]!;
    for (const spec of layer.meta.series) {
      if (spec.kind !== "markers") continue;
      const data = layer.computed!.series.find((x) => x.id === spec.id)?.data;
      if (!data || !("markers" in data) || data.markers.length === 0) continue;
      const markers = data.markers;
      ctx.fillStyle = colorOf(th, layer, spec);
      ctx.beginPath();
      let texts = false;
      for (const m of markers) {
        const y = markerY(m, offset, first, last, f, gap, size);
        if (y === null) continue;
        const x = indexToX(view, offset + m.index, plotW) * dpr;
        if (m.shape === "up") {
          ctx.moveTo(x, y - size / 2);
          ctx.lineTo(x + size / 2, y + size / 2);
          ctx.lineTo(x - size / 2, y + size / 2);
          ctx.closePath();
        } else if (m.shape === "down") {
          ctx.moveTo(x, y + size / 2);
          ctx.lineTo(x - size / 2, y - size / 2);
          ctx.lineTo(x + size / 2, y - size / 2);
          ctx.closePath();
        } else {
          ctx.moveTo(x + size / 2, y);
          ctx.arc(x, y, size / 2, 0, 2 * Math.PI);
        }
        if (m.text) texts = true;
      }
      ctx.fill();
      if (!texts) continue;
      ctx.font = buf.markerFont(dpr);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const m of markers) {
        if (!m.text) continue;
        const y = markerY(m, offset, first, last, f, gap, size);
        if (y === null) continue;
        ctx.fillText(m.text, indexToX(view, offset + m.index, plotW) * dpr + size / 2 + gap, y);
      }
    }
  }
}

/** Device-px centre row of a marker, null when its bar is off screen. */
function markerY(
  m: Marker,
  offset: number,
  first: number,
  last: number,
  f: FrameInput,
  gap: number,
  size: number,
): number | null {
  const i = offset + m.index;
  if (i < first || i > last || i >= f.series.count) return null;
  const { scale, series: s, dpr } = f;
  if (m.shape === "up") return scale.toY(s.low[i]!) * dpr + gap + size / 2;
  if (m.shape === "down") return scale.toY(s.high[i]!) * dpr - gap - size / 2;
  return scale.toY(s.close[i]!) * dpr;
}

/** Every own pane: 1 px top separator, grid at its label values, then its series, clipped. */
export function drawPanes(
  f: FrameInput,
  ind: IndicatorFrame,
  first: number,
  last: number,
  plotW: number,
  pw: number,
  W: number,
  px: number,
): void {
  const { ctx, dpr, theme: th } = f;
  for (const p of ind.panes) {
    const top = Math.round(p.top * dpr);
    const h = Math.round(p.height * dpr);
    ctx.fillStyle = th.line;
    ctx.fillRect(0, top, W, px);
    const offset = drawable(ind, p.layer);
    if (!p.scale || offset === null || h <= px) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top + px, pw, h - px);
    ctx.clip();
    ctx.fillStyle = th.grid;
    for (const t of p.ticks) ctx.fillRect(0, Math.round((p.top + p.scale.toY(t)) * dpr), pw, px);
    const c: Ctx2 = { ctx, view: f.view, plotW, dpr, first, last, scale: p.scale, mul: 1, top: p.top };
    drawLayerSeries(c, th, ind.layers[p.layer]!, offset, "own");
    ctx.restore();
  }
}
