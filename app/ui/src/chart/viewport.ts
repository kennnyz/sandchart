/** `rightIndex` is the (fractional) bar index at the right edge; it may exceed the last bar. */
export interface Viewport {
  barWidth: number;
  rightIndex: number;
}

export const MIN_BAR_WIDTH = 1;
export const MAX_BAR_WIDTH = 60;

export function indexToX(v: Viewport, index: number, widthPx: number): number {
  return widthPx - (v.rightIndex - index) * v.barWidth;
}

export function xToIndex(v: Viewport, x: number, widthPx: number): number {
  return v.rightIndex - (widthPx - x) / v.barWidth;
}

/** Scales the bar width by `factor`; the index under `anchorX` stays under it. */
export function zoomAt(v: Viewport, anchorX: number, widthPx: number, factor: number): Viewport {
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(MIN_BAR_WIDTH, v.barWidth * factor));
  const anchorIndex = xToIndex(v, anchorX, widthPx);
  return { barWidth, rightIndex: anchorIndex + (widthPx - anchorX) / barWidth };
}

/** Drag by `dxPx`: dragging right (positive) reveals older bars. */
export function panBy(v: Viewport, dxPx: number): Viewport {
  return { barWidth: v.barWidth, rightIndex: v.rightIndex - dxPx / v.barWidth };
}

/** Inclusive integer bar range on screen, clamped to [0, count - 1]; `[0, -1]` when empty. */
export function visibleRange(v: Viewport, widthPx: number, count: number): [number, number] {
  if (count <= 0) return [0, -1];
  const first = Math.floor(xToIndex(v, 0, widthPx));
  const last = Math.ceil(xToIndex(v, widthPx, widthPx));
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  return [clamp(first), clamp(last)];
}

/**
 * Zoom factor between two successive `scale` values of a WebKit gesture event (macOS
 * trackpad pinch in WKWebView). `scale` is cumulative since `gesturestart`, so the
 * step is their ratio; an unusable value gives 1 (no zoom).
 */
export function gestureZoomFactor(prevScale: number, scale: number): number {
  if (!Number.isFinite(prevScale) || !Number.isFinite(scale) || prevScale <= 0 || scale <= 0) return 1;
  return scale / prevScale;
}
