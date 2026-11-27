import type { ComputedIndicator, IndicatorMeta, SeriesSpec } from "../backend/types";

/** One indicator instance as the chart draws it. */
export interface IndicatorLayer {
  instance: string;
  meta: IndicatorMeta;
  /** Palette slot per series id; a missing id uses the spec's `color`. */
  colors: Record<string, number>;
  /** Null while the first compute is pending or after an error. */
  computed: ComputedIndicator | null;
  error: string | null;
  repaints: boolean;
}

/** Own pane height in CSS px; own panes never take more than this share of the plot. */
export const OWN_PANE_HEIGHT = 120;
const OWN_PANES_MAX_SHARE = 0.6;

/**
 * Index in the chart series of the bar with `time === firstTime` (binary search over
 * the first `count` times, ascending), null when there is none. Value `k` of an
 * indicator series sits at chart index `offset + k`.
 */
export function alignOffset(seriesTime: Float64Array, count: number, firstTime: number): number | null {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = seriesTime[mid]!;
    if (t === firstTime) return mid;
    if (t < firstTime) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** Own panes stacked under the price plot, tops relative to the plot top. */
export function layoutPanes(plotH: number, ownCount: number): { priceH: number; panes: { top: number; height: number }[] } {
  const h = Math.max(0, plotH);
  if (ownCount <= 0) return { priceH: h, panes: [] };
  const height =
    OWN_PANE_HEIGHT * ownCount > OWN_PANES_MAX_SHARE * h
      ? Math.floor((OWN_PANES_MAX_SHARE * h) / ownCount)
      : OWN_PANE_HEIGHT;
  const priceH = h - height * ownCount;
  const panes: { top: number; height: number }[] = [];
  for (let i = 0; i < ownCount; i++) panes.push({ top: priceH + i * height, height });
  return { priceH, panes };
}

/** True when the layer has anything to draw in an own pane (so it gets one). */
export function hasOwnPane(layer: IndicatorLayer): boolean {
  return layer.error === null && layer.meta.series.some((s) => s.pane === "own");
}

/** The `values` of series `id`, or null when it has none (markers, band, missing). */
export function seriesValues(c: ComputedIndicator, id: string): Float64Array | null {
  for (const s of c.series) {
    if (s.id === id) return "values" in s.data && s.data.values.length > 0 ? s.data.values : null;
  }
  return null;
}

/** Min and max of the finite values at chart bars `first..last`, folded into `acc`. */
function foldRange(values: Float64Array, offset: number, first: number, last: number, acc: [number, number]): void {
  const from = Math.max(0, first - offset);
  const to = Math.min(values.length - 1, last - offset);
  for (let k = from; k <= to; k++) {
    const v = values[k]!;
    // NaN fails both comparisons; ±Infinity is filtered explicitly.
    if (v - v !== 0) continue;
    if (v < acc[0]) acc[0] = v;
    if (v > acc[1]) acc[1] = v;
  }
}

function drawable(layer: IndicatorLayer, offset: number | null): layer is IndicatorLayer & { computed: ComputedIndicator } {
  return layer.error === null && layer.computed !== null && offset !== null;
}

/**
 * Min and max in price ticks (value × `priceScale10`, which is `10 ** priceScale`) of the
 * finite `line` values on `pane: price` at chart bars `first..last`; null when none.
 */
export function overlayRange(
  layers: IndicatorLayer[],
  offsets: (number | null)[],
  first: number,
  last: number,
  priceScale10: number,
): [number, number] | null {
  const acc: [number, number] = [Infinity, -Infinity];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const offset = offsets[i] ?? null;
    if (!drawable(layer, offset)) continue;
    for (const spec of layer.meta.series) {
      if (spec.kind !== "line" || spec.pane !== "price") continue;
      const v = seriesValues(layer.computed, spec.id);
      if (v) foldRange(v, offset!, first, last, acc);
    }
  }
  if (acc[0] > acc[1]) return null;
  return [acc[0] * priceScale10, acc[1] * priceScale10];
}

/** Min and max of the finite values of the layer's own-pane series (histograms include 0). */
export function paneRange(layer: IndicatorLayer, offset: number, first: number, last: number): [number, number] | null {
  if (layer.error !== null || layer.computed === null) return null;
  const acc: [number, number] = [Infinity, -Infinity];
  let histogram = false;
  for (const spec of layer.meta.series) {
    if (spec.pane !== "own" || !hasValues(spec)) continue;
    const v = seriesValues(layer.computed, spec.id);
    if (!v) continue;
    foldRange(v, offset, first, last, acc);
    if (spec.kind === "histogram") histogram = true;
  }
  if (acc[0] > acc[1]) return null;
  if (histogram) return [Math.min(0, acc[0]), Math.max(0, acc[1])];
  return acc;
}

function hasValues(spec: SeriesSpec): boolean {
  return spec.kind === "line" || spec.kind === "histogram";
}
