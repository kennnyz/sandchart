import type { TimeframeCode } from "./backend/types";

// Binance bucket boundaries, as `Timeframe` in sandchart_core (ADR 0008). The browser mock
// uses them too, and mockReplay.test.ts checks them against the Rust fixture.

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
/** 1970-01-01 was a Thursday; weeks start on the Monday four days later. */
const MONDAY = 4 * DAY;
/** Fixed length in ms; null for the calendar month. */
export const FIXED_MS: Record<TimeframeCode, number | null> = {
  "1m": MINUTE,
  "3m": 3 * MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "1h": 60 * MINUTE,
  "2h": 120 * MINUTE,
  "4h": 240 * MINUTE,
  "6h": 360 * MINUTE,
  "8h": 480 * MINUTE,
  "12h": 720 * MINUTE,
  "1d": DAY,
  "3d": 3 * DAY,
  "1w": 7 * DAY,
  "1M": null,
};

const floorTo = (t: number, step: number, offset = 0) => Math.floor((t - offset) / step) * step + offset;

/** `Timeframe::bucket_start`: epoch-aligned fixed lengths, Monday weeks, calendar months (UTC). */
export function bucketStart(tf: TimeframeCode, t: number): number {
  const ms = FIXED_MS[tf];
  if (ms !== null) return floorTo(t, ms, tf === "1w" ? MONDAY : 0);
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** `Timeframe::close_time`: the open time plus the length, or the next calendar month for 1M. */
export function closeTime(tf: TimeframeCode, openTime: number): number {
  const ms = FIXED_MS[tf];
  if (ms !== null) return openTime + ms;
  const d = new Date(openTime);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** `Timeframe::builds_from`: every bucket boundary of `tf` is one of `base`; never 3d from a lower one. */
export function buildsFrom(tf: TimeframeCode, base: TimeframeCode): boolean {
  if (tf === base) return true;
  if (tf === "3d") return false;
  const b = FIXED_MS[base];
  if (b === null) return false;
  const ms = FIXED_MS[tf];
  if (ms === null) return DAY % b === 0;
  return ms > b && ms % b === 0 && (tf === "1w" ? MONDAY : 0) % b === 0;
}
