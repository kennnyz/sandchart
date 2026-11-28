import { RectangleHorizontal } from "lucide-react";
import type { Anchor, DrawingBody } from "../../../backend/types";
import type { ToolDef } from "../registry";

type Rect = Extract<DrawingBody, { kind: "rect" }>;

/** Fill opacity of a zone, relative to its line. */
export const RECT_FILL_ALPHA = 0.15;

interface RectGeom {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** The box on screen; `right` is the plot edge when the zone runs on to the right. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  extend: boolean;
  path: Path2D | null;
}

const same = (a: Anchor, b: Anchor) => a.t === b.t && a.p === b.p;

/** A zone between two corners, filled lightly in its colour; it can run on to the right edge. */
export const rectTool: ToolDef<Rect, RectGeom> = {
  id: "rect",
  kind: "rect",
  labelKey: "tools.rect",
  icon: RectangleHorizontal,
  code: "KeyB",
  placement: { clicks: 2 },

  create(points) {
    const a = points[0]!;
    const b = points[1] ?? a;
    return { kind: "rect", a: { ...a }, b: { ...b }, extendRight: false };
  },

  timeSpan(body) {
    return [Math.min(body.a.t, body.b.t), body.extendRight ? Infinity : Math.max(body.a.t, body.b.t)];
  },

  layout(body, c) {
    const ax = c.x(body.a.t);
    const ay = c.y(body.a.p);
    const bx = c.x(body.b.t);
    const by = c.y(body.b.p);
    const right = Math.max(ax, bx);
    return {
      ax,
      ay,
      bx,
      by,
      left: Math.min(ax, bx),
      right: body.extendRight ? Math.max(right, c.plotW) : right,
      top: Math.min(ay, by),
      bottom: Math.max(ay, by),
      extend: body.extendRight,
      path: null,
    };
  },

  paint(ctx, g) {
    if (!g.path) {
      g.path = new Path2D();
      // An extended zone has no right edge.
      g.path.moveTo(g.right, g.top);
      g.path.lineTo(g.left, g.top);
      g.path.lineTo(g.left, g.bottom);
      g.path.lineTo(g.right, g.bottom);
      if (!g.extend) g.path.closePath();
    }
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * RECT_FILL_ALPHA;
    ctx.fillRect(g.left, g.top, g.right - g.left, g.bottom - g.top);
    ctx.globalAlpha = alpha;
    ctx.stroke(g.path);
  },

  hitTest(g, x, y, tol) {
    return x >= g.left - tol && x <= g.right + tol && y >= g.top - tol && y <= g.bottom + tol;
  },

  /** Corners: a, (b time, a price), b, (a time, b price). */
  handles(g) {
    return [
      { x: g.ax, y: g.ay },
      { x: g.bx, y: g.ay },
      { x: g.bx, y: g.by },
      { x: g.ax, y: g.by },
    ];
  },

  moveBy(body, m) {
    return { ...body, a: m.anchor(body.a), b: m.anchor(body.b) };
  },

  moveHandle(body, index, at) {
    const { a, b } = body;
    const [na, nb]: [Anchor, Anchor] =
      index === 0
        ? [{ t: at.t, p: at.p }, b]
        : index === 1
          ? [{ t: a.t, p: at.p }, { t: at.t, p: b.p }]
          : index === 2
            ? [a, { t: at.t, p: at.p }]
            : [{ t: at.t, p: a.p }, { t: b.t, p: at.p }];
    if (same(na, nb)) return body;
    return { ...body, a: na, b: nb };
  },
};
