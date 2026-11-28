import type { DrawingBody, ReplayTrade, Side } from "../backend/types";
import { chartDebug } from "./debug";
import type { Coords } from "./drawings/geometry";
import { pill } from "./drawings/label";
import { toolFor } from "./drawings/registry";
import { MONO_FAMILY, type ChartTheme } from "./theme";

type Position = Extract<DrawingBody, { kind: "position" }>;

/** What the chart paints of a replay: its trades and where the revealed bars end. */
export interface ReplayMarks {
  trades: readonly ReplayTrade[];
  /** Open time and close of the last revealed bar. */
  time: number;
  close: number;
  /** The word at the cut ("Replay"). */
  label: string;
}

export type Level = "stop" | "take";

/** A dragged level kept on its side of the close, so a drop is always a valid edit. */
export function clampLevel(side: Side, level: Level, close: number, p: number): number {
  const below = (side === "long") === (level === "stop");
  const v = below ? Math.min(p, close - 1) : Math.max(p, close + 1);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(-Number.MAX_SAFE_INTEGER, v));
}

/** Open time of the first of `count` ascending bar times at or after `t`; null when every bar is earlier. */
export function snapStart(times: ArrayLike<number>, count: number, t: number): number | null {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo < count ? times[lo]! : null;
}

const MINUS = "−";
const FONT = `11px ${MONO_FAMILY}`;
const LABEL_H = 18;
const PAD = 5;
const GAP = 4;
const MARK_R = 3.5;
const HANDLE_R = 4.5;
/** A press this close to a handle grabs it. */
const HANDLE_HIT = 7;
/** The open trade's zone runs this many bars past the last revealed bar. */
const ZONE_BARS = 8;
const DASH = [4, 3];
const NO_DASH: number[] = [];

/** "+2.0R", "−1.0R", "0.0R". */
export function formatR(r: number): string {
  const v = Math.abs(r).toFixed(1);
  if (v === "0.0") return "0.0R";
  return `${r > 0 ? "+" : MINUS}${v}R`;
}

/** Colour of a number by its sign only. */
function signColor(r: number, th: ChartTheme): string {
  return formatR(r) === "0.0R" ? th.fg : r > 0 ? th.up : th.down;
}

/** A label on a pill whose left edge is at `x` and vertical centre at `y`; returns its width. */
function tag(ctx: CanvasRenderingContext2D, text: string, color: string, x: number, y: number, th: ChartTheme): number {
  const w = ctx.measureText(text).width + 2 * PAD;
  pill(ctx, x, y - LABEL_H / 2, w, LABEL_H, th);
  ctx.fillStyle = color;
  ctx.fillText(text, x + PAD, y);
  return w;
}

/**
 * Paints a replay on the chart (on the base layer: it changes only with the bars, the view
 * or a drag, never with a mouse move), lets the stop and take of the open trade be dragged,
 * and marks the bar under the mouse while a start is picked (on the overlay).
 */
export class ReplayLayer {
  private marks: ReplayMarks | null = null;
  private coords: Coords | null = null;
  private drag: { level: Level; stop: number; take: number } | null = null;

  set(m: ReplayMarks | null): void {
    this.marks = m;
    this.drag = null;
  }

  /** The trade still open, if any. */
  private open(): ReplayTrade | null {
    return this.marks?.trades.find((t) => t.reason === "open") ?? null;
  }

  /** The open trade drawn as a position from its entry to a few bars past the cut. */
  private body(t: ReplayTrade, c: Coords): Position {
    const d = this.drag;
    return {
      kind: "position",
      side: t.side,
      entry: { t: t.entryTime, p: t.entryPrice },
      stop: d ? d.stop : t.stop,
      take: d ? d.take : t.take,
      endT: c.addBars(Math.max(this.marks!.time, t.entryTime), ZONE_BARS),
    };
  }

  /** The stop or take handle at (x, y) in CSS px of the price plot, if any. */
  handleAt(x: number, y: number): Level | null {
    const t = this.open();
    const c = this.coords;
    if (!t || !c) return null;
    const b = this.body(t, c);
    const mid = (c.x(b.entry.t) + c.x(b.endT)) / 2;
    if (Math.hypot(x - mid, y - c.y(b.stop)) <= HANDLE_HIT) return "stop";
    if (Math.hypot(x - mid, y - c.y(b.take)) <= HANDLE_HIT) return "take";
    return null;
  }

  startDrag(level: Level): void {
    const t = this.open();
    if (t) this.drag = { level, stop: t.stop, take: t.take };
  }

  /** Moves the dragged level to `y`, kept on its side of the close (as the engine checks an edit). */
  moveDrag(y: number): void {
    const d = this.drag;
    const t = this.open();
    const c = this.coords;
    if (!d || !t || !c || !this.marks) return;
    d[d.level] = clampLevel(t.side, d.level, this.marks.close, c.p(y));
  }

  /** Ends a drag; returns the new levels, or null when nothing was dragged or nothing changed. */
  endDrag(): { stop: number; take: number } | null {
    const d = this.drag;
    const t = this.open();
    this.drag = null;
    if (!d || !t || (d.stop === t.stop && d.take === t.take)) return null;
    return { stop: d.stop, take: d.take };
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Prices to tag on the price axis: the open trade's entry, stop and take. */
  axisPrices(): number[] {
    const t = this.open();
    const d = this.drag;
    return t ? [t.entryPrice, d ? d.stop : t.stop, d ? d.take : t.take] : [];
  }

  /**
   * Prices autoscale keeps in view: the open trade's entry, stop and take as the engine has
   * them. Not the dragged ones: the scale would move under the pointer and run away with it.
   */
  scalePrices(): number[] {
    const t = this.open();
    return t ? [t.entryPrice, t.stop, t.take] : [];
  }

  /** On the base layer after the drawings; `c` maps this frame. */
  paintBase(ctx: CanvasRenderingContext2D, c: Coords, dpr: number, th: ChartTheme): void {
    this.coords = c;
    const m = this.marks;
    const debug = chartDebug();
    if (debug) {
      debug.replayHandles = null;
      debug.replayClosed = 0;
    }
    if (!m || c.count === 0 || c.plotW <= 0 || c.priceH <= 0) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, c.plotW, c.priceH);
    ctx.clip();
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // The cut: halfway between the last revealed bar and the next one.
    const cut = (c.x(m.time) + c.x(c.addBars(m.time, 1))) / 2;
    ctx.strokeStyle = th.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.moveTo(Math.round(cut) + 0.5, 0);
    ctx.lineTo(Math.round(cut) + 0.5, c.priceH);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    const w = ctx.measureText(m.label).width + 2 * PAD;
    // At the foot of the line, clear of the trade labels at the top.
    tag(ctx, m.label, th.fg, Math.min(cut + GAP, c.plotW - w - 2), c.priceH - LABEL_H / 2 - 6, th);

    for (const t of m.trades) if (t.reason !== "open" && this.paintClosed(ctx, t, c, th) && debug) debug.replayClosed++;
    const open = this.open();
    if (open) this.paintOpen(ctx, open, c, dpr, th);
    ctx.restore();
  }

  /** The start under the mouse while picking: a line on its bar and the bars after it dimmed. */
  paintPick(ctx: CanvasRenderingContext2D, x: number, plotW: number, plotH: number, dpr: number, th: ChartTheme): void {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();
    ctx.fillStyle = th.bg;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x, 0, plotW - x, plotH);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = th.fg;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotH);
    ctx.stroke();
    ctx.restore();
  }

  /** Entry and exit marks joined by a line, and the R at the exit; false when culled. */
  private paintClosed(ctx: CanvasRenderingContext2D, t: ReplayTrade, c: Coords, th: ChartTheme): boolean {
    if (t.exitTime === null || t.exitPrice === null) return false;
    const x0 = c.x(t.entryTime);
    const x1 = c.x(t.exitTime);
    if (x1 < -100 || x0 > c.plotW + 100) return false;
    const y0 = c.y(t.entryPrice);
    const y1 = c.y(t.exitPrice);
    ctx.strokeStyle = th.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    for (const [x, y] of [
      [x0, y0],
      [x1, y1],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x, y, MARK_R, 0, Math.PI * 2);
      ctx.fillStyle = th.fg;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = th.bg;
      ctx.stroke();
    }
    const w = tag(ctx, formatR(t.r), signColor(t.r, th), x1 + MARK_R + GAP, y1, th);
    if (t.ambiguous) tag(ctx, "?", th.fg, x1 + MARK_R + 2 * GAP + w, y1, th);
    return true;
  }

  private paintOpen(ctx: CanvasRenderingContext2D, t: ReplayTrade, c: Coords, dpr: number, th: ChartTheme): void {
    const tool = toolFor("position");
    if (!tool) return;
    const body = this.body(t, c);
    const g = tool.layout(body, c);
    ctx.strokeStyle = th.muted;
    ctx.fillStyle = th.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash(NO_DASH);
    tool.paint(ctx, g, { color: th.muted, width: 1, dash: false, dpr, theme: th });
    ctx.font = FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    // The marked R right of the zone, on the entry line.
    tag(ctx, formatR(t.r), signColor(t.r, th), c.x(body.endT) + GAP, c.y(t.entryPrice), th);
    const mid = (c.x(body.entry.t) + c.x(body.endT)) / 2;
    const debug = chartDebug();
    if (debug) debug.replayHandles = { stop: { x: mid, y: c.y(body.stop) }, take: { x: mid, y: c.y(body.take) } };
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = th.fg;
    ctx.fillStyle = th.bg;
    for (const p of [body.stop, body.take]) {
      ctx.beginPath();
      ctx.arc(mid, c.y(p), HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
