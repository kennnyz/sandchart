import { Minus } from "lucide-react";
import type { DrawingBody } from "../../../backend/types";
import type { ToolDef } from "../registry";

type Hline = Extract<DrawingBody, { kind: "hline" }>;

interface HlineGeom {
  y: number;
  plotW: number;
  path: Path2D | null;
}

/** A level across the whole plot, with its price tagged on the axis. */
export const hlineTool: ToolDef<Hline, HlineGeom> = {
  kind: "hline",
  labelKey: "tools.hline",
  icon: Minus,
  code: "KeyH",
  placement: { clicks: 1 },

  create(points) {
    return { kind: "hline", p: points[0]!.p };
  },

  timeSpan() {
    return [-Infinity, Infinity];
  },

  layout(body, c) {
    return { y: c.y(body.p), plotW: c.plotW, path: null };
  },

  paint(ctx, g, look) {
    if (!g.path) {
      // On a device pixel row (odd widths on its centre), so the line stays sharp.
      const w = Math.round(look.width * look.dpr);
      const y = (Math.round(g.y * look.dpr) + (w % 2 === 1 ? 0.5 : 0)) / look.dpr;
      g.path = new Path2D();
      g.path.moveTo(0, y);
      g.path.lineTo(g.plotW, y);
    }
    ctx.stroke(g.path);
  },

  hitTest(g, x, y, tol) {
    return x >= 0 && x <= g.plotW && Math.abs(y - g.y) <= tol;
  },

  handles(g) {
    return [{ x: g.plotW / 2, y: g.y }];
  },

  moveBy(body, m) {
    return { kind: "hline", p: m.price(body.p) };
  },

  moveHandle(_body, _index, a) {
    return { kind: "hline", p: a.p };
  },

  axisPrices(body) {
    return [body.p];
  },
};
