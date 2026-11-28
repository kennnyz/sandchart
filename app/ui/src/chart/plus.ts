import type { ChartTheme } from "./theme";

/** Radius in CSS px of the round "+" at the left edge of the crosshair price label. */
export const PLUS_R = 8;
/** Lucide `circle-plus` (ISC), on its 24 px grid. */
const CIRCLE_PLUS = "M8 12h8 M12 8v8";

/** Centre x of the "+" on a price plot `plotW` wide: just left of the price axis. */
export function plusX(plotW: number): number {
  return plotW - PLUS_R - 2;
}

/** Whether (x, y) is on the "+" drawn at the crosshair row `cy` of a price plot `plotW` by `priceH`. */
export function onPlus(plotW: number, priceH: number, x: number, y: number, cy: number): boolean {
  if (plotW <= 2 * PLUS_R + 2 || !(cy >= 0 && cy < priceH) || x >= plotW) return false;
  return Math.hypot(x - plusX(plotW), y - cy) <= PLUS_R + 0.5;
}

let glyph: Path2D | null = null;

/** Paints the "+" on the overlay at row `cy` (CSS px); `hot` while the mouse is on it. */
export function paintPlus(ctx: CanvasRenderingContext2D, plotW: number, cy: number, dpr: number, hot: boolean, th: ChartTheme): void {
  const cx = plusX(plotW);
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.beginPath();
  ctx.arc(cx, cy, PLUS_R, 0, 2 * Math.PI);
  ctx.fillStyle = hot ? th.fg : th.crosshairLabelBg;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = th.muted;
  ctx.stroke();
  glyph ??= new Path2D(CIRCLE_PLUS);
  const s = (2 * PLUS_R) / 24;
  ctx.translate(cx - PLUS_R, cy - PLUS_R);
  ctx.scale(s, s);
  ctx.strokeStyle = hot ? th.bg : th.fg;
  ctx.lineWidth = 2.25;
  ctx.lineCap = "round";
  ctx.stroke(glyph);
  ctx.restore();
}

/** An item of the menu the "+" opens: `realTime` when it is off because the replay caught up. */
export interface PriceMenuEntry {
  id: "alert" | "hline" | "buy" | "sell";
  disabled?: true;
  realTime?: true;
}

/**
 * The items of the "+" menu: an alert and a horizontal line on the live chart; in a replay
 * (whose prices are from the past) Buy and Sell at the current close instead of the alert,
 * off while a trade is open or once the backtest reached real time.
 */
export function priceMenuEntries(replay: { finished: boolean; hasOpen: boolean } | null): PriceMenuEntry[] {
  if (!replay) return [{ id: "alert" }, { id: "hline" }];
  const off = (id: "buy" | "sell"): PriceMenuEntry =>
    replay.finished ? { id, disabled: true, realTime: true } : replay.hasOpen ? { id, disabled: true } : { id };
  return [off("buy"), off("sell"), { id: "hline" }];
}
