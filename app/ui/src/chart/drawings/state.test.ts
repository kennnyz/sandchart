import { describe, expect, it } from "vitest";
import type { Anchor, Drawing, DrawingKind } from "../../backend/types";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import { DrawingState, HISTORY_LIMIT, type DrawingChange } from "./state";

const H = 3_600_000;
const times = new Float64Array(Array.from({ length: 10 }, (_, i) => i * H));
const c = new Coords(times, 10, { barWidth: 10, rightIndex: 9 }, new PriceScale(0, 100, 100, "linear"), 100, 100, H);
const BTC = { source: "mock", symbol: "BTCUSDT" };
const A: Anchor = { t: 1 * H, p: 10 };
const B: Anchor = { t: 3 * H, p: 40 };

function setup() {
  const commits: DrawingChange[] = [];
  const tools: (DrawingKind | null)[] = [];
  let n = 0;
  const s = new DrawingState({ commit: (ch) => commits.push(ch), tool: (k) => tools.push(k) }, () => `d${++n}`);
  s.setOwner({ instrument: BTC, priceScale: 2 });
  return { s, commits, tools };
}

function stored(id: string, z: number, p = 50, locked = false): Drawing {
  return {
    id,
    instrument: BTC,
    priceScale: 2,
    body: { kind: "hline", p },
    style: { color: 0, width: 2, dash: false },
    locked,
    hidden: false,
    z,
    updatedAt: 1,
  };
}

describe("placement", () => {
  it("places a horizontal level with one click, then drops the tool and selects it", () => {
    const { s, commits, tools } = setup();
    s.setTool("hline");
    expect(tools).toEqual(["hline"]);
    const d = s.place(A, false, c);
    expect(d).toMatchObject({ id: "d1", instrument: BTC, priceScale: 2, body: { kind: "hline", p: 10 }, z: 1 });
    expect(commits).toEqual([{ before: null, after: d }]);
    expect(s.drawings).toEqual([d]);
    expect(s.selected).toBe("d1");
    expect(s.tool).toBeNull();
    expect(tools).toEqual(["hline", null]);
  });

  it("places a trend line with two clicks and previews it with the mouse", () => {
    const { s, commits } = setup();
    s.setTool("trend");
    expect(s.place(A, false, c)).toBeNull();
    expect(s.points).toEqual([A]);
    expect(s.placingPoints(B, false)).toEqual([A, B]);
    // A second click on the same point is ignored: a line needs two points.
    expect(s.place({ ...A }, false, c)).toBeNull();
    expect(commits).toEqual([]);
    const d = s.place(B, false, c)!;
    expect(d.body).toEqual({ kind: "trend", a: A, b: B, extendLeft: false, extendRight: false });
    expect(s.points).toEqual([]);
    expect(commits).toHaveLength(1);
  });

  it("makes the next point horizontal while Shift is held", () => {
    const { s } = setup();
    s.setTool("trend");
    s.place(A, true, c);
    expect(s.placingPoints(B, true)).toEqual([A, { t: B.t, p: A.p }]);
    expect(s.place(B, true, c)!.body).toMatchObject({ a: A, b: { t: B.t, p: A.p } });
  });

  it("stacks new drawings on top", () => {
    const { s } = setup();
    s.reset([stored("x", 7), stored("y", 3)]);
    expect(s.drawings.map((d) => d.id)).toEqual(["y", "x"]);
    s.setTool("hline");
    expect(s.place(A, false, c)!.z).toBe(8);
  });

  it("places nothing without a tool or without an instrument", () => {
    const { s, commits } = setup();
    expect(s.place(A, false, c)).toBeNull();
    s.setOwner(null);
    s.setTool("hline");
    expect(s.place(A, false, c)).toBeNull();
    expect(commits).toEqual([]);
  });

  it("switching tools drops the placed points and the selection", () => {
    const { s, tools } = setup();
    s.reset([stored("x", 1)]);
    s.select("x");
    s.setTool("trend");
    s.place(A, false, c);
    s.setTool("hline");
    expect(s.points).toEqual([]);
    expect(s.selected).toBeNull();
    s.setTool("hline");
    expect(tools).toEqual(["trend", "hline"]);
  });
});

describe("edits and history", () => {
  it("records an edit and skips one that changes nothing or touches a locked drawing", () => {
    const { s, commits } = setup();
    const x = stored("x", 1);
    s.reset([x, stored("l", 2, 60, true)]);
    expect(s.edit("x", { kind: "hline", p: 50 })).toBe(false);
    expect(s.edit("l", { kind: "hline", p: 70 })).toBe(false);
    expect(s.edit("nope", { kind: "hline", p: 70 })).toBe(false);
    expect(s.edit("x", { kind: "hline", p: 55 })).toBe(true);
    expect(commits).toEqual([{ before: x, after: { ...x, body: { kind: "hline", p: 55 } } }]);
    expect(s.byId("x")!.body).toEqual({ kind: "hline", p: 55 });
  });

  it("deletes the selection, and undo and redo replay every change through the listener", () => {
    const { s, commits } = setup();
    s.setTool("hline");
    const d = s.place(A, false, c)!;
    s.edit(d.id, { kind: "hline", p: 20 });
    const edited = s.byId(d.id)!;
    expect(s.deleteSelected()).toBe(true);
    expect(s.drawings).toEqual([]);
    expect(s.selected).toBeNull();
    expect(s.deleteSelected()).toBe(false);
    commits.length = 0;

    expect(s.undo()).toBe(true); // the delete
    expect(s.drawings).toEqual([edited]);
    expect(s.undo()).toBe(true); // the edit
    expect(s.byId(d.id)).toEqual(d);
    expect(s.undo()).toBe(true); // the placement
    expect(s.drawings).toEqual([]);
    expect(s.undo()).toBe(false);
    expect(commits).toEqual([
      { before: null, after: edited },
      { before: edited, after: d },
      { before: d, after: null },
    ]);
    commits.length = 0;

    expect(s.redo()).toBe(true);
    expect(s.redo()).toBe(true);
    expect(s.byId(d.id)).toEqual(edited);
    expect(s.selected).toBe(d.id);
    expect(commits).toEqual([
      { before: null, after: d },
      { before: d, after: edited },
    ]);
    // A new change drops what was left to redo.
    s.edit(d.id, { kind: "hline", p: 30 });
    expect(s.redo()).toBe(false);
  });

  it("keeps at most HISTORY_LIMIT steps", () => {
    const { s } = setup();
    s.reset([stored("x", 1)]);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) s.edit("x", { kind: "hline", p: 100 + i });
    let undone = 0;
    while (s.undo()) undone++;
    expect(undone).toBe(HISTORY_LIMIT);
    expect(s.byId("x")!.body).toEqual({ kind: "hline", p: 104 });
  });

  it("a new list (another instrument) drops the history, the selection and the hover", () => {
    const { s } = setup();
    s.reset([stored("x", 1)]);
    s.edit("x", { kind: "hline", p: 1 });
    s.select("x");
    s.hover = { id: "x", part: "body" };
    s.reset([stored("y", 1)]);
    expect(s.undo()).toBe(false);
    expect(s.selected).toBeNull();
    expect(s.hover).toBeNull();
  });

  it("undoing a delete of the hovered drawing clears the hover", () => {
    const { s } = setup();
    s.reset([stored("x", 1)]);
    s.select("x");
    s.hover = { id: "x", part: "body" };
    s.deleteSelected();
    expect(s.hover).toBeNull();
  });
});

describe("cancel", () => {
  it("drops the placed points, the tool and the selection, and says whether there was any", () => {
    const { s, tools } = setup();
    expect(s.cancel()).toBe(false);
    s.reset([stored("x", 1)]);
    s.select("x");
    s.setTool("trend");
    s.select("x");
    s.place(A, false, c);
    expect(s.cancel()).toBe(true);
    expect(s.points).toEqual([]);
    expect(s.tool).toBeNull();
    expect(s.selected).toBeNull();
    expect(tools).toEqual(["trend", null]);
  });
});
