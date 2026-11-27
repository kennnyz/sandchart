// The ruler: a measurement on the overlay between two points, never stored.

import type { Anchor } from "../../backend/types";
import { t } from "../../i18n";
import { formatChange } from "../format";
import { MONO_FAMILY, type ChartTheme } from "../theme";
import type { Coords } from "./geometry";

const MINUS = "−";
const LABEL_FONT = `11px ${MONO_FAMILY}`;
const LINE_H = 16;
const PAD = 6;
const BOX_ALPHA = 0.12;

/** "3d 4h", "2h 15m", "45m": the two largest of days, hours and minutes, whole minutes. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const unit = (n: number, u: "d" | "h" | "m") => t(`ruler.${u}`, { n });
  const parts =
    d > 0 ? [unit(d, "d"), h > 0 ? unit(h, "h") : ""] : h > 0 ? [unit(h, "h"), m > 0 ? unit(m, "m") : ""] : [unit(m, "m")];
  return (ms < 0 && minutes > 0 ? MINUS : "") + parts.filter(Boolean).join(" ");
}

export interface Measure {
  /** Price change from a to b and its percentage of a, signed. */
  abs: string;
  pct: string;
  dir: -1 | 0 | 1;
  /** Bars from the bar of a to the bar of b, and the time between their opens. */
  bars: number;
  duration: string;
}

export function measure(a: Anchor, b: Anchor, c: Coords): Measure {
  const ia = Math.round(c.index(a.t));
  const ib = Math.round(c.index(b.t));
  const change = formatChange(b.p - a.p, a.p, c.decimals);
  return { ...change, bars: ib - ia, duration: formatDuration(c.timeAt(ib) - c.timeAt(ia)) };
}

/**
 * Paints the ruler from a to b in CSS px (the caller has set the transform and the clip):
 * a light box between the points, the line a-b, and a label with the numbers beside b.
 * Only the price numbers are coloured, by their sign. Returns the label's two lines joined by "|".
 */
export function paintRuler(ctx: CanvasRenderingContext2D, c: Coords, a: Anchor, b: Anchor, theme: ChartTheme): string {
  const ax = c.x(a.t);
  const ay = c.y(a.p);
  const bx = c.x(b.t);
  const by = c.y(b.p);
  ctx.globalAlpha = BOX_ALPHA;
  ctx.fillStyle = theme.muted;
  ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();

  const m = measure(a, b, c);
  const line1 = `${m.abs} (${m.pct})`;
  const line2 = `${t("ruler.bars", { n: m.bars })}, ${m.duration}`;
  ctx.font = LABEL_FONT;
  const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 2 * PAD;
  const h = 2 * LINE_H + PAD;
  // Past b on the side away from a, kept inside the plot.
  const x = Math.min(Math.max((ax + bx) / 2 - w / 2, 2), Math.max(2, c.plotW - w - 2));
  const below = by >= ay;
  const y = Math.min(Math.max(below ? by + 8 : by - 8 - h, 2), Math.max(2, c.priceH - h - 2));
  ctx.fillStyle = theme.crosshairLabelBg;
  ctx.fillRect(x, y, w, h);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = m.dir > 0 ? theme.up : m.dir < 0 ? theme.down : theme.fg;
  ctx.fillText(line1, x + PAD, y + PAD / 2 + LINE_H / 2);
  ctx.fillStyle = theme.fg;
  ctx.fillText(line2, x + PAD, y + PAD / 2 + LINE_H * 1.5);
  return `${line1}|${line2}`;
}
