import { TrendingDown, TrendingUp } from "lucide-react";
import type { Anchor, DrawingBody, PositionOutcome, Side } from "../../../backend/types";
import { t } from "../../../i18n";
import { formatChange } from "../../format";
import { MONO_FAMILY, type ChartTheme } from "../../theme";
import { MAX_TICKS } from "../geometry";
import type { ToolDef } from "../registry";

type Position = Extract<DrawingBody, { kind: "position" }>;

/** A new position risks this share of the entry price... */
export const DEFAULT_STOP = 0.015;
/** ...for this many times the risk... */
export const DEFAULT_RR = 3;
/** ...and runs for this many bars. */
export const DEFAULT_BARS = 20;

const MINUS = "−";
const LABEL_FONT = `11px ${MONO_FAMILY}`;
const LABEL_H = 18;
const PAD = 5;
const GAP = 4;
const MARKER_R = 4;

const clampTicks = (p: number) => Math.min(MAX_TICKS, Math.max(-MAX_TICKS, p));

/** Long: stop < entry < take; short: take < entry < stop; the end is after the entry (the engine's rules). */
export function validPosition(b: Position): boolean {
  const p = b.entry.p;
  const ordered = b.side === "long" ? b.stop < p && p < b.take : b.take < p && p < b.stop;
  return ordered && b.endT > b.entry.t && [p, b.stop, b.take].every((v) => Math.abs(v) <= MAX_TICKS);
}

/** A new position at `entry`: the stop `DEFAULT_STOP` against it, the take at `DEFAULT_RR` R, `DEFAULT_BARS` bars of `step` ms long. */
export function defaultPosition(side: Side, entry: Anchor, step: number): Position {
  const risk = Math.max(1, Math.round(Math.abs(entry.p) * DEFAULT_STOP));
  const dir = side === "long" ? 1 : -1;
  return {
    kind: "position",
    side,
    entry: { t: entry.t, p: entry.p },
    stop: clampTicks(entry.p - dir * risk),
    take: clampTicks(entry.p + dir * DEFAULT_RR * risk),
    endT: entry.t + DEFAULT_BARS * step,
  };
}

/** The label numbers: take and stop as a share of the entry ("+4.50%", "−1.50%") and reward over risk ("3.0"). */
export function positionStats(b: Position): { take: string; stop: string; rr: string } {
  const base = Math.abs(b.entry.p);
  const reward = Math.abs(b.take - b.entry.p);
  const risk = Math.abs(b.entry.p - b.stop);
  return {
    take: formatChange(reward, base, 0).pct,
    stop: formatChange(-risk, base, 0).pct,
    rr: risk > 0 ? (reward / risk).toFixed(1) : "",
  };
}

interface OutcomeGeom {
  status: PositionOutcome["status"];
  /** "+3.0R" on a take, "−1.0R" on a stop, null while open. */
  r: string | null;
  /** The exit bar's mark on the take or stop line; x is null while open. */
  x: number | null;
  y: number;
  ambiguous: boolean;
}

interface PositionGeom {
  side: Side;
  left: number;
  right: number;
  yEntry: number;
  yStop: number;
  yTake: number;
  plotW: number;
  priceH: number;
  stats: { take: string; stop: string; rr: string };
  outcome: OutcomeGeom | null;
}

/** Text in pieces, each with its own colour, on a label box; `y` is the box's top. */
function label(ctx: CanvasRenderingContext2D, parts: [string, string][], cx: number, y: number, g: PositionGeom, th: ChartTheme): void {
  const widths = parts.map(([s]) => ctx.measureText(s).width);
  const w = widths.reduce((a, b) => a + b, 0) + 2 * PAD;
  const x = Math.min(Math.max(cx - w / 2, 2), Math.max(2, g.plotW - w - 2));
  const top = Math.min(Math.max(y, 2), Math.max(2, g.priceH - LABEL_H - 2));
  ctx.fillStyle = th.crosshairLabelBg;
  ctx.fillRect(x, top, w, LABEL_H);
  let at = x + PAD;
  parts.forEach(([s, col], i) => {
    ctx.fillStyle = col;
    ctx.fillText(s, at, top + LABEL_H / 2);
    at += widths[i]!;
  });
}

function positionTool(side: Side): ToolDef<Position, PositionGeom> {
  return {
    id: side,
    kind: "position",
    labelKey: side === "long" ? "tools.long" : "tools.short",
    icon: side === "long" ? TrendingUp : TrendingDown,
    code: side === "long" ? "KeyL" : "KeyS",
    placement: { clicks: 1 },

    create(points, c) {
      return defaultPosition(side, points[0]!, c.step);
    },

    timeSpan(body) {
      return [body.entry.t, body.endT];
    },

    layout(body, c, outcome) {
      const yStop = c.y(body.stop);
      const yTake = c.y(body.take);
      const yEntry = c.y(body.entry.p);
      let out: OutcomeGeom | null = null;
      if (outcome) {
        const hit = outcome.status !== "open" && outcome.exitTime !== null;
        out = {
          status: outcome.status,
          r:
            outcome.status === "take"
              ? `+${outcome.r.toFixed(1)}R`
              : outcome.status === "stop"
                ? `${MINUS}${Math.abs(outcome.r).toFixed(1)}R`
                : null,
          x: hit ? c.x(outcome.exitTime!) : null,
          y: outcome.status === "take" ? yTake : outcome.status === "stop" ? yStop : yEntry,
          ambiguous: outcome.ambiguous,
        };
      }
      return {
        side: body.side,
        left: c.x(body.entry.t),
        right: c.x(body.endT),
        yEntry,
        yStop,
        yTake,
        plotW: c.plotW,
        priceH: c.priceH,
        stats: positionStats(body),
        outcome: out,
      };
    },

    paint(ctx, g, look) {
      const th = look.theme;
      const w = g.right - g.left;
      const alpha = ctx.globalAlpha;
      ctx.fillStyle = th.positionProfit;
      ctx.fillRect(g.left, Math.min(g.yTake, g.yEntry), w, Math.abs(g.yTake - g.yEntry));
      ctx.fillStyle = th.positionRisk;
      ctx.fillRect(g.left, Math.min(g.yStop, g.yEntry), w, Math.abs(g.yStop - g.yEntry));
      ctx.beginPath();
      ctx.moveTo(g.left, g.yEntry);
      ctx.lineTo(g.right, g.yEntry);
      ctx.stroke();

      // Labels outside the zones: the take's beyond the take edge, the stop's beyond the stop edge.
      ctx.font = LABEL_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const cx = (g.left + g.right) / 2;
      const takeUp = g.yTake < g.yEntry;
      const take: [string, string][] = [
        [`${t("position.take")} `, th.fg],
        [g.stats.take, th.up],
        [` · ${t("position.rr")} `, th.fg],
        [g.stats.rr, th.up],
      ];
      const stop: [string, string][] = [
        [`${t("position.stop")} `, th.fg],
        [g.stats.stop, th.down],
      ];
      label(ctx, take, cx, takeUp ? g.yTake - GAP - LABEL_H : g.yTake + GAP, g, th);
      label(ctx, stop, cx, takeUp ? g.yStop + GAP : g.yStop - GAP - LABEL_H, g, th);

      const o = g.outcome;
      if (o) {
        // The badge right of the zone on the entry line; only its R number is coloured.
        const word = t(`position.${o.status}`);
        const badge: [string, string][] = o.r
          ? [
              [`${word} `, th.fg],
              [o.r, o.status === "take" ? th.up : th.down],
            ]
          : [[word, th.fg]];
        const bw = badge.reduce((s, [txt]) => s + ctx.measureText(txt).width, 0) + 2 * PAD;
        label(ctx, badge, g.right + GAP + bw / 2, g.yEntry - LABEL_H / 2, g, th);
        if (o.x !== null) {
          ctx.beginPath();
          ctx.arc(o.x, o.y, MARKER_R, 0, Math.PI * 2);
          ctx.fillStyle = look.color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = th.bg;
          ctx.stroke();
          if (o.ambiguous) {
            ctx.fillStyle = th.fg;
            ctx.fillText("?", o.x + MARKER_R + 3, o.y);
          }
        }
      }
      ctx.globalAlpha = alpha;
    },

    hitTest(g, x, y, tol) {
      const top = Math.min(g.yTake, g.yStop);
      const bottom = Math.max(g.yTake, g.yStop);
      return x >= g.left - tol && x <= g.right + tol && y >= top - tol && y <= bottom + tol;
    },

    /** Stop edge, take edge (in the middle), entry (left) and end (right, on the entry line). */
    handles(g) {
      const mid = (g.left + g.right) / 2;
      return [
        { x: mid, y: g.yStop },
        { x: mid, y: g.yTake },
        { x: g.left, y: g.yEntry },
        { x: g.right, y: g.yEntry },
      ];
    },

    moveBy(body, m) {
      const entry = m.anchor(body.entry);
      const next: Position = {
        ...body,
        entry,
        stop: m.price(body.stop),
        take: m.price(body.take),
        endT: m.anchor({ t: body.endT, p: body.entry.p }).t,
      };
      return validPosition(next) ? next : body;
    },

    moveHandle(body, index, a) {
      const e = body.entry.p;
      const long = body.side === "long";
      let next: Position;
      if (index === 0) {
        next = { ...body, stop: long ? Math.min(a.p, e - 1) : Math.max(a.p, e + 1) };
      } else if (index === 1) {
        next = { ...body, take: long ? Math.max(a.p, e + 1) : Math.min(a.p, e - 1) };
      } else if (index === 2) {
        const lo = Math.min(body.stop, body.take) + 1;
        const hi = Math.max(body.stop, body.take) - 1;
        if (lo > hi) return body;
        next = { ...body, entry: { t: body.entry.t, p: Math.min(hi, Math.max(lo, a.p)) } };
      } else {
        next = { ...body, endT: Math.max(a.t, body.entry.t + 1) };
      }
      return validPosition(next) ? next : body;
    },

    axisPrices(body) {
      return [body.entry.p, body.stop, body.take];
    },
  };
}

/** A long position: click the entry, then drag the stop, the take and the end. */
export const longTool = positionTool("long");
/** A short position, the mirror of the long. */
export const shortTool = positionTool("short");
