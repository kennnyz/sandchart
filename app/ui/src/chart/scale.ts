export type PriceScaleMode = "linear" | "log";

/** Maps prices (as tick counts) to pixel rows; y = 0 is the top (max price). */
export class PriceScale {
  private readonly lo: number;
  private readonly hi: number;

  constructor(
    readonly min: number,
    readonly max: number,
    readonly heightPx: number,
    readonly mode: PriceScaleMode,
  ) {
    this.lo = this.forward(min);
    this.hi = this.forward(max);
  }

  private forward(p: number): number {
    return this.mode === "log" ? Math.log(p) : p;
  }

  private inverse(v: number): number {
    return this.mode === "log" ? Math.exp(v) : v;
  }

  toY(price: number): number {
    const span = this.hi - this.lo;
    if (span === 0) return this.heightPx / 2;
    return ((this.hi - this.forward(price)) / span) * this.heightPx;
  }

  fromY(y: number): number {
    const span = this.hi - this.lo;
    return this.inverse(this.hi - (y / this.heightPx) * span);
  }

  /** At most `maxCount` round price levels inside [min, max], ascending. */
  ticks(maxCount: number): number[] {
    if (maxCount < 1 || !(this.max > this.min)) return [];
    return this.mode === "log" ? logTicks(this.min, this.max, maxCount) : linearTicks(this.min, this.max, maxCount);
  }
}

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

function clean(v: number): number {
  return Number(v.toPrecision(12));
}

function linearTicks(min: number, max: number, maxCount: number): number[] {
  const step = niceStep((max - min) / maxCount);
  const out: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max; k++) out.push(clean(k * step));
  return out;
}

function logTicks(min: number, max: number, maxCount: number): number[] {
  if (min <= 0) return linearTicks(min, max, maxCount);
  const firstDecade = Math.floor(Math.log10(min));
  const lastDecade = Math.floor(Math.log10(max));
  for (const mantissas of [[1, 2, 5], [1]]) {
    const out: number[] = [];
    for (let d = firstDecade; d <= lastDecade; d++) {
      for (const m of mantissas) {
        const v = clean(m * 10 ** d);
        if (v >= min && v <= max) out.push(v);
      }
    }
    if (out.length <= maxCount) return out;
  }
  // Too many decades: keep every n-th power of ten.
  const stride = Math.ceil((lastDecade - firstDecade + 1) / maxCount);
  const out: number[] = [];
  for (let d = firstDecade; d <= lastDecade; d += stride) {
    const v = clean(10 ** d);
    if (v >= min && v <= max) out.push(v);
  }
  return out;
}

/** Price range covering bars `range` (inclusive indices) plus `padding` of the span on both sides. */
export function autoscale(
  lows: Float64Array | number[],
  highs: Float64Array | number[],
  range: [number, number],
  padding = 0.08,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = range[0]; i <= range[1]; i++) {
    const lo = lows[i];
    const hi = highs[i];
    if (lo !== undefined && lo < min) min = lo;
    if (hi !== undefined && hi > max) max = hi;
  }
  if (min > max) return [0, 1];
  const span = max - min;
  const pad = span > 0 ? span * padding : Math.max(1, Math.abs(max) * 0.01);
  return [min - pad, max + pad];
}
