import { describe, expect, it } from "vitest";
import type { Anchor, Drawing } from "../../backend/types";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import type { ToolId } from "./registry";
import { DrawingState, HISTORY_LIMIT, type DrawingChange } from "./state";

const H = 3_600_000;
const times = new Float64Array(Array.from({ length: 10 }, (_, i) => i * H));
const c = new Coords(times, 10, { barWidth: 10, rightIndex: 9 }, new PriceScale(0, 100, 100, "linear"), 100, 100, H);
const BTC = { source: "mock", symbol: "BTCUSDT" };
const A: Anchor = { t: 1 * H, p: 10 };
const B: Anchor = { t: 3 * H, p: 40 };

function setup() {
  const commits: DrawingChange[] = [];
  const tools: (ToolId | null)[] = [];
  let n = 0;
  const steps: DrawingChange[][] = [];
  const s = new DrawingState(
    {
      commit: (step) => {
        steps.push(step);
        commits.push(...step);
      },
      tool: (k) => tools.push(k),
    },
    () => `d${++n}`,
  );
  s.setOwner({ instrument: BTC, priceScale: 2 });
  return { s, commits, steps, tools };
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

  it("strokes a brush while pressed and keeps the tool after the release", () => {
    const { s, commits, tools } = setup();
    s.setTool("brush");
    s.stroke(A);
    s.stroke({ ...A });
    s.stroke({ t: 2 * H, p: 20 });
    s.stroke(B);
    // A repeated point is dropped.
    expect(s.points).toEqual([A, { t: 2 * H, p: 20 }, B]);
    const d = s.endStroke(c)!;
    expect(d.body).toEqual({ kind: "brush", points: [A, { t: 2 * H, p: 20 }, B] });
    expect(commits).toEqual([{ before: null, after: d }]);
    expect(s.points).toEqual([]);
    // Sticky: the tool stays, nothing is selected, the next stroke can start.
    expect(s.tool).toBe("brush");
    expect(s.selected).toBeNull();
    expect(tools).toEqual(["brush"]);
  });

  it("drops a stroke of one point, and strokes only with a stroke tool", () => {
    const { s, commits } = setup();
    s.setTool("brush");
    s.stroke(A);
    expect(s.endStroke(c)).toBeNull();
    expect(s.points).toEqual([]);
    s.setTool("trend");
    s.stroke(A);
    expect(s.points).toEqual([]);
    expect(s.endStroke(c)).toBeNull();
    expect(commits).toEqual([]);
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

  it("updates style, lock and body as one undo step, also on a locked drawing", () => {
    const { s, commits } = setup();
    const l = stored("l", 1, 60, true);
    s.reset([l]);
    expect(s.update("l", { style: { ...l.style } })).toBe(false);
    expect(s.update("nope", { locked: false })).toBe(false);
    expect(s.update("l", { style: { color: 3, width: 4, dash: true } })).toBe(true);
    expect(s.update("l", { locked: false })).toBe(true);
    expect(s.byId("l")).toEqual({ ...l, style: { color: 3, width: 4, dash: true }, locked: false });
    expect(commits).toHaveLength(2);
    expect(s.undo()).toBe(true);
    expect(s.byId("l")!.locked).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.byId("l")).toEqual(l);
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

describe("several selected", () => {
  it("toggles drawings in and out of the selection, never a hidden or unknown one", () => {
    const { s } = setup();
    s.reset([stored("a", 1), stored("b", 2), { ...stored("h", 3), hidden: true }]);
    s.select("a");
    s.toggle("b");
    expect(s.selection).toEqual(["a", "b"]);
    // With two, there is no single selected drawing (no handles, no style popover).
    expect(s.selected).toBeNull();
    expect(s.isSelected("b")).toBe(true);
    s.toggle("a");
    expect(s.selection).toEqual(["b"]);
    expect(s.selected).toBe("b");
    s.toggle("h");
    s.toggle("nope");
    expect(s.selection).toEqual(["b"]);
    s.setSelection(["a", "h", "b", "a"]);
    expect(s.selection).toEqual(["a", "b"]);
    expect(s.selectedDrawings().map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("moves the selection as one undo step, leaving a locked one where it is", () => {
    const { s, commits } = setup();
    const a = stored("a", 1, 10);
    const b = stored("b", 2, 20);
    const l = stored("l", 3, 30, true);
    s.reset([a, b, l]);
    s.setSelection(["a", "b", "l"]);
    const moved = new Map([
      ["a", { kind: "hline" as const, p: 15 }],
      ["b", { kind: "hline" as const, p: 25 }],
      ["l", { kind: "hline" as const, p: 35 }],
    ]);
    expect(s.editMany(moved)).toBe(true);
    expect(commits).toHaveLength(2);
    expect(s.drawings.map((d) => d.body)).toEqual([
      { kind: "hline", p: 15 },
      { kind: "hline", p: 25 },
      { kind: "hline", p: 30 },
    ]);
    // The selection is kept, the locked one too.
    expect(s.selection).toEqual(["a", "b", "l"]);
    commits.length = 0;
    expect(s.undo()).toBe(true);
    expect(s.drawings).toEqual([a, b, l]);
    expect(commits).toHaveLength(2);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(true);
    expect(s.byId("b")!.body).toEqual({ kind: "hline", p: 25 });
    // Only locked ones: nothing to record.
    expect(s.editMany(new Map([["l", { kind: "hline", p: 99 }]]))).toBe(false);
  });

  it("deletes every selected drawing as one undo step and brings them all back", () => {
    const { s, commits, steps } = setup();
    const a = stored("a", 1, 10);
    const l = stored("l", 2, 20, true);
    const c3 = stored("c", 3, 30);
    s.reset([a, l, c3]);
    s.setSelection(["a", "l"]);
    expect(s.deleteSelected()).toBe(true);
    // One step reaches the listener whole, to be stored in one write.
    expect(steps).toEqual([[{ before: a, after: null }, { before: l, after: null }]]);
    expect(s.drawings).toEqual([c3]);
    expect(s.selection).toEqual([]);
    expect(commits).toEqual([
      { before: a, after: null },
      { before: l, after: null },
    ]);
    expect(s.undo()).toBe(true);
    expect(s.drawings).toEqual([a, l, c3]);
    expect(s.selection).toEqual(["a", "l"]);
    expect(s.redo()).toBe(true);
    expect(s.drawings).toEqual([c3]);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(false);
  });

  it("locks, unlocks and hides many as one undo step; a hidden one leaves the selection", () => {
    const { s, commits } = setup();
    const a = stored("a", 1, 10);
    const b = stored("b", 2, 20, true);
    s.reset([a, b]);
    s.setSelection(["a", "b"]);
    expect(s.updateMany(["a", "b"], { locked: true })).toBe(true);
    expect(commits).toHaveLength(1);
    expect(s.drawings.every((d) => d.locked)).toBe(true);
    expect(s.updateMany(["a", "b"], { locked: false })).toBe(true);
    expect(s.drawings.every((d) => !d.locked)).toBe(true);
    s.hover = { id: "a", part: "body" };
    expect(s.updateMany(["a", "b"], { hidden: true })).toBe(true);
    expect(s.drawings.every((d) => d.hidden)).toBe(true);
    expect(s.selection).toEqual([]);
    expect(s.hover).toBeNull();
    expect(s.drawings.filter((d) => d.hidden).length).toBe(2);
    // Undo shows and selects them again.
    expect(s.undo()).toBe(true);
    expect(s.drawings.filter((d) => d.hidden).length).toBe(0);
    expect(s.selection).toEqual(["a", "b"]);
    expect(s.redo()).toBe(true);
    expect(s.updateMany(["a"], { hidden: true })).toBe(false);
  });

  it("shows every hidden drawing again as one undo step", () => {
    const { s, commits } = setup();
    const h1 = { ...stored("h1", 1), hidden: true };
    const h2 = { ...stored("h2", 2), hidden: true };
    s.reset([h1, stored("v", 3), h2]);
    expect(s.showHidden()).toBe(true);
    expect(commits).toHaveLength(2);
    expect(s.drawings.filter((d) => d.hidden).length).toBe(0);
    expect(s.selection).toEqual(["h1", "h2"]);
    expect(s.showHidden()).toBe(false);
    expect(s.undo()).toBe(true);
    expect(s.drawings.filter((d) => d.hidden).length).toBe(2);
    expect(s.selection).toEqual([]);
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

describe("positions and notes", () => {
  it("places a long or a short with one click and its defaults", () => {
    const { s, commits } = setup();
    s.setTool("short");
    const d = s.place({ t: 2 * H, p: 1000 }, false, c)!;
    expect(d.body).toEqual({ kind: "position", side: "short", entry: { t: 2 * H, p: 1000 }, stop: 1015, take: 955, endT: 22 * H });
    expect(commits).toHaveLength(1);
    expect(s.tool).toBeNull();
  });

  it("keeps a new note as a draft until it has text, then stores and selects it", () => {
    const { s, commits, tools } = setup();
    s.setTool("note");
    const draft = s.place(A, false, c)!;
    expect(draft.body).toEqual({ kind: "note", t: 1 * H, text: "" });
    expect(s.draft).toBe(draft);
    expect(commits).toEqual([]);
    expect(s.drawings).toEqual([]);
    expect(s.tool).toBeNull();
    expect(tools).toEqual(["note", null]);
    const d = s.commitDraft({ kind: "note", t: 1 * H, text: "breakout" })!;
    expect(d).toMatchObject({ id: draft.id, body: { kind: "note", text: "breakout" } });
    expect(commits).toEqual([{ before: null, after: d }]);
    expect(s.draft).toBeNull();
    expect(s.selected).toBe(d.id);
    expect(s.commitDraft({ kind: "note", t: 1, text: "x" })).toBeNull();
  });

  it("drops the draft on Esc and on a new list", () => {
    const { s, commits } = setup();
    s.setTool("note");
    s.place(A, false, c);
    expect(s.cancel()).toBe(true);
    expect(s.draft).toBeNull();
    s.setTool("note");
    s.place(A, false, c);
    s.reset([]);
    expect(s.draft).toBeNull();
    expect(commits).toEqual([]);
  });
});

describe("a drawing the engine stored differently", () => {
  it("takes the stored copy in the list and in the history, without a new commit", () => {
    const { s, commits } = setup();
    s.reset([stored("a", 1, 50)]);
    const old = s.byId("a")!;
    s.edit("a", { kind: "hline", p: 60 });
    const sent = s.byId("a")!;
    // The engine had moved to four decimals: it stored 6000 at scale 4.
    const saved: Drawing = { ...sent, priceScale: 4, body: { kind: "hline", p: 6_000 }, updatedAt: 9 };
    expect(s.stored(sent, saved)).toBe(true);
    expect(s.byId("a")).toBe(saved);
    expect(commits).toHaveLength(1);
    // Undo goes back from the stored copy; redo brings the stored copy back.
    s.undo();
    expect(commits.at(-1)).toEqual({ before: saved, after: old });
    s.redo();
    expect(commits.at(-1)).toEqual({ before: old, after: saved });
    expect(s.byId("a")).toBe(saved);
  });

  it("fixes the step after it too, and ignores a copy that was changed since", () => {
    const { s, commits } = setup();
    s.reset([stored("a", 1, 50)]);
    s.edit("a", { kind: "hline", p: 60 });
    const sent = s.byId("a")!;
    s.edit("a", { kind: "hline", p: 70 });
    const later = s.byId("a")!;
    const saved: Drawing = { ...sent, priceScale: 4, body: { kind: "hline", p: 6_000 } };
    // The list holds a newer edit: it stays, but undoing that edit returns to the stored copy.
    expect(s.stored(sent, saved)).toBe(false);
    expect(s.byId("a")).toBe(later);
    s.undo();
    expect(commits.at(-1)).toEqual({ before: later, after: saved });
  });
});

describe("DrawingState with many drawings", () => {
  it("keeps selection checks constant-time with 2000 selected", () => {
    const { s } = setup();
    const list = Array.from({ length: 2000 }, (_, i) => stored(`d${i}`, i, i));
    s.reset(list);
    const t0 = performance.now();
    s.setSelection(list.map((d) => d.id));
    // A hit test asks every drawing whether it is selected, on every pointer move.
    let n = 0;
    for (let move = 0; move < 50; move++) for (const d of list) if (s.isSelected(d.id)) n++;
    expect(s.selectedDrawings()).toHaveLength(2000);
    for (const d of list) s.byId(d.id);
    const ms = performance.now() - t0;
    expect(n).toBe(100_000);
    // Linear scans take hundreds of ms here; a set and a map take a few.
    expect(ms).toBeLessThan(40);
  });
});
