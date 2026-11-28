import { PencilLine } from "lucide-react";
import type { DrawingBody } from "../../../backend/types";
import { boxesOverlap, distToSegment, lineTouchesBox, simplifyToLimit } from "../geometry";
import type { ToolDef } from "../registry";

type BrushBody = Extract<DrawingBody, { kind: "brush" }>;

/** Most points a stroke keeps (the engine's limit). */
export const MAX_BRUSH_POINTS = 500;
/** Douglas–Peucker tolerance in CSS px a stroke starts with. */
const SIMPLIFY_PX = 1;

interface BrushGeom {
  xs: Float64Array;
  ys: Float64Array;
  left: number;
  right: number;
  top: number;
  bottom: number;
  path: Path2D | null;
}

/** A free-hand stroke: press, drag and release. The tool stays picked until Esc. */
export const brushTool: ToolDef<BrushBody, BrushGeom> = {
  id: "brush",
  kind: "brush",
  labelKey: "tools.brush",
  icon: PencilLine,
  code: "KeyP",
  placement: { clicks: 2, stroke: true },
  sticky: true,

  /** The pointer's path, simplified on screen to at most `MAX_BRUSH_POINTS`. */
  create(points, c) {
    if (points.length < 2) {
      const a = points[0]!;
      return { kind: "brush", points: [{ ...a }, { ...a }] };
    }
    const xs = points.map((a) => c.x(a.t));
    const ys = points.map((a) => c.y(a.p));
    const kept = simplifyToLimit(xs, ys, MAX_BRUSH_POINTS, SIMPLIFY_PX);
    return { kind: "brush", points: kept.map((i) => ({ ...points[i]! })) };
  },

  timeSpan(body) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of body.points) {
      if (a.t < lo) lo = a.t;
      if (a.t > hi) hi = a.t;
    }
    return [lo, hi];
  },

  layout(body, c) {
    const n = body.points.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = c.x(body.points[i]!.t);
      const y = c.y(body.points[i]!.p);
      xs[i] = x;
      ys[i] = y;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return { xs, ys, left, right, top, bottom, path: null };
  },

  paint(ctx, g) {
    if (!g.path) {
      g.path = new Path2D();
      g.path.moveTo(g.xs[0]!, g.ys[0]!);
      for (let i = 1; i < g.xs.length; i++) g.path.lineTo(g.xs[i]!, g.ys[i]!);
    }
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(g.path);
    ctx.restore();
  },

  hitTest(g, x, y, tol) {
    if (x < g.left - tol || x > g.right + tol || y < g.top - tol || y > g.bottom + tol) return false;
    for (let i = 1; i < g.xs.length; i++) {
      if (distToSegment(x, y, g.xs[i - 1]!, g.ys[i - 1]!, g.xs[i]!, g.ys[i]!) <= tol) return true;
    }
    return false;
  },

  touches(g, box) {
    if (!boxesOverlap(g.left, g.top, g.right, g.bottom, box)) return false;
    for (let i = 1; i < g.xs.length; i++) {
      if (lineTouchesBox(g.xs[i - 1]!, g.ys[i - 1]!, g.xs[i]!, g.ys[i]!, false, false, box)) return true;
    }
    return false;
  },

  /** No reshaping: a stroke only moves. */
  handles() {
    return [];
  },

  /** Its two ends. */
  markers(g) {
    const n = g.xs.length - 1;
    return [
      { x: g.xs[0]!, y: g.ys[0]! },
      { x: g.xs[n]!, y: g.ys[n]! },
    ];
  },

  moveBy(body, m) {
    return { kind: "brush", points: body.points.map((a) => m.anchor(a)) };
  },

  moveHandle(body) {
    return body;
  },
};
