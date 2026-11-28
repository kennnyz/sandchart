import type { Alert, Instrument } from "../backend/types";
import { chartDebug } from "./debug";
import type { Coords } from "./drawings/geometry";
import type { ChartTheme } from "./theme";

/** An active price alert's level, in ticks at the chart instrument's price scale. */
export interface AlertLevel {
  id: string;
  price: number;
}

/** How close to a level line (CSS px) a press selects its alert. */
const HIT_PX = 4;
const DASH = [2, 3];
const NO_DASH: number[] = [];
/** The bell tag left of the price axis: its size and the glyph's, in CSS px. */
const TAG = 14;
const GLYPH = 10;
/** Lucide `bell` (ISC), on its 24 px grid. */
const BELL = ["M10.268 21a2 2 0 0 0 3.464 0", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"];

/** `p` ticks at `from` decimals as ticks at `to`, rounded half away from zero; null past the safe range. */
function rescale(p: number, from: number, to: number): number | null {
  const v = to >= from ? p * 10 ** (to - from) : Math.sign(p) * Math.round(Math.abs(p) / 10 ** (from - to));
  return Number.isSafeInteger(v) ? v : null;
}

/** The levels to draw: active price alerts of `inst` (line alerts have their line, fired ones nothing to watch). */
export function alertLevels(alerts: readonly Alert[], inst: Instrument | null): AlertLevel[] {
  if (!inst) return [];
  return alerts.flatMap((a) => {
    if (!a.active || a.kind.kind !== "price") return [];
    if (a.instrument.source !== inst.id.source || a.instrument.symbol !== inst.id.symbol) return [];
    const price = rescale(a.kind.price, a.priceScale, inst.priceScale);
    return price === null ? [] : [{ id: a.id, price }];
  });
}

/** The alert whose line is closest to `py` within a few pixels, if any. */
export function levelAt(levels: readonly AlertLevel[], y: (p: number) => number, py: number): string | null {
  let best: string | null = null;
  let bestD = HIT_PX + 0.5;
  for (const l of levels) {
    const d = Math.abs(y(l.price) - py);
    if (d < bestD) {
      bestD = d;
      best = l.id;
    }
  }
  return best;
}

/**
 * Active price alerts of the chart's pair, painted on the base layer: a thin dashed line
 * in the muted colour with a bell tag at the price axis. Pointer moves only hit-test the
 * last painted frame, so they never redraw the base.
 */
export class AlertLevelLayer {
  private alerts: readonly Alert[] = [];
  private levels: AlertLevel[] = [];
  private coords: Coords | null = null;
  private bell: Path2D | null = null;

  /** Every alert; only the active price alerts of the painted pair are drawn. */
  set(alerts: readonly Alert[]): void {
    this.alerts = alerts;
  }

  paintBase(ctx: CanvasRenderingContext2D, c: Coords, dpr: number, th: ChartTheme, inst: Instrument | null): void {
    this.coords = c;
    this.levels = c.count > 0 && c.plotW > 0 && c.priceH > 0 ? alertLevels(this.alerts, inst) : [];
    const debug = chartDebug();
    if (debug) debug.alertLevels = [];
    if (this.levels.length === 0) return;
    this.bell ??= new Path2D(BELL.join(" "));
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(0, 0, c.plotW, c.priceH);
    ctx.clip();
    ctx.strokeStyle = th.muted;
    ctx.lineWidth = 1 / dpr;
    ctx.setLineDash(DASH);
    for (const l of this.levels) {
      const y = c.y(l.price);
      if (!(y >= 0 && y <= c.priceH)) continue;
      const py = (Math.round(y * dpr) + 0.5) / dpr;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(c.plotW - TAG, py);
      ctx.stroke();
      debug?.alertLevels.push({ id: l.id, y });
    }
    ctx.setLineDash(NO_DASH);
    // The bell tags, against the price axis.
    const s = GLYPH / 24;
    for (const l of this.levels) {
      const y = c.y(l.price);
      if (!(y >= 0 && y <= c.priceH)) continue;
      const left = c.plotW - TAG;
      ctx.fillStyle = th.muted;
      ctx.fillRect(left, Math.round(y - TAG / 2), TAG, TAG);
      ctx.save();
      ctx.translate(left + (TAG - GLYPH) / 2, Math.round(y - TAG / 2) + (TAG - GLYPH) / 2);
      ctx.scale(s, s);
      ctx.strokeStyle = th.bg;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(this.bell);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Prices of the drawn levels, for their labels on the price axis. */
  axisPrices(): number[] {
    return this.levels.map((l) => l.price);
  }

  /** The alert whose line or tag is under (x, y) on the price plot of the last frame. */
  hit(x: number, y: number): string | null {
    const c = this.coords;
    if (!c || x < 0 || x >= c.plotW || y < 0 || y >= c.priceH) return null;
    return levelAt(this.levels, (p) => c.y(p), y);
  }
}
