import type { TimeframeCode } from "../backend/types";
import { formatCrosshairTime, formatPrice, formatTimeLabel } from "./format";
import type { PriceScale } from "./scale";
import { MONO_FAMILY, PRICE_AXIS_WIDTH, SANS_FAMILY, TIME_AXIS_HEIGHT, VOLUME_HEIGHT, type CandleStyle, type ChartTheme } from "./theme";
import { indexToX, visibleRange, type Viewport } from "./viewport";

/** Columnar candles in typed arrays; only the first `count` entries are valid. */
export interface Series {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  count: number;
}

/** Crosshair position in CSS px inside the plot; `index` is the bar it snaps to, if any. */
export interface Crosshair {
  x: number;
  y: number;
  index: number | null;
}

export interface FrameInput {
  ctx: CanvasRenderingContext2D;
  dpr: number;
  /** Whole canvas in CSS px. */
  width: number;
  height: number;
  /** Price axis width in CSS px (from `priceAxisWidth`). */
  axisWidth: number;
  series: Series;
  view: Viewport;
  /** Maps prices to CSS px rows of the plot. */
  scale: PriceScale;
  priceDecimals: number;
  tf: TimeframeCode;
  crosshair: Crosshair | null;
  /** Two lines for the start-of-history marker, or null when the first candle is not the first one. */
  historyStart: [string, string] | null;
  theme: ChartTheme;
}

const LABEL_HEIGHT = 18;
const LABEL_PAD = 8;
const MIN_TIME_LABEL_SPACING = 100;
const MIN_PRICE_TICK_SPACING = 56;
const BODY_RATIO = 0.72;
/** Tint of the empty area left of the first candle (Design Reference, States). */
const HISTORY_TINT = "rgba(128,140,160,0.06)";

/** Scratch memory reused across frames so a frame allocates (almost) nothing. */
export class RenderBuffers {
  colX = new Float64Array(0);
  colLo = new Float64Array(0);
  colHi = new Float64Array(0);
  colOpen = new Float64Array(0);
  colClose = new Float64Array(0);
  colVol = new Float64Array(0);
  markIndex = new Int32Array(512);
  markCount = 0;
  private fontDpr = 0;
  font = "";

  ensureColumns(n: number): void {
    if (this.colX.length >= n) return;
    this.colX = new Float64Array(n);
    this.colLo = new Float64Array(n);
    this.colHi = new Float64Array(n);
    this.colOpen = new Float64Array(n);
    this.colClose = new Float64Array(n);
    this.colVol = new Float64Array(n);
  }

  axisFont(dpr: number): string {
    if (dpr !== this.fontDpr) {
      this.fontDpr = dpr;
      this.font = `${11 * dpr}px ${MONO_FAMILY}`;
    }
    return this.font;
  }
}

export function plotSize(width: number, height: number, axisWidth: number): { plotW: number; plotH: number } {
  return { plotW: Math.max(0, width - axisWidth), plotH: Math.max(0, height - TIME_AXIS_HEIGHT) };
}

function priceTicks(scale: PriceScale): number[] {
  return scale.ticks(Math.max(2, Math.floor(scale.heightPx / MIN_PRICE_TICK_SPACING)));
}

/**
 * Widest price label (tick labels, last price, crosshair price) in CSS px, and the
 * price axis width that fits it: at least PRICE_AXIS_WIDTH, else the label plus padding.
 */
export function priceAxisWidth(
  ctx: CanvasRenderingContext2D,
  buf: RenderBuffers,
  dpr: number,
  scale: PriceScale,
  decimals: number,
  lastClose: number,
  crosshairY: number | null,
): { width: number; widest: number } {
  ctx.font = buf.axisFont(dpr);
  let widest = 0;
  const measure = (text: string) => {
    const w = ctx.measureText(text).width / dpr;
    if (w > widest) widest = w;
  };
  for (const t of priceTicks(scale)) measure(formatPrice(Math.round(t), decimals));
  if (Number.isFinite(lastClose)) measure(formatPrice(lastClose, decimals));
  if (crosshairY !== null) measure(formatPrice(Math.round(scale.fromY(crosshairY)), decimals));
  return { width: Math.max(PRICE_AXIS_WIDTH, Math.ceil(widest + 2 * LABEL_PAD)), widest };
}

export function draw(f: FrameInput, buf: RenderBuffers): void {
  const { ctx, dpr, theme: th, series: s, view } = f;
  const { plotW, plotH } = plotSize(f.width, f.height, f.axisWidth);
  const W = Math.round(f.width * dpr);
  const H = Math.round(f.height * dpr);
  const pw = Math.round(plotW * dpr);
  const ph = Math.round(plotH * dpr);
  const px = Math.max(1, Math.round(dpr));

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, W, H);
  if (plotW <= 0 || plotH <= 0) return;

  const [first, last] = visibleRange(view, plotW, s.count);
  const hasBars = last >= first && s.count > 0;
  const ticks = priceTicks(f.scale);
  if (hasBars) timeMarks(f, buf, first, last, plotW);

  // Grid.
  ctx.fillStyle = th.grid;
  for (const t of ticks) {
    const y = Math.round(f.scale.toY(t) * dpr);
    if (y >= 0 && y < ph) ctx.fillRect(0, y, pw, px);
  }
  for (let m = 0; m < buf.markCount; m++) {
    const x = Math.round(indexToX(view, buf.markIndex[m]!, plotW) * dpr);
    ctx.fillRect(x, 0, px, ph);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, pw, ph);
  ctx.clip();
  if (f.historyStart && s.count > 0) drawHistoryStart(f, plotW, plotH, px);
  if (hasBars) {
    if (view.barWidth >= 2) drawCandles(f, plotW, plotH, first, last, px);
    else drawColumns(f, buf, plotW, plotH, first, last, px);
  }

  const lastClose = s.count > 0 ? s.close[s.count - 1]! : NaN;
  const lastY = s.count > 0 ? f.scale.toY(lastClose) : NaN;
  ctx.lineWidth = px;
  if (Number.isFinite(lastY)) {
    ctx.strokeStyle = th.lastPriceLine;
    ctx.setLineDash([2 * px, 2 * px]);
    const y = Math.round(lastY * dpr) + px / 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(pw, y);
    ctx.stroke();
  }

  const ch = f.crosshair;
  let chX = 0;
  if (ch) {
    chX = ch.index === null ? ch.x : indexToX(view, ch.index, plotW);
    ctx.strokeStyle = th.muted;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.beginPath();
    const x = Math.round(chX * dpr) + px / 2;
    const y = Math.round(ch.y * dpr) + px / 2;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ph);
    ctx.moveTo(0, y);
    ctx.lineTo(pw, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // Axis borders.
  ctx.fillStyle = th.line;
  ctx.fillRect(pw, 0, px, H);
  ctx.fillRect(0, ph, W, px);

  ctx.font = buf.axisFont(dpr);
  ctx.textBaseline = "middle";

  // Price axis: tick labels hidden where the last-price or crosshair label sits.
  ctx.fillStyle = th.muted;
  ctx.textAlign = "left";
  let prevLabel = NaN;
  for (const t of ticks) {
    const ticksValue = Math.round(t);
    if (ticksValue === prevLabel) continue;
    prevLabel = ticksValue;
    const y = f.scale.toY(t);
    if (y < LABEL_HEIGHT / 2 || y > plotH - LABEL_HEIGHT / 2) continue;
    if (Math.abs(y - lastY) < LABEL_HEIGHT) continue;
    if (ch && Math.abs(y - ch.y) < LABEL_HEIGHT) continue;
    ctx.fillText(formatPrice(ticksValue, f.priceDecimals), pw + LABEL_PAD * dpr, Math.round(y * dpr));
  }

  // Time axis: labels under the crosshair time label are hidden.
  ctx.textAlign = "center";
  const timeY = ph + Math.round((TIME_AXIS_HEIGHT / 2) * dpr);
  const chTime = ch && ch.index !== null ? formatCrosshairTime(s.time[ch.index]!, f.tf) : null;
  const chHalf = chTime ? ctx.measureText(chTime).width / 2 + LABEL_PAD * dpr : 0;
  for (let m = 0; m < buf.markCount; m++) {
    const i = buf.markIndex[m]!;
    const prev = i > 0 ? s.time[i - 1]! : null;
    const text = formatTimeLabel(s.time[i]!, f.tf, prev);
    const x = Math.round(indexToX(view, i, plotW) * dpr);
    if (chTime && Math.abs(x - chX * dpr) < chHalf + ctx.measureText(text).width / 2 + LABEL_PAD * dpr) continue;
    ctx.fillText(text, x, timeY);
  }

  if (Number.isFinite(lastY) && lastY >= 0 && lastY <= plotH) {
    priceLabel(ctx, formatPrice(lastClose, f.priceDecimals), lastY, pw, W, dpr, th.lastPriceBg, th.lastPriceText);
  }
  if (ch) {
    const price = Math.round(f.scale.fromY(ch.y));
    priceLabel(ctx, formatPrice(price, f.priceDecimals), ch.y, pw, W, dpr, th.crosshairLabelBg, th.fg);
    if (chTime) timeLabel(ctx, f.theme, chTime, chX, ph, pw, dpr);
  }
}

/** Tints the area before the first candle, draws a 1 px line at its edge and the label. */
function drawHistoryStart(f: FrameInput, plotW: number, plotH: number, px: number): void {
  const { ctx, dpr, theme: th, view } = f;
  const edge = indexToX(view, 0, plotW) - view.barWidth / 2;
  if (edge <= 0 || edge >= plotW) return;
  const x = Math.round(edge * dpr);
  ctx.fillStyle = HISTORY_TINT;
  ctx.fillRect(0, 0, x, Math.round(plotH * dpr));
  ctx.fillStyle = th.muted;
  ctx.fillRect(x, 0, px, Math.round(plotH * dpr));

  const [title, detail] = f.historyStart!;
  const gap = 10 * dpr;
  const y = Math.round((plotH / 2) * dpr);
  ctx.textBaseline = "middle";
  // Left of the line when there is room for it, otherwise right of it.
  ctx.font = `600 ${12 * dpr}px ${SANS_FAMILY}`;
  const room = x - gap > Math.max(ctx.measureText(title).width, ctx.measureText(detail).width + 20 * dpr);
  ctx.textAlign = room ? "right" : "left";
  const tx = room ? x - gap : x + gap;
  ctx.fillStyle = th.fg;
  ctx.fillText(title, tx, y - 9 * dpr);
  ctx.font = `${11 * dpr}px ${MONO_FAMILY}`;
  ctx.fillStyle = th.muted;
  ctx.fillText(detail, tx, y + 9 * dpr);
}

function priceLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  yCss: number,
  pw: number,
  W: number,
  dpr: number,
  bg: string,
  fg: string,
): void {
  const h = Math.round(LABEL_HEIGHT * dpr);
  const top = Math.round(yCss * dpr - h / 2);
  ctx.fillStyle = bg;
  ctx.fillRect(pw, top, W - pw, h);
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.fillText(text, pw + LABEL_PAD * dpr, top + h / 2);
}

function timeLabel(
  ctx: CanvasRenderingContext2D,
  th: ChartTheme,
  text: string,
  xCss: number,
  ph: number,
  pw: number,
  dpr: number,
): void {
  const w = ctx.measureText(text).width + 2 * LABEL_PAD * dpr;
  const h = Math.round((TIME_AXIS_HEIGHT - 4) * dpr);
  const left = Math.round(Math.min(Math.max(0, xCss * dpr - w / 2), pw - w));
  const top = ph + Math.round(2 * dpr);
  ctx.fillStyle = th.crosshairLabelBg;
  ctx.fillRect(left, top, Math.round(w), h);
  ctx.fillStyle = th.fg;
  ctx.textAlign = "center";
  ctx.fillText(text, left + w / 2, top + h / 2);
}

function maxVolume(s: Series, first: number, last: number): number {
  let max = 0;
  for (let i = first; i <= last; i++) if (s.volume[i]! > max) max = s.volume[i]!;
  return max;
}

/** One candle per bar: 1 px wick, body with a 1 px border, volume below. */
function drawCandles(f: FrameInput, plotW: number, plotH: number, first: number, last: number, px: number): void {
  const { ctx, dpr, series: s, view, scale, theme: th } = f;
  const slot = view.barWidth * dpr;
  let bodyW = Math.max(1, Math.round(slot * BODY_RATIO));
  if (slot >= 3 && bodyW > slot - 1) bodyW = Math.floor(slot - 1);
  const wickW = Math.min(px, bodyW);
  // Same parity as the wick, so the wick sits exactly in the middle.
  if ((bodyW - wickW) % 2 !== 0) bodyW = Math.max(wickW, bodyW - 1);
  const wickOff = (bodyW - wickW) / 2;
  const left = (i: number) => Math.round(indexToX(view, i, plotW) * dpr - bodyW / 2);

  const vMax = maxVolume(s, first, last);
  if (vMax > 0) {
    const base = Math.round(plotH * dpr);
    const vh = VOLUME_HEIGHT * dpr;
    ctx.globalAlpha = th.volumeOpacity;
    ctx.fillStyle = th.volume;
    for (let i = first; i <= last; i++) {
      const h = Math.round((s.volume[i]! / vMax) * vh);
      if (h > 0) ctx.fillRect(left(i), base - h, bodyW, h);
    }
    ctx.globalAlpha = 1;
  }

  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 0;
    const style: CandleStyle = up ? th.upCandle : th.downCandle;
    ctx.fillStyle = style.wick;
    for (let i = first; i <= last; i++) {
      if (s.close[i]! >= s.open[i]! !== up) continue;
      const hi = Math.round(scale.toY(s.high[i]!) * dpr);
      const lo = Math.round(scale.toY(s.low[i]!) * dpr);
      ctx.fillRect(left(i) + wickOff, hi, wickW, Math.max(px, lo - hi));
    }
    ctx.fillStyle = style.border;
    for (let i = first; i <= last; i++) {
      if (s.close[i]! >= s.open[i]! !== up) continue;
      const top = Math.round(scale.toY(Math.max(s.open[i]!, s.close[i]!)) * dpr);
      const bottom = Math.round(scale.toY(Math.min(s.open[i]!, s.close[i]!)) * dpr);
      // A body shorter than 1 px is drawn as a 1 px line.
      ctx.fillRect(left(i), top, bodyW, Math.max(px, bottom - top));
    }
    if (bodyW <= 2 * px) continue;
    ctx.fillStyle = style.body;
    for (let i = first; i <= last; i++) {
      if (s.close[i]! >= s.open[i]! !== up) continue;
      const top = Math.round(scale.toY(Math.max(s.open[i]!, s.close[i]!)) * dpr);
      const bottom = Math.round(scale.toY(Math.min(s.open[i]!, s.close[i]!)) * dpr);
      if (bottom - top > 2 * px) ctx.fillRect(left(i) + px, top + px, bodyW - 2 * px, bottom - top - 2 * px);
    }
  }
}

/** Bars narrower than 2 px: every pixel column draws one min-max bar of the bars in it. */
function drawColumns(
  f: FrameInput,
  buf: RenderBuffers,
  plotW: number,
  plotH: number,
  first: number,
  last: number,
  px: number,
): void {
  const { ctx, dpr, series: s, view, scale, theme: th } = f;
  buf.ensureColumns(Math.ceil(plotW) + 4);
  let n = -1;
  let col = NaN;
  for (let i = first; i <= last; i++) {
    const c = Math.floor(indexToX(view, i, plotW));
    if (c !== col) {
      col = c;
      n++;
      buf.colX[n] = c;
      buf.colLo[n] = s.low[i]!;
      buf.colHi[n] = s.high[i]!;
      buf.colOpen[n] = s.open[i]!;
      buf.colVol[n] = s.volume[i]!;
    } else {
      if (s.low[i]! < buf.colLo[n]!) buf.colLo[n] = s.low[i]!;
      if (s.high[i]! > buf.colHi[n]!) buf.colHi[n] = s.high[i]!;
      if (s.volume[i]! > buf.colVol[n]!) buf.colVol[n] = s.volume[i]!;
    }
    buf.colClose[n] = s.close[i]!;
  }
  const count = n + 1;

  let vMax = 0;
  for (let k = 0; k < count; k++) if (buf.colVol[k]! > vMax) vMax = buf.colVol[k]!;
  if (vMax > 0) {
    const base = Math.round(plotH * dpr);
    const vh = VOLUME_HEIGHT * dpr;
    ctx.globalAlpha = th.volumeOpacity;
    ctx.fillStyle = th.volume;
    for (let k = 0; k < count; k++) {
      const h = Math.round((buf.colVol[k]! / vMax) * vh);
      if (h > 0) ctx.fillRect(Math.round(buf.colX[k]! * dpr), base - h, px, h);
    }
    ctx.globalAlpha = 1;
  }

  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 0;
    ctx.fillStyle = up ? th.upCandle.border : th.downCandle.border;
    for (let k = 0; k < count; k++) {
      if (buf.colClose[k]! >= buf.colOpen[k]! !== up) continue;
      const hi = Math.round(scale.toY(buf.colHi[k]!) * dpr);
      const lo = Math.round(scale.toY(buf.colLo[k]!) * dpr);
      ctx.fillRect(Math.round(buf.colX[k]! * dpr), hi, px, Math.max(px, lo - hi));
    }
  }
}

// ---- Time axis marks ----

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MS_INTERVALS = [
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY,
];
const MONTH_STEPS = [1, 2, 3, 6];
const YEAR_STEPS = [1, 2, 5, 10, 20, 50, 100];
const AVG_MONTH = 30.44 * DAY;

/** Months since year 0 for a UTC time, without allocating a Date (civil-from-days). */
function monthNumber(ms: number): number {
  const z = Math.floor(ms / DAY) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return y * 12 + (m - 1);
}

/** Marks bars that start a new round interval, roughly MIN_TIME_LABEL_SPACING px apart. */
function timeMarks(f: FrameInput, buf: RenderBuffers, first: number, last: number, plotW: number): void {
  const s = f.series;
  buf.markCount = 0;
  const step = s.count > 1 ? s.time[s.count - 1]! - s.time[s.count - 2]! : HOUR;
  const minMs = (MIN_TIME_LABEL_SPACING / f.view.barWidth) * step;
  let kind = 0; // 0: fixed ms, 1: months, 2: years
  let k = MS_INTERVALS.find((iv) => iv >= minMs && iv >= step) ?? 0;
  if (k === 0) {
    kind = 1;
    k = MONTH_STEPS.find((m) => m * AVG_MONTH >= minMs) ?? 0;
    if (k === 0) {
      kind = 2;
      k = YEAR_STEPS.find((y) => y * 365.25 * DAY >= minMs) ?? 1000;
    }
  }
  const bucket = (t: number) =>
    kind === 0 ? Math.floor(t / k) : kind === 1 ? Math.floor(monthNumber(t) / k) : Math.floor(Math.floor(monthNumber(t) / 12) / k);

  let prevBucket = first > 0 ? bucket(s.time[first - 1]!) : NaN;
  let lastX = -Infinity;
  for (let i = first; i <= last; i++) {
    const b = bucket(s.time[i]!);
    if (b !== prevBucket && i > 0) {
      const x = indexToX(f.view, i, plotW);
      if (x >= 0 && x <= plotW && x - lastX >= MIN_TIME_LABEL_SPACING * 0.6 && buf.markCount < buf.markIndex.length) {
        buf.markIndex[buf.markCount++] = i;
        lastX = x;
      }
    }
    prevBucket = b;
  }
}
