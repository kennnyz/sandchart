import type { Anchor } from "../../backend/types";
import type { Coords } from "./geometry";

/** How close (CSS px, vertically) a price of the bar must be for the magnet to take it. */
export const MAGNET_RADIUS = 8;
/** With ⌘ (Ctrl) held: how far above the high or below the low (CSS px) a point still snaps. */
export const STRONG_RADIUS = 40;

/**
 * The anchor a point at (x, y) snaps to: the open time and the open, high, low or close
 * of the bar under x, whichever is nearest on screen. The magnet takes it within
 * `MAGNET_RADIUS`; `strong` (⌘ held) anywhere between the bar's high and low and up to
 * `STRONG_RADIUS` past them. Null when no bar price is that close.
 */
export function snapToBar(c: Coords, x: number, y: number, strong = false): Anchor | null {
  const i = c.barAt(x);
  const prices = c.prices(i);
  if (!prices) return null;
  let best = prices[0];
  let bestD = Infinity;
  for (const p of prices) {
    const d = Math.abs(c.y(p) - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  const inside = strong && y >= c.y(prices[1]) && y <= c.y(prices[2]);
  return bestD <= (strong ? STRONG_RADIUS : MAGNET_RADIUS) || inside ? { t: c.timeAt(i), p: best } : null;
}
