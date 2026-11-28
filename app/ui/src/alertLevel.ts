// The level of an alert at a time, as `sandchart_core::alert::Level` has it (ADR 0007). The engine
// decides when an alert fires; the UI uses this only to show a line alert's level now, and the
// browser mock to fire alerts. `backend/mockAlerts.test.ts` runs it against
// `crates/core/tests/fixtures/alerts.json`, the cases the Rust tests run, so the two cannot drift.

import type { Anchor, DrawingBody } from "./backend/types";

/** The level an alert compares the price with (`Level` in Rust). */
export type Level =
  | { kind: "flat"; p: number }
  | { kind: "line"; a: Anchor; b: Anchor; extendLeft: boolean; extendRight: boolean };

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** `n / d` rounded half away from zero; `d > 0`. */
function divRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  const abs = r < 0n ? -r : r;
  return abs * 2n >= d ? q + (n < 0n ? -1n : 1n) : q;
}

export function levelOf(body: DrawingBody): Level | null {
  if (body.kind === "hline") return { kind: "flat", p: body.p };
  if (body.kind === "trend") return { kind: "line", a: body.a, b: body.b, extendLeft: body.extendLeft, extendRight: body.extendRight };
  return null;
}

/** The level at time `t`; null off the line (as `Level::at`). */
export function levelAt(level: Level, t: number): number | null {
  if (level.kind === "flat") return level.p;
  const [first, last] = level.a.t <= level.b.t ? [level.a, level.b] : [level.b, level.a];
  if (first.t === last.t || (t < first.t && !level.extendLeft) || (t > last.t && !level.extendRight)) return null;
  const p = BigInt(first.p) + divRound(BigInt(last.p - first.p) * (BigInt(t) - BigInt(first.t)), BigInt(last.t) - BigInt(first.t));
  return p > MAX || p < -MAX ? null : Number(p);
}

