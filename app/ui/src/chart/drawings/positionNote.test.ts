import { describe, expect, it } from "vitest";
import type { Anchor, DrawingBody } from "../../backend/types";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import { toolById, toolFor, type Mover } from "./registry";
import { clampNoteText, firstLine, NOTE_MAX_BYTES, noteBytes } from "./tools/note";
import { defaultPosition, positionStats } from "./tools/position";

const H = 3_600_000;
const times = new Float64Array(Array.from({ length: 100 }, (_, i) => i * H));
// Prices of bar i: open 100 + i, high 200 + i, low i, close 150 + i.
const ohlc = {
  open: Array.from({ length: 100 }, (_, i) => 100 + i),
  high: Array.from({ length: 100 }, (_, i) => 200 + i),
  low: Array.from({ length: 100 }, (_, i) => i),
  close: Array.from({ length: 100 }, (_, i) => 150 + i),
};
// 100 hourly bars, 10 px each, the last at x = 1000; prices 0..10 000 ticks over 1000 px.
const scale = new PriceScale(0, 10_000, 1000, "linear");
const c = new Coords(times, 100, { barWidth: 10, rightIndex: 99 }, scale, 1000, 1000, H, 2, ohlc);
const at = (x: number, y: number): Anchor => ({ t: c.t(x), p: c.p(y) });
const mover = (dx: number, dy: number): Mover => ({
  anchor: (a) => ({ t: c.t(c.x(a.t) + dx), p: c.p(c.y(a.p) + dy) }),
  price: (p) => c.p(c.y(p) + dy),
});

type Position = Extract<DrawingBody, { kind: "position" }>;
type Note = Extract<DrawingBody, { kind: "note" }>;

const long = (): Position => ({ kind: "position", side: "long", entry: { t: 50 * H, p: 5000 }, stop: 4000, take: 8000, endT: 70 * H });
const short = (): Position => ({ kind: "position", side: "short", entry: { t: 50 * H, p: 5000 }, stop: 6000, take: 2000, endT: 70 * H });

describe("position tools", () => {
  it("are two rail entries for one kind, with their own shortcuts", () => {
    expect(toolById("long")).toMatchObject({ kind: "position", code: "KeyL", placement: { clicks: 1 } });
    expect(toolById("short")).toMatchObject({ kind: "position", code: "KeyS", placement: { clicks: 1 } });
    expect(toolFor("position")).toBe(toolById("long"));
  });

  it("places a long with the stop 1.5 % below, the take at 3R and the end 20 bars later", () => {
    const entry = { t: 50 * H, p: 10_000 };
    expect(toolById("long")!.create([entry], c)).toEqual({
      kind: "position",
      side: "long",
      entry,
      stop: 9_850,
      take: 10_450,
      endT: 70 * H,
    });
    expect(defaultPosition("short", entry, H)).toEqual({
      kind: "position",
      side: "short",
      entry,
      stop: 10_150,
      take: 9_550,
      endT: 70 * H,
    });
    // A tiny price still gets a risk of one tick.
    expect(defaultPosition("long", { t: 0, p: 10 }, H)).toMatchObject({ stop: 9, take: 13 });
    // On 1M the end is 20 calendar months later, not 20 x 30 days.
    const jan15 = Date.UTC(2026, 0, 15);
    expect(defaultPosition("long", { t: jan15, p: 10_000 }, "month").endT).toBe(Date.UTC(2027, 8, 15));
  });

  it("works out the label numbers", () => {
    expect(positionStats(long())).toEqual({ take: "+60.00%", stop: "−20.00%", rr: "3.0" });
    expect(positionStats(short())).toEqual({ take: "+60.00%", stop: "−20.00%", rr: "3.0" });
    expect(positionStats({ ...long(), stop: 4985, take: 5022 })).toEqual({ take: "+0.44%", stop: "−0.30%", rr: "1.5" });
  });

  it("measures a replay trade's take and stop in R of the stop at entry, not of the moved stop", () => {
    // Entry 100, stop at entry 90 (risk 10), take 120; the stop widened to 84.
    const b = { kind: "position" as const, side: "long" as const, entry: { t: 0, p: 100 }, stop: 84, take: 120, endT: H };
    expect(positionStats(b)).toMatchObject({ rr: "1.3" });
    expect(positionStats(b, 90)).toEqual({ take: "+20.00%", stop: "−16.00%", rr: "1.3", takeR: "+2.0R", stopR: "−1.6R" });
    // A short, its stop moved to the entry: a stop there is 0R.
    const s = { ...b, side: "short" as const, stop: 100, take: 80 };
    expect(positionStats(s, 110)).toMatchObject({ takeR: "+2.0R", stopR: "0.0R" });
  });

  it("spans entry to end and is hit inside its zones", () => {
    const tool = toolFor("position")!;
    expect(tool.timeSpan(long())).toEqual([50 * H, 70 * H]);
    const g = tool.layout(long(), c);
    // Entry at x 510, end at x 710; take y 200, entry y 500, stop y 600.
    expect(tool.hitTest(g, 600, 300, 6)).toBe(true);
    expect(tool.hitTest(g, 600, 590, 6)).toBe(true);
    expect(tool.hitTest(g, 600, 650, 6)).toBe(false);
    expect(tool.hitTest(g, 400, 300, 6)).toBe(false);
    expect(tool.hitTest(g, 714, 300, 6)).toBe(true);
    expect(tool.handles(g)).toEqual([
      { x: 610, y: 600 },
      { x: 610, y: 200 },
      { x: 510, y: 500 },
      { x: 710, y: 500 },
    ]);
  });

  it("clamps the stop and the take to their side of the entry", () => {
    const tool = toolFor("position")!;
    const l = long();
    expect(tool.moveHandle(l, 0, { t: 0, p: 4500 }, false)).toEqual({ ...l, stop: 4500 });
    expect(tool.moveHandle(l, 0, { t: 0, p: 7000 }, false)).toEqual({ ...l, stop: 4999 });
    expect(tool.moveHandle(l, 1, { t: 0, p: 9000 }, false)).toEqual({ ...l, take: 9000 });
    expect(tool.moveHandle(l, 1, { t: 0, p: 100 }, false)).toEqual({ ...l, take: 5001 });
    const s = short();
    expect(tool.moveHandle(s, 0, { t: 0, p: 3000 }, false)).toEqual({ ...s, stop: 5001 });
    expect(tool.moveHandle(s, 1, { t: 0, p: 9000 }, false)).toEqual({ ...s, take: 4999 });
    expect(tool.moveHandle(s, 1, { t: 0, p: 1000 }, false)).toEqual({ ...s, take: 1000 });
  });

  it("moves the entry price between stop and take, which keep their prices", () => {
    const tool = toolFor("position")!;
    const l = long();
    expect(tool.moveHandle(l, 2, { t: 99 * H, p: 6000 }, false)).toEqual({ ...l, entry: { t: l.entry.t, p: 6000 } });
    expect(tool.moveHandle(l, 2, { t: 0, p: 9000 }, false)).toEqual({ ...l, entry: { t: l.entry.t, p: 7999 } });
    expect(tool.moveHandle(l, 2, { t: 0, p: 0 }, false)).toEqual({ ...l, entry: { t: l.entry.t, p: 4001 } });
    const s = short();
    expect(tool.moveHandle(s, 2, { t: 0, p: 9000 }, false)).toEqual({ ...s, entry: { t: s.entry.t, p: 5999 } });
    // No room between stop and take: nothing changes.
    const tight = { ...l, stop: 4999, take: 5001 };
    expect(tool.moveHandle(tight, 2, { t: 0, p: 7000 }, false)).toEqual({ ...tight, entry: { t: l.entry.t, p: 5000 } });
  });

  it("moves the end, never to or before the entry", () => {
    const tool = toolFor("position")!;
    const l = long();
    expect(tool.moveHandle(l, 3, { t: 80 * H, p: 1 }, false)).toEqual({ ...l, endT: 80 * H });
    expect(tool.moveHandle(l, 3, { t: 10 * H, p: 1 }, false)).toEqual({ ...l, endT: 50 * H + 1 });
  });

  it("moves rigidly with the body", () => {
    const tool = toolFor("position")!;
    // 100 px right and 50 px up: 10 bars later and 500 ticks higher.
    expect(tool.moveBy(long(), mover(100, -50))).toEqual({
      kind: "position",
      side: "long",
      entry: { t: 60 * H, p: 5500 },
      stop: 4500,
      take: 8500,
      endT: 80 * H,
    });
  });

  it("lays out the outcome only when it is given", () => {
    const tool = toolFor("position")!;
    const none = tool.layout(long(), c) as { outcome: unknown };
    expect(none.outcome).toBeNull();
    const g = tool.layout(long(), c, { status: "take", exitTime: 60 * H, ambiguous: false, r: 3 }) as {
      outcome: { status: string; r: string | null; x: number | null; y: number; ambiguous: boolean };
    };
    expect(g.outcome).toEqual({ status: "take", r: "+3.0R", x: 610, y: 200, ambiguous: false });
    const stop = tool.layout(long(), c, { status: "stop", exitTime: 55 * H, ambiguous: true, r: -1 }) as typeof g;
    expect(stop.outcome).toEqual({ status: "stop", r: "−1.0R", x: 560, y: 600, ambiguous: true });
    const open = tool.layout(long(), c, { status: "open", exitTime: null, ambiguous: false, r: 0 }) as typeof g;
    expect(open.outcome).toEqual({ status: "open", r: null, x: null, y: 500, ambiguous: false });
  });

  it("tags entry, stop and take on the price axis", () => {
    expect(toolFor("position")!.axisPrices!(long())).toEqual([5000, 4000, 8000]);
  });
});

describe("note", () => {
  const tool = toolById("note")!;
  const note = (t: number, text = "hi"): Note => ({ kind: "note", t, text });

  it("is placed with one click at the open time of the bar under it, with no text yet", () => {
    expect(tool.placement).toEqual({ clicks: 1 });
    expect(tool.code).toBe("KeyN");
    // x 507 is in the slot of bar 50 (x 505..515), its time a little after the open.
    expect(tool.create([at(507, 500)], c)).toEqual({ kind: "note", t: 50 * H, text: "" });
    expect(tool.create([at(506, 500)], c)).toEqual({ kind: "note", t: 50 * H, text: "" });
    expect(tool.create([at(516, 500)], c)).toEqual({ kind: "note", t: 51 * H, text: "" });
    // Past the last bar it still lands on a bar time.
    expect(tool.create([at(1043, 500)], c)).toEqual({ kind: "note", t: 103 * H, text: "" });
  });

  it("sits above the high of the bar that contains its time, or at the top without that bar", () => {
    const g = tool.layout(note(50 * H), c) as { x: number; y: number };
    // Bar 50: x 510, high 250 ticks at y 975.
    expect(g.x).toBe(510);
    expect(g.y).toBeLessThan(975);
    expect(g.y).toBeGreaterThan(955);
    // A time inside bar 50 (a note made on a lower timeframe) sits on bar 50 too.
    expect(tool.layout(note(50 * H + 1_800_000), c)).toMatchObject({ x: 510, y: g.y });
    const future = tool.layout(note(120 * H), c) as { x: number; y: number };
    expect(future.x).toBe(1210);
    expect(future.y).toBeLessThan(20);
  });

  it("is hit on its marker and opens the editor there", () => {
    const g = tool.layout(note(50 * H), c) as { x: number; y: number };
    expect(tool.hitTest(g, g.x + 5, g.y, 6)).toBe(true);
    expect(tool.hitTest(g, g.x, g.y + 20, 6)).toBe(false);
    expect(tool.handles(g)).toEqual([]);
    expect(tool.text!.at(g)).toEqual({ x: g.x, y: g.y });
    expect(tool.text!.get(note(1, "abc"))).toBe("abc");
    expect(tool.text!.set(note(1, "abc"), "xyz")).toEqual(note(1, "xyz"));
  });

  it("counts and limits its text in UTF-8 bytes", () => {
    expect(NOTE_MAX_BYTES).toBe(2000);
    expect(noteBytes("abc")).toBe(3);
    expect(noteBytes("я")).toBe(2);
    expect(clampNoteText("a".repeat(2001))).toBe("a".repeat(2000));
    // A two-byte letter is never cut in half.
    expect(clampNoteText("я".repeat(1001))).toBe("я".repeat(1000));
    expect(clampNoteText("a" + "я".repeat(1000))).toBe("a" + "я".repeat(999));
    const emoji = "😀".repeat(501);
    expect(noteBytes(clampNoteText(emoji))).toBe(2000);
    expect(clampNoteText("short")).toBe("short");
  });

  it("shows the first line as its tooltip", () => {
    expect(firstLine("first\nsecond")).toBe("first");
    expect(firstLine("x".repeat(100))).toBe("x".repeat(79) + "…");
    expect(firstLine("\n\nlater")).toBe("later");
  });
});
