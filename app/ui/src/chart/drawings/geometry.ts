// Pure geometry for drawings: anchors (time in ms, price in ticks) to CSS px and back,
// distances for hit-testing, line clipping and path simplification. No DOM, no state.

import type { PriceScale } from "../scale";
import { indexToX, xToIndex, type Viewport } from "../viewport";

/** The largest tick value the engine accepts (2^53 - 1). */
export const MAX_TICKS = Number.MAX_SAFE_INTEGER;

/** Largest i with `time[i] <= t`, or -1 when `t` is before the first bar. `count` > 0. */
function barAtOrBefore(time: Float64Array, count: number, t: number): number {
  let lo = 0;
  let hi = count - 1;
  if (t < time[0]!) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Fractional bar index of time `t` over the first `count` bar open times: an integer on a
 * bar's open time, linear between two bars (a gap in the data counts as one bar), and
 * extrapolated by `step` ms before the first and after the last bar. NaN without bars.
 */
export function timeToIndex(time: Float64Array, count: number, step: number, t: number): number {
  if (count <= 0) return NaN;
  const i = barAtOrBefore(time, count, t);
  if (i < 0) return (t - time[0]!) / step;
  if (i === count - 1) return i + (t - time[i]!) / step;
  return i + (t - time[i]!) / (time[i + 1]! - time[i]!);
}

/** The inverse of `timeToIndex`. */
export function indexToTime(time: Float64Array, count: number, step: number, index: number): number {
  if (count <= 0) return NaN;
  if (index <= 0) return time[0]! + index * step;
  const last = count - 1;
  if (index >= last) return time[last]! + (index - last) * step;
  const i = Math.floor(index);
  return time[i]! + (index - i) * (time[i + 1]! - time[i]!);
}

/** Bar prices in ticks, by bar index (the chart's series columns). */
export interface Ohlc {
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
}

/**
 * Anchor space to CSS px of the price plot for one base frame. A new object every frame;
 * `sameLayout` tells whether two frames map anchors alike, so geometry can be kept.
 */
export class Coords {
  /** Open, high, low and close of the last bar when this frame was made. */
  private readonly last: readonly number[] | null;
  /**
   * Set when `prices` hands out the last bar. The layer clears it before a layout to learn
   * whether that geometry depends on the live bar.
   */
  lastBarRead = false;

  constructor(
    private readonly time: Float64Array,
    readonly count: number,
    private readonly view: Viewport,
    private readonly scale: PriceScale,
    readonly plotW: number,
    readonly priceH: number,
    /** Bar duration of the timeframe in ms. */
    readonly step: number,
    /** Price decimals of the instrument, for labels. */
    readonly decimals = 0,
    private readonly ohlc: Ohlc | null = null,
  ) {
    const i = count - 1;
    this.last = ohlc && count > 0 ? [ohlc.open[i]!, ohlc.high[i]!, ohlc.low[i]!, ohlc.close[i]!] : null;
  }

  /**
   * Both frames put every anchor at the same px: the same bar times (the chart grows its
   * arrays in place, so the same array and count), view, price scale, plot and decimals.
   */
  sameLayout(o: Coords): boolean {
    const a = this.scale;
    const b = o.scale;
    return (
      this.time === o.time &&
      this.count === o.count &&
      this.view.barWidth === o.view.barWidth &&
      this.view.rightIndex === o.view.rightIndex &&
      a.min === b.min &&
      a.max === b.max &&
      a.mode === b.mode &&
      a.heightPx === b.heightPx &&
      this.plotW === o.plotW &&
      this.priceH === o.priceH &&
      this.step === o.step &&
      this.decimals === o.decimals
    );
  }

  /** The last bar has the same prices in both frames. */
  sameLastBar(o: Coords): boolean {
    const a = this.last;
    const b = o.last;
    return a === b || (a !== null && b !== null && a.every((v, k) => v === b[k]));
  }

  /** Fractional bar index of time `t` (see `timeToIndex`). */
  index(t: number): number {
    return timeToIndex(this.time, this.count, this.step, t);
  }

  /** Time of a (fractional) bar index (see `indexToTime`). */
  timeAt(index: number): number {
    return indexToTime(this.time, this.count, this.step, index);
  }

  /** Index of the loaded bar whose slot contains `x`, or -1 when there is none. */
  barAt(x: number): number {
    // "+ 0" turns -0 (just left of bar 0) into 0.
    const i = Math.round(xToIndex(this.view, x, this.plotW)) + 0;
    return i >= 0 && i < this.count ? i : -1;
  }

  /** Open, high, low and close of bar `i` in ticks; null without prices or outside the bars. */
  prices(i: number): [number, number, number, number] | null {
    const o = this.ohlc;
    if (!o || !(i >= 0 && i < this.count)) return null;
    if (i === this.count - 1) this.lastBarRead = true;
    return [o.open[i]!, o.high[i]!, o.low[i]!, o.close[i]!];
  }

  x(t: number): number {
    return indexToX(this.view, timeToIndex(this.time, this.count, this.step, t), this.plotW);
  }

  /** Time at `x`, whole ms. */
  t(x: number): number {
    return Math.round(indexToTime(this.time, this.count, this.step, xToIndex(this.view, x, this.plotW)));
  }

  y(p: number): number {
    return this.scale.toY(p);
  }

  /** Price at `y`, whole ticks within ±MAX_TICKS (and at least 1 on a log scale). */
  p(y: number): number {
    const v = Math.round(this.scale.fromY(y));
    return Math.min(MAX_TICKS, Math.max(this.scale.mode === "log" ? 1 : -MAX_TICKS, v));
  }
}

/** Distance from (px, py) to the segment a-b. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return distToLine(px, py, ax, ay, bx, by, false, false);
}

/**
 * Distance from (px, py) to the line through a and b, cut at a unless `extendA` and
 * at b unless `extendB`: a segment, a ray or a full line.
 */
export function distToLine(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  extendA: boolean,
  extendB: boolean,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let u = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (!extendA && u < 0) u = 0;
  if (!extendB && u > 1) u = 1;
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/** Distance from (px, py) to the nearest edge of the rectangle with corners a and b. */
export function distToRect(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const l = Math.min(ax, bx);
  const r = Math.max(ax, bx);
  const t = Math.min(ay, by);
  const b = Math.max(ay, by);
  return Math.min(
    distToSegment(px, py, l, t, r, t),
    distToSegment(px, py, r, t, r, b),
    distToSegment(px, py, r, b, l, b),
    distToSegment(px, py, l, b, l, t),
  );
}

export function insideRect(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
}

/**
 * The part of the line a-b (extended past a and/or b by the flags) inside the box
 * [0, w] x [0, h], as [x0, y0, x1, y1]; null when none of it is inside, or when an
 * extended line has no direction (a = b). Liang–Barsky.
 */
export function clipLine(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  extendA: boolean,
  extendB: boolean,
  w: number,
  h: number,
): [number, number, number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0 && (extendA || extendB)) return null;
  let t0 = extendA ? -Infinity : 0;
  let t1 = extendB ? Infinity : 1;
  const edges: [number, number][] = [
    [-dx, ax],
    [dx, w - ax],
    [-dy, ay],
    [dy, h - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/**
 * Indices of the points of the path (xs[i], ys[i]) that Douglas–Peucker keeps with
 * tolerance `epsilon` px, ascending; always the first and the last. Iterative.
 */
export function douglasPeucker(xs: ArrayLike<number>, ys: ArrayLike<number>, epsilon: number): number[] {
  const n = xs.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    let worst = -1;
    let worstD = epsilon;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(xs[i]!, ys[i]!, xs[first]!, ys[first]!, xs[last]!, ys[last]!);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(first, worst, worst, last);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Douglas–Peucker indices of the path with tolerance `epsilon` px, doubled until at
 * most `limit` points are left (`limit` >= 2).
 */
export function simplifyToLimit(xs: ArrayLike<number>, ys: ArrayLike<number>, limit: number, epsilon = 1): number[] {
  let kept = douglasPeucker(xs, ys, epsilon);
  while (kept.length > limit) {
    epsilon *= 2;
    kept = douglasPeucker(xs, ys, epsilon);
  }
  return kept;
}
