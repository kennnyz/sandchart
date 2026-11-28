import { Rows3 } from "lucide-react";
import type { DrawingBody } from "../../../backend/types";
import { formatPrice } from "../../format";
import { MONO_FAMILY } from "../../theme";
import type { ToolDef } from "../registry";

type Fib = Extract<DrawingBody, { kind: "fib" }>;

/** Retracement levels 0..1 and two extensions; a new drawing stores this list. */
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
const LABEL_FONT = `11px ${MONO_FAMILY}`;

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
  path: Path2D | null;
}

/** Fibonacci levels of a move, from its start to its end, each a line between the two times. */
export const fibTool: ToolDef<Fib, FibGeom> = {
  id: "fib",
  kind: "fib",
  labelKey: "tools.fib",
  icon: Rows3,
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
      path: null,
    };
  },

  paint(ctx, g) {
    if (!g.path) {
      g.path = new Path2D();
      for (const y of g.ys) {
        g.path.moveTo(g.left, y);
        g.path.lineTo(g.right, y);
      }
    }
    ctx.stroke(g.path);
    ctx.font = LABEL_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const x = Math.max(g.left, 0) + 4;
    for (let i = 0; i < g.ys.length; i++) ctx.fillText(g.labels[i]!, x, g.ys[i]! - 2);
  },

  hitTest(g, x, y, tol) {
    if (x < g.left - tol || x > g.right + tol) return false;
    return g.ys.some((ly) => Math.abs(y - ly) <= tol);
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
