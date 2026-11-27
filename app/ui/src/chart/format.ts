import type { TimeframeCode } from "../backend/types";

const THIN_SPACE = " ";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Exact decimal rendering of an integer tick count; no floating division. */
export function formatPrice(ticks: number, scale: number): string {
  const negative = ticks < 0;
  const digits = String(Math.abs(ticks)).padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  const grouped = intPart.replace(/\B(?=(\d{3})+$)/g, THIN_SPACE);
  return (negative ? "-" : "") + grouped + (scale > 0 ? "." + frac : "");
}

const DAILY_AND_UP: ReadonlySet<string> = new Set(["1d", "3d", "1w", "1M"]);

/** Axis label for a bar at `ms` (UTC); coarser units appear when they change from `prevMs`. */
export function formatTimeLabel(ms: number, tf: TimeframeCode, prevMs: number | null): string {
  const d = new Date(ms);
  const prev = prevMs === null ? null : new Date(prevMs);
  if (prev && d.getUTCFullYear() !== prev.getUTCFullYear()) return String(d.getUTCFullYear());
  const month = MONTHS[d.getUTCMonth()] ?? "";
  const monthChanged = prev !== null && d.getUTCMonth() !== prev.getUTCMonth();
  if (DAILY_AND_UP.has(tf)) {
    if (tf === "1M" || monthChanged) return month;
    return String(d.getUTCDate());
  }
  const dayChanged = prev !== null && (monthChanged || d.getUTCDate() !== prev.getUTCDate());
  if (dayChanged) return `${d.getUTCDate()} ${month}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
