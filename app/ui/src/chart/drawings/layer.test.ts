import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drawing, DrawingBody } from "../../backend/types";
import { PriceScale } from "../scale";
import { dark } from "../theme";
import type { Viewport } from "../viewport";
import { Coords } from "./geometry";
import { DrawingLayer, type LayerHost } from "./layer";
import { toolFor } from "./registry";

const H = 3_600_000;
const STEP = 4 * H;
const N = 100;
// 100 bars of 4h, 10 px each; bar i at x = 10 i + 10 with the view's right edge at index 99.
const times = new Float64Array(Array.from({ length: N }, (_, i) => i * STEP));
const ohlc = {
  open: Array.from({ length: N }, () => 5_000),
  high: Array.from({ length: N }, () => 6_000),
  low: Array.from({ length: N }, () => 4_000),
  close: Array.from({ length: N }, () => 5_000),
};
const scale = new PriceScale(0, 10_000, 1000, "linear");
const coords = (view: Viewport = { barWidth: 10, rightIndex: 99 }, s = scale, data = ohlc) =>
  new Coords(times, N, view, s, 1000, 1000, STEP, 2, data);

/** Node has no canvas: a path that records nothing will do. */
class FakePath {
  moveTo() {}
  lineTo() {}
  rect() {}
  arc() {}
  closePath() {}
}
(globalThis as { Path2D?: unknown }).Path2D ??= FakePath;

/** A 2D context that accepts every call and does nothing. */
const ctx = new Proxy({} as CanvasRenderingContext2D, {
  get: (_t, key) => (key === "measureText" ? () => ({ width: 10 }) : () => undefined),
  set: () => true,
});

function layer() {
  const host: LayerHost = {
    invalidate: () => {},
    invalidateOverlay: () => {},
    commit: () => {},
    tool: () => {},
    text: () => {},
    style: () => {},
  };
  return new DrawingLayer(host);
}

let n = 0;
/** Each one is painted above the ones made before it. */
function drawing(body: DrawingBody, id = `d${n}`): Drawing {
  n++;
  return {
    id,
    instrument: { source: "mock", symbol: "BTCUSDT" },
    priceScale: 2,
    body,
    style: { color: 0, width: 1, dash: false },
    locked: false,
    z: n,
    updatedAt: 0,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("culling", () => {
  it("keeps a note of a lower timeframe inside the last bar clickable at the right edge", () => {
    const l = layer();
    // Made on 1h three hours into the last 4h bar; the plot ends 0.1 bar after that bar opens.
    const note = drawing({ kind: "note", t: 99 * STEP + 3 * H, text: "late" });
    l.setDrawings([note]);
    const c = coords({ barWidth: 10, rightIndex: 99.1 });
    l.paintBase(ctx, c, 1, dark, () => {});
    const g = toolFor("note")!.layout(note.body, c) as { x: number; y: number };
    expect(g.x).toBeLessThan(1000);
    expect(l.pointerDown(g.x, g.y, false)).toBe(true);
    expect(l.state.selected).toBe(note.id);
  });

  it("keeps a handle that sticks into the plot from just outside it", () => {
    const l = layer();
    // The left end is 3 px left of the plot: its handle still shows and can be grabbed.
    const c = coords();
    const trend = drawing({ kind: "trend", a: { t: c.t(-3), p: 5_000 }, b: { t: c.t(-3) - STEP, p: 6_000 }, extendLeft: false, extendRight: false });
    l.setDrawings([trend]);
    l.paintBase(ctx, c, 1, dark, () => {});
    expect(l.pointerDown(1, c.y(5_000), false)).toBe(true);
  });

  it("still leaves out what is far from the plot", () => {
    const l = layer();
    const c = coords();
    const far = drawing({ kind: "note", t: 200 * STEP, text: "far" });
    l.setDrawings([far]);
    const layout = vi.spyOn(toolFor("note")!, "layout");
    l.paintBase(ctx, c, 1, dark, () => {});
    expect(layout).not.toHaveBeenCalled();
  });
});

describe("hit-testing", () => {
  const hline = (p: number, id: string) => drawing({ kind: "hline", p }, id);

  it("finds the selected drawing's handles first, then the top-most drawing", () => {
    const l = layer();
    const c = coords();
    // Two lines at the same price: the later one is on top.
    l.setDrawings([hline(5_000, "under"), hline(5_000, "over")]);
    l.paintBase(ctx, c, 1, dark, () => {});
    const y = c.y(5_000);
    l.pointerMove(200, y, false);
    expect(l.state.hover).toEqual({ id: "over", part: "body" });
    // On the handle in the middle: the selected one wins even under the other.
    l.state.select("under");
    l.pointerMove(500, y, false);
    expect(l.state.hover).toEqual({ id: "under", part: 0 });
    l.state.select(null);
    l.pointerMove(501, y, false);
    expect(l.state.hover).toEqual({ id: "over", part: 0 });
  });

  it("lays out and lists handles once per frame, however often the pointer moves", () => {
    const l = layer();
    const c = coords();
    l.setDrawings([hline(5_000, "a"), hline(3_000, "b")]);
    const tool = toolFor("hline")!;
    const handles = vi.spyOn(tool, "handles");
    const layout = vi.spyOn(tool, "layout");
    l.paintBase(ctx, c, 1, dark, () => {});
    for (let x = 0; x < 50; x++) l.pointerMove(100 + x, 400, false);
    expect(layout).toHaveBeenCalledTimes(2);
    expect(handles).toHaveBeenCalledTimes(2);
  });
});
