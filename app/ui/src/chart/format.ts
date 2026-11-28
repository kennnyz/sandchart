import type { TimeframeCode } from "../backend/types";

const THIN_SPACE = "\u2009";
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

/** Full UTC date of a bar for the crosshair label: `27 Nov 2026 14:05`, no time from 1d up. */
export function formatCrosshairTime(ms: number, tf: TimeframeCode): string {
  const d = new Date(ms);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
  if (DAILY_AND_UP.has(tf)) return date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * A UTC time typed as `YYYY-MM-DD`, optionally followed by `HH:MM` (after a space or a T), in
 * ms; null unless it is a real calendar date and time. The same digits in every language.
 */
export function parseUtcDateTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0] = m.slice(1).map((v) => (v === undefined ? undefined : Number(v))) as number[];
  if (h! > 23 || mi! > 59) return null;
  const ms = Date.UTC(y!, mo! - 1, d!, h, mi);
  const back = new Date(ms);
  // Date.UTC rolls 31 November over into December: only a date that comes back the same is real.
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo! - 1 && back.getUTCDate() === d ? ms : null;
}

const MINUS = "−";

function signOf(n: number): string {
  return n > 0 ? "+" : n < 0 ? MINUS : "";
}

/**
 * Change from `base` to `base + diff` (ticks): absolute and in percent, both with the
 * sign of `diff`, so a change too small for the percentage still reads "+0.00%".
 */
export function formatChange(
  diff: number,
  base: number,
  scale: number,
): { abs: string; pct: string; dir: -1 | 0 | 1 } {
  const sign = signOf(diff);
  // Basis points of `base`, rounded: an integer, so formatPrice gives exactly 2 decimals.
  const bp = base !== 0 ? Math.abs(Math.round((diff * 10_000) / base)) : 0;
  return {
    abs: sign + formatPrice(Math.abs(diff), scale),
    pct: sign + formatPrice(bp, 2) + "%",
    dir: diff > 0 ? 1 : diff < 0 ? -1 : 0,
  };
}

/** Basis points as a signed percentage: 184 -> "+1.84%". */
export function formatBp(bp: number): string {
  return signOf(bp) + formatPrice(Math.abs(Math.round(bp)), 2) + "%";
}

/** UTC wall time of `ms`: "HH:MM" on the UTC day of `now`, "D Mon HH:MM" before it. */
export function formatUtcClock(ms: number, now: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10)) return clock;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${clock}`;
}

/** Date of a bar for labels: "27 Nov 2026" (UTC). */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCFullYear()}`;
}

/**
 * An indicator value (a float in price units) with `decimals` places, the integer part
 * grouped like prices and a real minus sign. Display only: the value is already a float.
 */
export function formatValue(v: number, decimals: number): string {
  const s = Math.abs(v).toFixed(decimals);
  const dot = s.indexOf(".");
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const grouped = intPart.replace(/\B(?=(\d{3})+$)/g, THIN_SPACE) + (dot < 0 ? "" : s.slice(dot));
  return (v < 0 && Number(s) !== 0 ? MINUS : "") + grouped;
}
