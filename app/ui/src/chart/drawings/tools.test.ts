import { describe, expect, it } from "vitest";
import type { Anchor, DrawingBody } from "../../backend/types";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import { FIB_LEVELS, fibPrice } from "./tools/fib";
import { MAX_BRUSH_POINTS } from "./tools/brush";
import { mover as screenMover } from "./layer";
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
  it("lists the tools with distinct shortcuts and i18n keys", () => {
    expect(TOOLS.map((t) => t.id)).toEqual(["trend", "hline", "rect", "fib", "long", "short", "brush", "note"]);
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.labelKey)).size).toBe(TOOLS.length);
    expect(new Set(TOOLS.map((t) => t.code)).size).toBe(TOOLS.length);
    expect(toolFor("trend")?.code).toBe("KeyT");
    expect(toolFor("hline")?.code).toBe("KeyH");
    expect(TOOLS.map((t) => t.code)).toEqual(["KeyT", "KeyH", "KeyB", "KeyF", "KeyL", "KeyS", "KeyP", "KeyN"]);
    // Only the brush stays picked after a placement.
    expect(TOOLS.filter((t) => t.sticky).map((t) => t.kind)).toEqual(["brush"]);
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
    // The ends, then the middle, which moves the whole line.
    expect(tool.handles(g)).toEqual([
      { x: 500, y: 500 },
      { x: 600, y: 400 },
      { x: 550, y: 450 },
    ]);
    expect(tool.grip).toBe(2);
  });

  it("touches a selection box it crosses, also where it is only extended", () => {
    const g = tool.layout(body(), c);
    expect(tool.touches(g, { left: 540, top: 440, right: 560, bottom: 460 })).toBe(true);
    // The box sits on the line's path, but past its end.
    expect(tool.touches(g, { left: 690, top: 290, right: 710, bottom: 310 })).toBe(false);
    expect(tool.touches(tool.layout(body(false, true), c), { left: 690, top: 290, right: 710, bottom: 310 })).toBe(true);
    // Inside the line's bounds but beside it.
    expect(tool.touches(g, { left: 505, top: 405, right: 540, bottom: 440 })).toBe(false);
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

type Rect = Extract<DrawingBody, { kind: "rect" }>;
type Fib = Extract<DrawingBody, { kind: "fib" }>;
type BrushBody = Extract<DrawingBody, { kind: "brush" }>;

describe("rect", () => {
  const tool = toolFor("rect")!;
  const body = (extendRight = false): Rect => ({ kind: "rect", a: at(400, 600), b: at(600, 400), extendRight });

  it("is placed with two corners", () => {
    expect(tool.placement).toEqual({ clicks: 2 });
    expect(tool.create([at(400, 600), at(600, 400)], c)).toEqual(body());
    expect(tool.timeSpan(body())).toEqual([c.t(400), c.t(600)]);
    expect(tool.timeSpan(body(true))).toEqual([c.t(400), Infinity]);
  });

  it("is hit on its edges and inside, and runs to the right edge when extended", () => {
    const g = tool.layout(body(), c);
    expect(tool.hitTest(g, 500, 500, 6)).toBe(true);
    expect(tool.hitTest(g, 395, 500, 6)).toBe(true);
    expect(tool.hitTest(g, 500, 610, 6)).toBe(false);
    expect(tool.hitTest(g, 800, 500, 6)).toBe(false);
    expect(tool.hitTest(tool.layout(body(true), c), 990, 500, 6)).toBe(true);
  });

  it("has a handle on every corner and in the middle of every edge", () => {
    expect(tool.handles(tool.layout(body(), c))).toEqual([
      { x: 400, y: 600 },
      { x: 600, y: 600 },
      { x: 600, y: 400 },
      { x: 400, y: 400 },
      // Edges: a's price, b's time, b's price, a's time.
      { x: 500, y: 600 },
      { x: 600, y: 500 },
      { x: 500, y: 400 },
      { x: 400, y: 500 },
    ]);
  });

  it("resizes only one side with an edge handle", () => {
    const b = body();
    // Moving along the edge does nothing; only the side under the handle follows.
    expect(tool.moveHandle(b, 4, at(470, 650), false)).toEqual({ ...b, a: at(400, 650) });
    expect(tool.moveHandle(b, 5, at(700, 450), false)).toEqual({ ...b, b: at(700, 400) });
    expect(tool.moveHandle(b, 6, at(520, 300), false)).toEqual({ ...b, b: at(600, 300) });
    expect(tool.moveHandle(b, 7, at(350, 550), false)).toEqual({ ...b, a: at(350, 600) });
    // An edge may meet the opposite one (a flat zone is still a zone), but not both corners.
    const flat: Rect = { kind: "rect", a: at(400, 500), b: at(600, 500), extendRight: false };
    expect(tool.moveHandle(flat, 5, at(400, 500), false)).toBe(flat);
  });

  it("touches a selection box that overlaps it", () => {
    const g = tool.layout(body(), c);
    expect(tool.touches(g, { left: 590, top: 590, right: 700, bottom: 700 })).toBe(true);
    expect(tool.touches(g, { left: 450, top: 450, right: 460, bottom: 460 })).toBe(true);
    expect(tool.touches(g, { left: 610, top: 300, right: 700, bottom: 700 })).toBe(false);
  });

  it("moves both corners with the body", () => {
    expect(tool.moveBy(body(), mover(30, -20))).toEqual({ ...body(), a: at(430, 580), b: at(630, 380) });
  });

  it("moves the anchors that make up a dragged corner", () => {
    const b = body();
    expect(tool.moveHandle(b, 0, at(350, 650), false)).toEqual({ ...b, a: at(350, 650) });
    // Corner 1 is b's time and a's price.
    expect(tool.moveHandle(b, 1, at(700, 650), false)).toEqual({ ...b, a: at(400, 650), b: at(700, 400) });
    expect(tool.moveHandle(b, 2, at(700, 300), false)).toEqual({ ...b, b: at(700, 300) });
    // Corner 3 is a's time and b's price.
    expect(tool.moveHandle(b, 3, at(350, 300), false)).toEqual({ ...b, a: at(350, 600), b: at(600, 300) });
    // Corner 0 onto corner 2: no zone at all, nothing changes.
    expect(tool.moveHandle(b, 0, b.b, false)).toBe(b);
  });
});

describe("fib", () => {
  const tool = toolFor("fib")!;
  // A move up from 400 to 800 ticks, from x = 300 to x = 700.
  const body: Fib = { kind: "fib", a: at(300, 600), b: at(700, 200), levels: [...FIB_LEVELS] };

  it("is placed from the start to the end of the move with the default levels", () => {
    expect(tool.placement).toEqual({ clicks: 2 });
    expect(tool.create([at(300, 600), at(700, 200)], c)).toEqual(body);
    expect(FIB_LEVELS).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618]);
    expect(tool.timeSpan(body)).toEqual([c.t(300), c.t(700)]);
  });

  it("puts level 0 at the end, 1 at the start and the extensions past the start", () => {
    expect(fibPrice(body, 0)).toBe(800);
    expect(fibPrice(body, 1)).toBe(400);
    expect(fibPrice(body, 0.5)).toBe(600);
    expect(fibPrice(body, 0.618)).toBe(553);
    expect(fibPrice(body, 1.618)).toBe(153);
  });

  it("lays the levels out as prices, so a log scale keeps them right", () => {
    const log = new Coords(times, 100, { barWidth: 10, rightIndex: 99 }, new PriceScale(10_000, 1_000_000, 1000, "log"), 1000, 1000, H, 2);
    const b: Fib = { kind: "fib", a: { t: c.t(300), p: 1000 }, b: { t: c.t(700), p: 3000 }, levels: [0.5] };
    const g = tool.layout(b, log) as unknown as { ys: number[]; labels: string[] };
    expect(g.ys[0]).toBeCloseTo(log.y(2000));
    expect(g.labels).toEqual(["0.5  20.00"]);
  });

  it("labels each level with its price in the instrument's decimals", () => {
    const c2 = new Coords(times, 100, { barWidth: 10, rightIndex: 99 }, new PriceScale(0, 1000, 1000, "linear"), 1000, 1000, H, 2);
    const g = tool.layout(body, c2) as unknown as { labels: string[] };
    expect(g.labels[0]).toBe("0  8.00");
    expect(g.labels[4]).toBe("0.618  5.53");
    expect(g.labels).toHaveLength(9);
  });

  it("is hit on a level line between the two times only", () => {
    const g = tool.layout(body, c);
    // Level 0.5 is at price 600, y = 400.
    expect(tool.hitTest(g, 500, 403, 6)).toBe(true);
    expect(tool.hitTest(g, 500, 380, 6)).toBe(false);
    expect(tool.hitTest(g, 750, 400, 6)).toBe(false);
    // Extension 1.618 below the start.
    expect(tool.hitTest(g, 500, 847, 6)).toBe(true);
    expect(tool.handles(g)).toEqual([
      { x: 300, y: 600 },
      { x: 700, y: 200 },
    ]);
  });

  it("moves with the body and edits an end with a handle", () => {
    expect(tool.moveBy(body, mover(10, 20))).toEqual({ ...body, a: at(310, 620), b: at(710, 220) });
    expect(tool.moveHandle(body, 1, at(800, 100), false)).toEqual({ ...body, b: at(800, 100) });
    expect(tool.moveHandle(body, 0, at(200, 700), true)).toEqual({ ...body, a: { t: c.t(200), p: body.b.p } });
    expect(tool.moveHandle(body, 0, body.b, false)).toBe(body);
  });
});

describe("brush", () => {
  const tool = toolFor("brush")!;
  const stroke = (xs: number[], ys: number[]) => xs.map((x, i) => at(x, ys[i]!));

  it("is a sticky stroke tool", () => {
    expect(tool.placement).toEqual({ clicks: 2, stroke: true });
    expect(tool.sticky).toBe(true);
    const g = tool.layout({ kind: "brush", points: stroke([1, 5, 9], [1, 2, 3]) }, c);
    // Nothing to reshape; the ends are marked while it is selected.
    expect(tool.handles(g)).toEqual([]);
    expect(tool.markers!(g)).toEqual([
      { x: 1, y: 1 },
      { x: 9, y: 3 },
    ]);
  });

  it("touches a selection box one of its segments crosses", () => {
    const g = tool.layout({ kind: "brush", points: stroke([100, 200, 200], [100, 100, 300]) }, c);
    expect(tool.touches(g, { left: 190, top: 150, right: 210, bottom: 160 })).toBe(true);
    expect(tool.touches(g, { left: 120, top: 150, right: 180, bottom: 250 })).toBe(false);
  });

  it("drops the points of a straight stretch", () => {
    const xs = Array.from({ length: 50 }, (_, i) => 100 + i * 4);
    const b = tool.create(stroke(xs, xs.map(() => 500)), c) as BrushBody;
    expect(b.points).toEqual([at(100, 500), at(296, 500)]);
  });

  it("keeps at most 500 points of a long wiggly stroke, with both ends", () => {
    const n = 5000;
    const xs = Array.from({ length: n }, (_, i) => 10 + (i / n) * 980);
    const ys = xs.map((_, i) => 500 + Math.sin(i / 2) * 200 + (i % 5) * 9);
    const raw = stroke(xs, ys);
    const b = tool.create(raw, c) as BrushBody;
    expect(b.points.length).toBeLessThanOrEqual(MAX_BRUSH_POINTS);
    expect(b.points.length).toBeGreaterThan(100);
    expect(b.points[0]).toEqual(raw[0]);
    expect(b.points.at(-1)).toEqual(raw.at(-1));
  });

  it("previews a single point as a dot", () => {
    expect(tool.create([at(5, 5)], c)).toEqual({ kind: "brush", points: [at(5, 5), at(5, 5)] });
  });

  it("is hit near its path only", () => {
    const b: BrushBody = { kind: "brush", points: stroke([100, 200, 200], [100, 100, 300]) };
    const g = tool.layout(b, c);
    expect(tool.timeSpan(b)).toEqual([c.t(100), c.t(200)]);
    expect(tool.hitTest(g, 150, 104, 6)).toBe(true);
    expect(tool.hitTest(g, 203, 250, 6)).toBe(true);
    expect(tool.hitTest(g, 150, 200, 6)).toBe(false);
    expect(tool.hitTest(g, 400, 100, 6)).toBe(false);
  });

  it("moves every point with the body and has nothing to drag at a handle", () => {
    const b: BrushBody = { kind: "brush", points: stroke([100, 200], [100, 150]) };
    expect(tool.moveBy(b, mover(10, 10))).toEqual({ kind: "brush", points: stroke([110, 210], [110, 160]) });
    expect(tool.moveHandle(b, 0, at(5, 5), false)).toBe(b);
  });
});

describe("on a log price scale", () => {
  // The same bars; prices 10 000..1 000 000 ticks over 1000 px, so 1 px is about 0.46 %.
  const lc = new Coords(times, 100, { barWidth: 10, rightIndex: 99 }, new PriceScale(10_000, 1_000_000, 1000, "log"), 1000, 1000, H);
  const la = (x: number, y: number): Anchor => ({ t: lc.t(x), p: lc.p(y) });
  const m = screenMover(lc, 30, 100);
  /** Screen y of every price of a body, in the order they appear. */
  const ys = (b: DrawingBody): number[] => {
    switch (b.kind) {
      case "hline":
        return [lc.y(b.p)];
      case "position":
        return [lc.y(b.entry.p), lc.y(b.stop), lc.y(b.take)];
      case "brush":
        return b.points.map((p) => lc.y(p.p));
      case "note":
        return [];
      default:
        return [lc.y(b.a.p), lc.y(b.b.p)];
    }
  };
  const bodies: DrawingBody[] = [
    { kind: "hline", p: la(0, 300).p },
    { kind: "trend", a: la(100, 700), b: la(300, 200), extendLeft: false, extendRight: true },
    { kind: "rect", a: la(100, 700), b: la(300, 200), extendRight: false },
    { kind: "fib", a: la(100, 700), b: la(300, 200), levels: [0, 0.5, 1] },
    { kind: "position", side: "long", entry: la(200, 500), stop: la(0, 600).p, take: la(0, 300).p, endT: lc.t(400) },
    { kind: "position", side: "short", entry: la(200, 500), stop: la(0, 400).p, take: la(0, 800).p, endT: lc.t(400) },
    { kind: "brush", points: [la(100, 100), la(150, 400), la(200, 250)] },
  ];

  it("moves every price of a body by the same pixels, not by the same ticks", () => {
    for (const b of bodies) {
      const moved = toolFor(b.kind)!.moveBy(b, m);
      const before = ys(b);
      const after = ys(moved);
      for (let i = 0; i < before.length; i++) expect(after[i]! - before[i]!, `${b.kind} ${i}`).toBeCloseTo(100, 0);
      // Prices fall by a share, not by a fixed number of ticks.
      expect(new Set(after.map((y, i) => Math.round(y - before[i]!))).size, b.kind).toBe(1);
    }
    const trend = toolFor("trend")!.moveBy(bodies[1]!, m) as Extract<DrawingBody, { kind: "trend" }>;
    expect(lc.x(trend.a.t)).toBeCloseTo(130, 6);
    const a0 = (bodies[1] as Extract<DrawingBody, { kind: "trend" }>).a;
    const b0 = (bodies[1] as Extract<DrawingBody, { kind: "trend" }>).b;
    expect(a0.p - trend.a.p).not.toBe(b0.p - trend.b.p);
  });

  it("does not move a position past the bottom, where a log scale has no prices", () => {
    const low: DrawingBody = { kind: "position", side: "long", entry: la(200, 990), stop: la(0, 998).p, take: la(0, 900).p, endT: lc.t(400) };
    // 1 tick is the lowest price: entry and stop would meet there.
    const down = screenMover(lc, 0, 5000);
    expect(toolFor("position")!.moveBy(low, down)).toBe(low);
  });

  it("puts a dragged handle at the price under the pointer", () => {
    const trend = bodies[1]!;
    const to = la(250, 650);
    expect(toolFor("trend")!.moveHandle(trend, 1, to, false)).toMatchObject({ b: to });
    // Shift: at the other end's price exactly, whatever the scale.
    const a = (trend as Extract<DrawingBody, { kind: "trend" }>).a;
    expect(toolFor("trend")!.moveHandle(trend, 1, to, true)).toMatchObject({ b: { t: to.t, p: a.p } });
    const long = bodies[4]!;
    expect(toolFor("position")!.moveHandle(long, 0, la(0, 700), false)).toMatchObject({ stop: lc.p(700) });
    // A stop dragged above the entry stays one tick below it.
    const e = (long as Extract<DrawingBody, { kind: "position" }>).entry.p;
    expect(toolFor("position")!.moveHandle(long, 0, la(0, 100), false)).toMatchObject({ stop: e - 1 });
    const fib = bodies[3]!;
    expect(toolFor("fib")!.moveHandle(fib, 0, to, false)).toMatchObject({ a: to });
  });
});

describe("selection box", () => {
  const bodies: DrawingBody[] = [
    { kind: "hline", p: 700 },
    { kind: "fib", a: at(400, 600), b: at(600, 400), levels: [0, 0.5, 1] },
    { kind: "position", side: "long", entry: at(400, 500), stop: c.p(550), take: c.p(400), endT: c.t(600) },
    { kind: "note", t: c.t(500), text: "n" },
  ];
  /** A point on the body: where the tool's own hit test says so. */
  function onBody(body: DrawingBody): { x: number; y: number } {
    const tool = toolFor(body.kind)!;
    const g = tool.layout(body, c);
    for (let y = 0; y <= 1000; y += 2) for (let x = 0; x <= 1000; x += 10) if (tool.hitTest(g, x, y, 0)) return { x, y };
    throw new Error(`no point on ${body.kind}`);
  }

  it("touches every kind through a small box on its body, and not far from it", () => {
    for (const body of bodies) {
      const tool = toolFor(body.kind)!;
      const g = tool.layout(body, c);
      const p = onBody(body);
      expect(tool.touches(g, { left: p.x - 2, top: p.y - 2, right: p.x + 2, bottom: p.y + 2 }), body.kind).toBe(true);
      expect(tool.touches(g, { left: 900, top: 900, right: 990, bottom: 990 }), body.kind).toBe(false);
    }
  });
});
