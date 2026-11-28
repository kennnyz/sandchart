import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drawing, DrawingBody } from "../../backend/types";
import { PriceScale } from "../scale";
import { dark } from "../theme";
import type { Viewport } from "../viewport";
import { Coords } from "./geometry";
import { DrawingLayer, type LayerHost, type MenuEdit, type StyleEdit } from "./layer";
import type { DrawingChange } from "./state";
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
    menu: () => {},
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
    hidden: false,
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

describe("geometry cache", () => {
  /** Paints one frame per Coords and counts the layouts of each tool. */
  function frames(list: Drawing[]) {
    const l = layer();
    l.setDrawings(list);
    const trend = vi.spyOn(toolFor("trend")!, "layout");
    const note = vi.spyOn(toolFor("note")!, "layout");
    return { paint: (c: Coords) => l.paintBase(ctx, c, 1, dark, () => {}), trend, note };
  }
  const trendBody: DrawingBody = { kind: "trend", a: { t: 50 * STEP, p: 4_000 }, b: { t: 60 * STEP, p: 6_000 }, extendLeft: false, extendRight: false };

  it("keeps the layout over a live tick that changes nothing it depends on", () => {
    const data = structuredClone(ohlc);
    const f = frames([drawing(trendBody), drawing({ kind: "note", t: 10 * STEP, text: "old bar" })]);
    f.paint(coords(undefined, scale, data));
    // The last bar's close moves: a new Coords object, the same geometry.
    data.close[N - 1] = 5_100;
    f.paint(coords(undefined, scale, data));
    expect(f.trend).toHaveBeenCalledTimes(1);
    expect(f.note).toHaveBeenCalledTimes(1);
  });

  it("lays out again when the view, the price scale or the bars change", () => {
    const f = frames([drawing(trendBody)]);
    f.paint(coords());
    f.paint(coords({ barWidth: 10, rightIndex: 98 }));
    expect(f.trend).toHaveBeenCalledTimes(2);
    f.paint(coords({ barWidth: 10, rightIndex: 98 }, new PriceScale(0, 12_000, 1000, "linear")));
    expect(f.trend).toHaveBeenCalledTimes(3);
    f.paint(coords({ barWidth: 10, rightIndex: 98 }, new PriceScale(1, 12_000, 1000, "log")));
    expect(f.trend).toHaveBeenCalledTimes(4);
    // A new bar.
    const more = new Float64Array(Array.from({ length: N + 1 }, (_, i) => i * STEP));
    const scaleLog = new PriceScale(1, 12_000, 1000, "log");
    f.paint(new Coords(more, N + 1, { barWidth: 10, rightIndex: 98 }, scaleLog, 1000, 1000, STEP, 2, ohlc));
    expect(f.trend).toHaveBeenCalledTimes(5);
    // Another plot size.
    f.paint(new Coords(more, N + 1, { barWidth: 10, rightIndex: 98 }, scaleLog, 900, 1000, STEP, 2, ohlc));
    expect(f.trend).toHaveBeenCalledTimes(6);
  });

  it("moves a note on the last bar when that bar's high changes", () => {
    const data = structuredClone(ohlc);
    const f = frames([drawing({ kind: "note", t: (N - 1) * STEP, text: "now" })]);
    f.paint(coords(undefined, scale, data));
    f.paint(coords(undefined, scale, data));
    expect(f.note).toHaveBeenCalledTimes(1);
    data.high[N - 1] = 6_500;
    f.paint(coords(undefined, scale, data));
    expect(f.note).toHaveBeenCalledTimes(2);
  });
});

describe("replay cut", () => {
  it("neither paints nor hits a drawing whose earliest anchor is at or after the cut", () => {
    const l = layer();
    const c = coords();
    const at = (i: number) => i * STEP;
    const past = drawing({ kind: "note", t: at(40), text: "past" }, "past");
    const later = drawing({ kind: "note", t: at(60), text: "later" }, "later");
    // Starts before the cut and reaches past it: its first anchor is revealed, so it shows.
    const across = drawing(
      { kind: "trend", a: { t: at(70), p: 5_500 }, b: { t: at(45), p: 4_500 }, extendLeft: true, extendRight: false },
      "across",
    );
    // Both anchors later, though it extends to the left: hidden.
    const ahead = drawing(
      { kind: "trend", a: { t: at(80), p: 4_200 }, b: { t: at(90), p: 4_200 }, extendLeft: true, extendRight: false },
      "ahead",
    );
    const position = drawing({ kind: "position", side: "long", entry: { t: at(55), p: 5_000 }, stop: 4_000, take: 7_000, endT: at(70) }, "pos");
    const level = drawing({ kind: "hline", p: 3_000 }, "level");
    // Inside a forming bar of a higher timeframe: half a bar before the cut is revealed.
    const inside = drawing({ kind: "trend", a: { t: at(49.5), p: 4_000 }, b: { t: at(49.5) + 1, p: 4_100 }, extendLeft: false, extendRight: false }, "inside");
    l.setDrawings([past, later, across, ahead, position, level, inside]);
    const note = toolFor("note")!;
    const where = (d: Drawing) => note.layout(d.body, c) as { x: number; y: number };
    const painted = () => {
      const spies = (["note", "trend", "position", "hline"] as const).map((k) => vi.spyOn(toolFor(k)!, "paint"));
      l.paintBase(ctx, c, 1, dark, () => {});
      const n = spies.reduce((a, s) => a + s.mock.calls.length, 0);
      spies.forEach((s) => s.mockRestore());
      return n;
    };
    expect(painted()).toBe(7);

    // The cut is the close time of the last revealed bar: bar 49 is revealed, bar 50 is not.
    l.setCut(at(50));
    expect(painted()).toBe(4);
    const p = where(past);
    expect(l.pointerDown(p.x, p.y, false)).toBe(true);
    l.pointerUp(p.x, p.y, false);
    expect(l.state.selected).toBe("past");
    const q = where(later);
    l.state.select(null);
    expect(l.pointerDown(q.x, q.y, false)).toBe(false);
    l.pointerUp(q.x, q.y, false);
    expect(l.state.selected).toBeNull();

    // A drawing anchored exactly at the cut is on the first bar not revealed yet.
    l.setCut(at(60));
    expect(painted()).toBe(5);
    // A step reveals the bar of the later note.
    l.setCut(at(61));
    expect(painted()).toBe(6);
    l.setCut(null);
    expect(painted()).toBe(7);
  });

  it("drops the selection of a drawing the cut hides", () => {
    const l = layer();
    l.setDrawings([drawing({ kind: "note", t: 60 * STEP, text: "later" }, "later")]);
    l.state.select("later");
    l.setCut(60 * STEP);
    expect(l.state.selected).toBeNull();
  });
});

/** A layer whose host records what it was asked for. */
function recording() {
  const rec = { base: 0, overlay: 0, menus: [] as (MenuEdit | null)[], styles: [] as (StyleEdit | null)[], commits: [] as DrawingChange[] };
  const host: LayerHost = {
    invalidate: () => rec.base++,
    invalidateOverlay: () => rec.overlay++,
    commit: (step) => rec.commits.push(...step),
    tool: () => {},
    text: () => {},
    style: (e) => rec.styles.push(e),
    menu: (e) => rec.menus.push(e),
  };
  const l = new DrawingLayer(host);
  const c = coords();
  return { l, c, rec, paint: () => l.paintBase(ctx, c, 1, dark, () => {}) };
}

const hl = (p: number, id: string, extra: Partial<Drawing> = {}) => ({ ...drawing({ kind: "hline", p }, id), ...extra });

describe("several selected", () => {
  it("⌘-drag on empty space selects every drawing the box touches", () => {
    const { l, c, rec, paint } = recording();
    // Lines at y = 400, 500 and 700; a trend line from (300, 650) to (400, 600).
    const trend = drawing({ kind: "trend", a: { t: c.t(300), p: c.p(650) }, b: { t: c.t(400), p: c.p(600) }, extendLeft: false, extendRight: false }, "t");
    l.setDrawings([hl(c.p(400), "a"), hl(c.p(500), "b"), hl(c.p(700), "c"), trend]);
    paint();
    const base = rec.base;
    expect(l.pointerDown(200, 380, false, true)).toBe(true);
    l.pointerMove(350, 520, false, true);
    // The box is drawn on the overlay only.
    expect(rec.base).toBe(base);
    l.pointerUp(350, 520, false, true);
    expect(l.state.selection).toEqual(["a", "b"]);
    // A second box with ⌘ adds to the selection; it touches the trend line only.
    l.pointerDown(340, 600, false, true);
    l.pointerUp(360, 640, false, true);
    expect(l.state.selection).toEqual(["a", "b", "t"]);
    // A ⌘-click on empty space without a drag keeps the selection.
    l.pointerDown(900, 900, false, true);
    l.pointerUp(900, 900, false, true);
    expect(l.state.selection).toHaveLength(3);
    // A plain click on empty space drops it.
    expect(l.pointerDown(900, 900, false)).toBe(false);
    expect(l.state.selection).toEqual([]);
  });

  it("⌘-click toggles a drawing in and out of the selection without moving it", () => {
    const { l, c, rec, paint } = recording();
    l.setDrawings([hl(c.p(400), "a"), hl(c.p(500), "b")]);
    paint();
    l.pointerDown(100, 400, false);
    l.pointerUp(100, 400, false);
    l.pointerDown(100, 500, false, true);
    l.pointerMove(100, 560, false, true);
    l.pointerUp(100, 560, false, true);
    expect(l.state.selection).toEqual(["a", "b"]);
    expect(rec.commits).toEqual([]);
    l.pointerDown(100, 400, false, true);
    l.pointerUp(100, 400, false, true);
    expect(l.state.selection).toEqual(["b"]);
  });

  it("drags the selection together as one undo step; Delete removes all as one", () => {
    const { l, c, rec, paint } = recording();
    l.setDrawings([hl(c.p(400), "a"), hl(c.p(500), "b"), hl(c.p(700), "c")]);
    paint();
    l.state.setSelection(["a", "b"]);
    l.pointerDown(100, 500, false);
    l.pointerMove(100, 530, false);
    l.pointerMove(100, 550, false);
    l.pointerUp(100, 550, false);
    expect(l.state.byId("a")!.body).toEqual({ kind: "hline", p: c.p(450) });
    expect(l.state.byId("b")!.body).toEqual({ kind: "hline", p: c.p(550) });
    expect(l.state.byId("c")!.body).toEqual({ kind: "hline", p: c.p(700) });
    expect(rec.commits).toHaveLength(2);
    expect(l.state.selection).toEqual(["a", "b"]);
    expect(l.command("undo")).toBe(true);
    expect(l.state.byId("a")!.body).toEqual({ kind: "hline", p: c.p(400) });
    expect(l.state.byId("b")!.body).toEqual({ kind: "hline", p: c.p(500) });
    expect(l.command("delete")).toBe(true);
    expect(l.state.drawings.map((d) => d.id)).toEqual(["c"]);
    expect(l.command("undo")).toBe(true);
    expect(l.state.drawings).toHaveLength(3);
  });

  it("a click without a drag on one of several selects only it", () => {
    const { l, c, paint } = recording();
    l.setDrawings([hl(c.p(400), "a"), hl(c.p(500), "b")]);
    paint();
    l.state.setSelection(["a", "b"]);
    l.pointerDown(100, 500, false);
    l.pointerUp(100, 500, false);
    expect(l.state.selection).toEqual(["b"]);
  });

  it("moves none of the selection when every one is locked", () => {
    const { l, c, rec, paint } = recording();
    l.setDrawings([hl(c.p(400), "a"), hl(c.p(500), "b")]);
    paint();
    l.state.setSelection(["a", "b"]);
    l.state.updateMany(["a", "b"], { locked: true });
    rec.commits.length = 0;
    l.pointerDown(100, 500, false);
    l.pointerMove(100, 600, false);
    l.pointerUp(100, 600, false);
    expect(rec.commits).toEqual([]);
    expect(l.state.byId("b")!.body).toEqual({ kind: "hline", p: c.p(500) });
  });
});

describe("context menu", () => {
  it("opens on a drawing for the selection, and locks, hides and removes them all", () => {
    const { l, c, rec, paint } = recording();
    l.setDrawings([hl(c.p(400), "a"), hl(c.p(500), "b"), hl(c.p(700), "c")]);
    paint();
    expect(l.contextMenu(100, 900)).toBe(false);
    l.state.setSelection(["a", "b"]);
    expect(l.contextMenu(100, 500)).toBe(true);
    expect(rec.menus.at(-1)).toEqual({ ids: ["a", "b"], locked: false, single: false, x: 100, y: 500 });
    l.menuAction("lock");
    expect(rec.menus.at(-1)).toBeNull();
    expect(l.state.drawings.filter((d) => d.locked).map((d) => d.id)).toEqual(["a", "b"]);
    l.contextMenu(100, 400);
    expect(rec.menus.at(-1)).toMatchObject({ locked: true });
    l.menuAction("unlock");
    expect(l.state.drawings.some((d) => d.locked)).toBe(false);
    l.contextMenu(100, 400);
    l.menuAction("hide");
    expect(l.state.drawings.filter((d) => d.hidden).length).toBe(2);
    expect(l.state.selection).toEqual([]);
    // A right click on a drawing outside the selection selects it alone.
    l.contextMenu(100, 700);
    expect(rec.menus.at(-1)).toMatchObject({ ids: ["c"], single: true });
    l.menuAction("remove");
    expect(l.state.drawings.map((d) => d.id)).toEqual(["a", "b"]);
    l.showHidden();
    expect(l.state.drawings.filter((d) => d.hidden).length).toBe(0);
  });

  it("opens the style popover from Settings, and Esc closes the menu", () => {
    const { l, c, rec, paint } = recording();
    l.setDrawings([hl(c.p(400), "a")]);
    paint();
    l.contextMenu(120, 400);
    l.menuAction("settings");
    expect(rec.styles.at(-1)).toMatchObject({ drawing: { id: "a" }, x: 120, y: 400 });
    l.contextMenu(120, 400);
    expect(l.command("cancel")).toBe(true);
    expect(rec.menus.at(-1)).toBeNull();
  });
});

describe("hidden drawings", () => {
  it("are neither painted nor hit", () => {
    const { l, c } = recording();
    l.setDrawings([hl(c.p(400), "h", { hidden: true }), hl(c.p(500), "v")]);
    const paint = vi.spyOn(toolFor("hline")!, "paint");
    l.paintBase(ctx, c, 1, dark, () => {});
    expect(paint).toHaveBeenCalledTimes(1);
    expect(l.pointerDown(100, 400, false)).toBe(false);
    expect(l.state.selection).toEqual([]);
  });
});

describe("overlay frames", () => {
  it("lists a selected brush stroke's end markers once per layout, not every frame", () => {
    const { l, c, paint } = recording();
    const stroke = drawing({ kind: "brush", points: [{ t: c.t(100), p: c.p(500) }, { t: c.t(300), p: c.p(400) }] }, "s");
    l.setDrawings([stroke]);
    l.state.select("s");
    paint();
    const markers = vi.spyOn(toolFor("brush")!, "markers");
    for (let i = 0; i < 5; i++) l.paintOverlay(ctx, 1, dark, () => {});
    expect(markers).toHaveBeenCalledTimes(1);
  });
});

describe("⌘ snapping and handles", () => {
  it("keeps snapping a dragged end bar to bar while ⌘ is held", () => {
    const { l, c, paint } = recording();
    // Bars span 4000..6000 ticks; their high is at y = 400.
    const t = drawing({ kind: "trend", a: { t: c.t(100), p: 5_000 }, b: { t: c.t(300), p: 5_000 }, extendLeft: false, extendRight: false }, "t");
    l.setDrawings([t]);
    paint();
    l.pointerDown(300, 500, false);
    l.pointerMove(452, 430, false, true);
    l.pointerMove(503, 385, false, true);
    l.pointerUp(503, 385, false, true);
    const b = (l.state.byId("t")!.body as Extract<DrawingBody, { kind: "trend" }>).b;
    // On the high (6000), at the open time of the bar under x = 503 (bar 49, at x = 500).
    expect(b).toEqual({ t: 49 * STEP, p: 6_000 });
  });

  it("reshapes with ⌘ held from the press on a handle of a drawing that is not selected", () => {
    const { l, c, paint } = recording();
    const other = hl(c.p(800), "o");
    const t = drawing({ kind: "trend", a: { t: c.t(100), p: 5_000 }, b: { t: c.t(300), p: 5_000 }, extendLeft: false, extendRight: false }, "t");
    l.setDrawings([other, t]);
    l.state.select("o");
    paint();
    // The handle of the hovered line: ⌘ snaps it, it does not add the line to the selection.
    expect(l.pointerDown(300, 500, false, true)).toBe(true);
    expect(l.state.selection).toEqual(["t"]);
    l.pointerMove(503, 385, false, true);
    l.pointerUp(503, 385, false, true);
    const b = (l.state.byId("t")!.body as Extract<DrawingBody, { kind: "trend" }>).b;
    expect(b).toEqual({ t: 49 * STEP, p: 6_000 });
  });

  it("moves the whole trend line with its middle handle", () => {
    const { l, c, paint } = recording();
    const t = drawing({ kind: "trend", a: { t: c.t(100), p: c.p(600) }, b: { t: c.t(300), p: c.p(400) }, extendLeft: false, extendRight: false }, "t");
    l.setDrawings([t]);
    paint();
    l.state.select("t");
    expect(l.pointerDown(200, 500, false)).toBe(true);
    expect(l.cursor()).toBe("move");
    l.pointerMove(250, 450, false);
    l.pointerUp(250, 450, false);
    const body = l.state.byId("t")!.body as Extract<DrawingBody, { kind: "trend" }>;
    expect(body.a).toEqual({ t: c.t(150), p: c.p(550) });
    expect(body.b).toEqual({ t: c.t(350), p: c.p(350) });
  });

  it("resizes one side of a rect with an edge handle", () => {
    const { l, c, paint } = recording();
    const r = drawing({ kind: "rect", a: { t: c.t(100), p: c.p(600) }, b: { t: c.t(300), p: c.p(400) }, extendRight: false }, "r");
    l.setDrawings([r]);
    paint();
    l.state.select("r");
    // The middle of the edge at b's time (x = 300).
    l.pointerDown(300, 500, false);
    l.pointerMove(360, 520, false);
    l.pointerUp(360, 520, false);
    const body = l.state.byId("r")!.body as Extract<DrawingBody, { kind: "rect" }>;
    expect(body.a).toEqual(r.body.kind === "rect" ? r.body.a : null);
    expect(body.b).toEqual({ t: c.t(360), p: c.p(400) });
  });

  it("marks a selected brush stroke's ends, and a press there moves it", () => {
    const { l, c, paint } = recording();
    const br = drawing({ kind: "brush", points: [{ t: c.t(100), p: c.p(500) }, { t: c.t(200), p: c.p(500) }] }, "br");
    l.setDrawings([br]);
    paint();
    l.state.select("br");
    l.pointerDown(100, 500, false);
    expect(l.cursor()).toBe("move");
    l.pointerMove(100, 540, false);
    l.pointerUp(100, 540, false);
    const body = l.state.byId("br")!.body as Extract<DrawingBody, { kind: "brush" }>;
    expect(body.points).toEqual([{ t: c.t(100), p: c.p(540) }, { t: c.t(200), p: c.p(540) }]);
  });
});

describe("many selected drawings", () => {
  it("hit-tests 2000 selected drawings in about linear time", () => {
    const l = layer();
    const list = Array.from({ length: 2000 }, (_, i) => drawing({ kind: "hline", p: 1_000 + i * 4 }));
    l.setDrawings(list);
    l.state.setSelection(list.map((d) => d.id));
    const c = coords();
    l.paintBase(ctx, c, 1, dark, () => {});
    const t0 = performance.now();
    // Pointer moves over the plot: each one checks every drawing's selection twice.
    for (let i = 0; i < 200; i++) l.pointerMove(5 + (i % 100), 5, false);
    const ms = performance.now() - t0;
    expect(l.state.selection).toHaveLength(2000);
    // A scan of the selection per drawing takes seconds here.
    expect(ms).toBeLessThan(300);
  });
});

describe("⌘ snap preview", () => {
  // Bar 50 at x = 510: open and close 5000 (y 500), high 6000 (y 400), low 4000 (y 600).
  it("shows where a point would snap before the first click, as soon as ⌘ goes down or up", () => {
    const { l, rec, paint } = recording();
    paint();
    l.setTool("trend");
    l.pointerMove(511, 430, false, false);
    expect(l.snapPreview()).toBeNull();
    const base = rec.base;
    const overlay = rec.overlay;
    // No mouse movement: the key alone shows the ring on the high of the bar under the mouse.
    l.modifiers(true);
    expect(l.snapPreview()).toEqual({ x: 510, y: 400, anchor: { t: 50 * STEP, p: 6_000 } });
    expect(rec.overlay).toBeGreaterThan(overlay);
    l.modifiers(true);
    l.modifiers(false);
    expect(l.snapPreview()).toBeNull();
    // Only the overlay is drawn again.
    expect(rec.base).toBe(base);
  });

  it("follows the mouse with ⌘ held and places the first point on that price", () => {
    const { l, rec, paint } = recording();
    paint();
    l.setOwner({ instrument: { source: "mock", symbol: "BTCUSDT" }, priceScale: 2 });
    l.setTool("trend");
    l.pointerMove(611, 590, false, true);
    expect(l.snapPreview()?.anchor).toEqual({ t: 60 * STEP, p: 4_000 });
    l.pointerDown(611, 590, false, true);
    l.pointerUp(611, 590, false, true);
    expect(l.state.points).toEqual([{ t: 60 * STEP, p: 4_000 }]);
    // The second point: ⌘ pressed while the line follows the mouse.
    l.pointerMove(711, 520, false, false);
    expect(l.snapPreview()).toBeNull();
    const base = rec.base;
    l.modifiers(true);
    expect(l.snapPreview()?.anchor).toEqual({ t: 70 * STEP, p: 5_000 });
    expect(rec.base).toBe(base);
  });

  it("shows nothing without a tool, off the bars, or after the mouse left", () => {
    const { l, paint } = recording();
    paint();
    l.pointerMove(511, 430, false, true);
    expect(l.snapPreview()).toBeNull();
    l.setTool("trend");
    l.pointerMove(511, 100, false, true);
    expect(l.snapPreview()).toBeNull();
    l.pointerMove(511, 430, false, true);
    expect(l.snapPreview()).not.toBeNull();
    l.leave();
    l.modifiers(false);
    l.modifiers(true);
    expect(l.snapPreview()).toBeNull();
  });
});

describe("add from a menu", () => {
  it("stores the drawing, selects it and puts the armed tool down", () => {
    const { l, rec } = recording();
    l.setOwner({ instrument: { source: "mock", symbol: "BTCUSDT" }, priceScale: 2 });
    l.setTool("trend");
    const base = rec.base;
    l.add({ kind: "hline", p: 4_321 });
    expect(rec.commits).toHaveLength(1);
    expect(rec.commits[0]!.after).toMatchObject({ body: { kind: "hline", p: 4_321 } });
    expect(l.state.selected).toBe(rec.commits[0]!.after!.id);
    expect(l.state.tool).toBeNull();
    expect(rec.base).toBeGreaterThan(base);
  });
});
