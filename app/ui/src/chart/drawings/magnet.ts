import type { Anchor } from "../../backend/types";
import type { Coords } from "./geometry";

/** How close (CSS px, vertically) a price of the bar must be for the magnet to take it. */
export const MAGNET_RADIUS = 8;

/**
 * The anchor the magnet puts a point at (x, y) on: the open time and the open, high, low
 * or close of the bar under x, whichever is nearest on screen within `MAGNET_RADIUS`.
 * Null when no bar price is that close.
 */
export function snapToBar(c: Coords, x: number, y: number): Anchor | null {
  const i = c.barAt(x);
  const prices = c.prices(i);
  if (!prices) return null;
  let best: number | null = null;
  let bestD = MAGNET_RADIUS;
  for (const p of prices) {
    const d = Math.abs(c.y(p) - y);
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return best === null ? null : { t: c.timeAt(i), p: best };
}
