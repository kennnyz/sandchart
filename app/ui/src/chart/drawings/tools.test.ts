import { describe, expect, it } from "vitest";
import type { Anchor, DrawingBody } from "../../backend/types";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import { TOOLS, toolFor, type Mover } from "./registry";

const H = 3_600_000;
const times = new Float64Array(Array.from({ length: 100 }, (_, i) => i * H));
// 100 hourly bars, 10 px each, the last at x = 1000; prices 0..1000 ticks over 1000 px.
const c = new Coords(times, 100, { barWidth: 10, rightIndex: 99 }, new PriceScale(0, 1000, 1000, "linear"), 1000, 1000, H);
const at = (x: number, y: number): Anchor => ({ t: c.t(x), p: c.p(y) });

/** Moves by (dx, dy) px, as the chart's body drag does. */
const mover = (dx: number, dy: number): Mover => ({
  anchor: (a) => ({ t: c.t(c.x(a.t) + dx), p: c.p(c.y(a.p) + dy) }),
  price: (p) => c.p(c.y(p) + dy),
});

describe("registry", () => {
  it("lists trend and hline with distinct shortcuts and i18n keys", () => {
    expect(TOOLS.map((t) => t.kind)).toEqual(["trend", "hline"]);
    expect(new Set(TOOLS.map((t) => t.code)).size).toBe(TOOLS.length);
    expect(toolFor("trend")?.code).toBe("KeyT");
    expect(toolFor("hline")?.code).toBe("KeyH");
    expect(toolFor("rect")).toBeUndefined();
  });
});

describe("hline", () => {
  const tool = toolFor("hline")!;

  it("is placed with one click at the click's price", () => {
    expect(tool.placement.clicks).toBe(1);
    expect(tool.create([at(500, 300)], c)).toEqual({ kind: "hline", p: 700 });
    expect(tool.timeSpan({ kind: "hline", p: 700 })).toEqual([-Infinity, Infinity]);
    expect(tool.axisPrices!({ kind: "hline", p: 700 })).toEqual([700]);
  });

  it("is hit along the whole width, within the tolerance", () => {
    const g = tool.layout({ kind: "hline", p: 700 }, c);
    expect(tool.hitTest(g, 5, 303, 6)).toBe(true);
    expect(tool.hitTest(g, 995, 297, 6)).toBe(true);
    expect(tool.hitTest(g, 500, 310, 6)).toBe(false);
    expect(tool.handles(g)).toEqual([{ x: 500, y: 300 }]);
  });

  it("moves by price only", () => {
    const body: DrawingBody = { kind: "hline", p: 700 };
    expect(tool.moveBy(body, mover(40, 50))).toEqual({ kind: "hline", p: 650 });
    expect(tool.moveHandle(body, 0, at(10, 100), false)).toEqual({ kind: "hline", p: 900 });
  });
});

describe("trend", () => {
  const tool = toolFor("trend")!;
  const body = (extendLeft = false, extendRight = false): DrawingBody => ({
    kind: "trend",
    a: at(500, 500),
    b: at(600, 400),
    extendLeft,
    extendRight,
  });

  it("is placed with two clicks", () => {
    expect(tool.placement.clicks).toBe(2);
    expect(tool.create([at(500, 500), at(600, 400)], c)).toEqual(body());
    // The preview before the second point is a zero-length line.
    const one = tool.create([at(500, 500)], c);
    expect(one).toMatchObject({ kind: "trend", a: at(500, 500), b: at(500, 500) });
  });

  it("spans its anchors, or to the edge on an extended side", () => {
    const a = c.t(500);
    const b = c.t(600);
    expect(tool.timeSpan(body())).toEqual([a, b]);
    expect(tool.timeSpan(body(true, false))).toEqual([-Infinity, b]);
    expect(tool.timeSpan(body(false, true))).toEqual([a, Infinity]);
    // Extending means left and right on screen, whichever anchor comes first.
    const reversed: DrawingBody = { kind: "trend", a: at(600, 400), b: at(500, 500), extendLeft: false, extendRight: true };
    expect(tool.timeSpan(reversed)).toEqual([a, Infinity]);
    const g = tool.layout(reversed, c);
    expect(tool.hitTest(g, 700, 300, 6)).toBe(true);
    expect(tool.hitTest(g, 400, 600, 6)).toBe(false);
  });

  it("is hit near the segment, and past it only where extended", () => {
    const g = tool.layout(body(), c);
    expect(tool.hitTest(g, 550, 452, 6)).toBe(true);
    expect(tool.hitTest(g, 550, 460, 6)).toBe(false);
    expect(tool.hitTest(g, 700, 300, 6)).toBe(false);
    const right = tool.layout(body(false, true), c);
    expect(tool.hitTest(right, 700, 300, 6)).toBe(true);
    expect(tool.hitTest(right, 400, 600, 6)).toBe(false);
    const left = tool.layout(body(true, false), c);
    expect(tool.hitTest(left, 400, 600, 6)).toBe(true);
    expect(tool.handles(g)).toEqual([
      { x: 500, y: 500 },
      { x: 600, y: 400 },
    ]);
  });

  it("is not hit or painted when it lies outside the plot", () => {
    const off: DrawingBody = { kind: "trend", a: at(1200, 500), b: at(1300, 400), extendLeft: false, extendRight: false };
    expect(tool.hitTest(tool.layout(off, c), 1250, 450, 6)).toBe(false);
  });

  it("moves both anchors with the body", () => {
    const moved = tool.moveBy(body(), mover(30, -20)) as Extract<DrawingBody, { kind: "trend" }>;
    expect(moved.a).toEqual(at(530, 480));
    expect(moved.b).toEqual(at(630, 380));
    expect(moved.extendLeft).toBe(false);
  });

  it("moves one end with a handle; Shift makes it horizontal", () => {
    const b = body() as Extract<DrawingBody, { kind: "trend" }>;
    expect(tool.moveHandle(b, 1, at(700, 350), false)).toEqual({ ...b, b: at(700, 350) });
    expect(tool.moveHandle(b, 1, at(700, 350), true)).toEqual({ ...b, b: { t: c.t(700), p: b.a.p } });
    expect(tool.moveHandle(b, 0, at(450, 520), true)).toEqual({ ...b, a: { t: c.t(450), p: b.b.p } });
    // Onto the other end: that would be no line at all, so nothing changes.
    expect(tool.moveHandle(b, 0, b.b, false)).toBe(b);
  });
});
