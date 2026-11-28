import type { ChartTheme } from "../theme";

/**
 * An opaque pill in the chart ground behind a drawing's text, so the text stays readable
 * over candles and grid. The caller sets the text colour afterwards.
 */
export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, theme: ChartTheme): void {
  const r = Math.min(h / 2, w / 2, 4);
  ctx.fillStyle = theme.bg;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}
