// TEST-ONLY CODE. The real rule is `sandchart_core::alert` in Rust (ADR 0007); this copy
// lets the browser mock and the e2e tests fire alerts. `mockAlerts.test.ts` runs it against
// `crates/core/tests/fixtures/alerts.json`, the cases the Rust tests run, so the two cannot drift.

import { levelAt as mockLevelAt, type Level as MockLevel } from "../alertLevel";
import type { AlertDirection, AlertInput } from "./types";

// The level rule is shared with the UI, which shows a line alert's level now (the fixture runs it here too).
export { levelAt as mockLevelAt, levelOf as mockLevelOf, type Level as MockLevel } from "../alertLevel";

/** One live update: when it arrived, its bar, and that bar's high, low and close so far. */
export interface MockUpdate {
  t: number;
  openTime: number;
  high: number;
  low: number;
  close: number;
}

/** The price an alert fired at between `prev` and `cur`, or null (as `fires`). */
export function mockFires(
  direction: AlertDirection,
  level: MockLevel,
  prev: MockUpdate,
  cur: MockUpdate,
  sameStream: boolean,
): number | null {
  let lo: number;
  let hi: number;
  if (!sameStream) {
    lo = hi = cur.close;
  } else if (cur.openTime === prev.openTime) {
    lo = cur.low < prev.low ? cur.low : cur.close;
    hi = cur.high > prev.high ? cur.high : cur.close;
  } else if (cur.openTime > prev.openTime) {
    lo = cur.low;
    hi = cur.high;
  } else {
    return null;
  }
  const was = mockLevelAt(level, prev.t);
  const now = mockLevelAt(level, cur.t);
  if (was === null || now === null) return null;
  const up = prev.close < was && hi >= now;
  const down = prev.close > was && lo <= now;
  if (up && direction !== "below") return Math.max(cur.close, now);
  if (down && direction !== "above") return Math.min(cur.close, now);
  return null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The message Rust's `validate` gives, or null. */
export function mockValidateAlert(a: Pick<AlertInput, "id" | "kind">): string | null {
  if (!ID.test(a.id)) return "an alert id must be 1 to 64 characters from A-Z, a-z, 0-9, _ and -";
  if (a.kind.kind === "price") {
    return Number.isSafeInteger(a.kind.price) ? null : `alert price ${a.kind.price} is outside ±(2^53 - 1)`;
  }
  return ID.test(a.kind.drawingId) ? null : "a drawing id must be 1 to 64 characters from A-Z, a-z, 0-9, _ and -";
}
