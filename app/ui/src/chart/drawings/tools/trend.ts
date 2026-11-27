import { Slash } from "lucide-react";
import type { DrawingBody } from "../../../backend/types";
import { clipLine, distToLine } from "../geometry";
import type { ToolDef } from "../registry";

type Trend = Extract<DrawingBody, { kind: "trend" }>;

interface TrendGeom {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Whether the line runs on past a, and past b. */
  extA: boolean;
  extB: boolean;
  /** The visible part inside the price plot; null when none of it is visible. */
  seg: [number, number, number, number] | null;
  path: Path2D | null;
}

/** Extend flags of the ends: "left" and "right" are on screen, a is left when it is earlier. */
function ends(body: Trend): { extA: boolean; extB: boolean } {
  const aLeft = body.a.t <= body.b.t;
  return aLeft
    ? { extA: body.extendLeft, extB: body.extendRight }
    : { extA: body.extendRight, extB: body.extendLeft };
}

/** A segment between two points; extended to a ray or a line by its extend flags. */
export const trendTool: ToolDef<Trend, TrendGeom> = {
  kind: "trend",
  labelKey: "tools.trend",
  icon: Slash,
  code: "KeyT",
  placement: { clicks: 2 },

  create(points) {
    const a = points[0]!;
    const b = points[1] ?? a;
    return { kind: "trend", a: { ...a }, b: { ...b }, extendLeft: false, extendRight: false };
  },

  timeSpan(body) {
    const lo = Math.min(body.a.t, body.b.t);
    const hi = Math.max(body.a.t, body.b.t);
    return [body.extendLeft ? -Infinity : lo, body.extendRight ? Infinity : hi];
  },

  layout(body, c) {
    const ax = c.x(body.a.t);
    const ay = c.y(body.a.p);
    const bx = c.x(body.b.t);
    const by = c.y(body.b.p);
    const { extA, extB } = ends(body);
    return { ax, ay, bx, by, extA, extB, seg: clipLine(ax, ay, bx, by, extA, extB, c.plotW, c.priceH), path: null };
  },

  paint(ctx, g) {
    if (!g.seg) return;
    if (!g.path) {
      g.path = new Path2D();
      g.path.moveTo(g.seg[0], g.seg[1]);
      g.path.lineTo(g.seg[2], g.seg[3]);
    }
    ctx.stroke(g.path);
  },

  hitTest(g, x, y, tol) {
    return g.seg !== null && distToLine(x, y, g.ax, g.ay, g.bx, g.by, g.extA, g.extB) <= tol;
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
