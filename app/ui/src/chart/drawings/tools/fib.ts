import { FibonacciIcon } from "../../../icons";
import type { DrawingBody } from "../../../backend/types";
import { formatPrice } from "../../format";
import { MONO_FAMILY } from "../../theme";
import { pill } from "../label";
import type { ToolDef } from "../registry";

type Fib = Extract<DrawingBody, { kind: "fib" }>;

/** Retracement levels 0..1 and two extensions; a new drawing stores this list. */
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
const LABEL_FONT = `11px ${MONO_FAMILY}`;
/** Label pill: height, inner padding, gap above its level line. */
const LABEL_H = 15;
const LABEL_PAD = 4;
const LABEL_GAP = 2;

/** Price of `level` in ticks: 0 at the end of the move (b), 1 at its start (a). */
export function fibPrice(body: Fib, level: number): number {
  return Math.round(body.b.p + (body.a.p - body.b.p) * level);
}

interface FibGeom {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  left: number;
  right: number;
  /** y of each level and its label, "0.618  1 234.50". */
  ys: number[];
  labels: string[];
  /** Label widths in px, measured on the first paint. */
  widths: number[] | null;
  path: Path2D | null;
}

/** Fibonacci levels of a move, from its start to its end, each a line between the two times. */
export const fibTool: ToolDef<Fib, FibGeom> = {
  id: "fib",
  kind: "fib",
  labelKey: "tools.fib",
  icon: FibonacciIcon,
  code: "KeyF",
  placement: { clicks: 2 },

  create(points) {
    const a = points[0]!;
    const b = points[1] ?? a;
    return { kind: "fib", a: { ...a }, b: { ...b }, levels: [...FIB_LEVELS] };
  },

  timeSpan(body) {
    return [Math.min(body.a.t, body.b.t), Math.max(body.a.t, body.b.t)];
  },

  layout(body, c) {
    const ax = c.x(body.a.t);
    const bx = c.x(body.b.t);
    // Levels are prices first, then pixels: right on a log scale too.
    const prices = body.levels.map((l) => fibPrice(body, l));
    return {
      ax,
      ay: c.y(body.a.p),
      bx,
      by: c.y(body.b.p),
      left: Math.min(ax, bx),
      right: Math.max(ax, bx),
      ys: prices.map((p) => c.y(p)),
      labels: body.levels.map((l, i) => `${l}  ${formatPrice(prices[i]!, c.decimals)}`),
      widths: null,
      path: null,
    };
  },

  paint(ctx, g, look) {
    if (!g.path) {
      g.path = new Path2D();
      for (const y of g.ys) {
        g.path.moveTo(g.left, y);
        g.path.lineTo(g.right, y);
      }
    }
    ctx.stroke(g.path);
    // Each label on a pill in the chart ground just above its line, readable over candles.
    ctx.font = LABEL_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    g.widths ??= g.labels.map((s) => ctx.measureText(s).width);
    const x = Math.max(g.left, 0) + 4;
    for (let i = 0; i < g.ys.length; i++) {
      const top = g.ys[i]! - LABEL_GAP - LABEL_H;
      pill(ctx, x, top, g.widths[i]! + 2 * LABEL_PAD, LABEL_H, look.theme);
      ctx.fillStyle = look.color;
      ctx.fillText(g.labels[i]!, x + LABEL_PAD, top + LABEL_H / 2);
    }
  },

  hitTest(g, x, y, tol) {
    if (x < g.left - tol || x > g.right + tol) return false;
    return g.ys.some((ly) => Math.abs(y - ly) <= tol);
  },

  touches(g, box) {
    return g.left <= box.right && g.right >= box.left && g.ys.some((y) => y >= box.top && y <= box.bottom);
  },

  handles(g) {
    return [
      { x: g.ax, y: g.ay },
      { x: g.bx, y: g.by },
    ];
  },

  moveBy(body, m) {
    return { ...body, a: m.anchor(body.a), b: m.anchor(body.b) };
  },

  moveHandle(body, index, a, horizontal) {
    const other = index === 0 ? body.b : body.a;
    const moved = { t: a.t, p: horizontal ? other.p : a.p };
    if (moved.t === other.t && moved.p === other.p) return body;
    return index === 0 ? { ...body, a: moved } : { ...body, b: moved };
  },
};
