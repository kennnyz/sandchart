import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drawing, DrawingBody, DrawingInput, InstrumentId, PositionBody, PositionOutcome, TimeframeCode } from "../backend/types";
import type { DrawingCommand, StyleAction, StyleEdit, TextEdit, TextResult } from "../chart/drawings/layer";
import type { ToolId } from "../chart/drawings/registry";
import type { DrawingChange } from "../chart/drawings/state";
import { DrawingController, type DrawingSurface, type MagnetPref } from "./drawings";

const BTC = { source: "mock", symbol: "BTCUSDT" };
const ETH = { source: "mock", symbol: "ETHUSDT" };

function drawing(id: string, p = 100, instrument: InstrumentId = BTC, body?: DrawingBody): Drawing {
  return {
    id,
    instrument,
    priceScale: 2,
    body: body ?? { kind: "hline", p },
    style: { color: 0, width: 2, dash: false },
    locked: false,
    z: 1,
    updatedAt: 5,
  };
}

/** A chart stand-in that records what the controller sets on it. */
function fakeSurface() {
  const sets: Drawing[][] = [];
  const tools: (ToolId | null)[] = [];
  const commands: DrawingCommand[] = [];
  const magnets: boolean[] = [];
  const outcomes: Map<string, PositionOutcome>[] = [];
  const texts: TextResult[] = [];
  const styles: StyleAction[] = [];
  const hidden: boolean[] = [];
  let style: ((e: StyleEdit | null) => void) | null = null;
  let commit: ((c: DrawingChange) => void) | null = null;
  let tool: ((k: ToolId | null) => void) | null = null;
  let text: ((e: TextEdit | null) => void) | null = null;
  const surface: DrawingSurface = {
    setDrawings: (list) => sets.push(list),
    setDrawingMagnet: (on) => magnets.push(on),
    setDrawingTool: (k) => {
      tools.push(k);
      tool?.(k);
    },
    drawingCommand: (c) => {
      commands.push(c);
      return c !== "redo";
    },
    setPositionOutcomes: (m) => outcomes.push(new Map(m)),
    finishDrawingText: (r) => {
      texts.push(r);
      text?.(null);
    },
    onDrawingCommit: (cb) => (commit = cb),
    onDrawingTool: (cb) => (tool = cb),
    onDrawingText: (cb) => (text = cb),
    drawingStyle: (a) => styles.push(a),
    setDrawingsHidden: (on) => hidden.push(on),
    onDrawingStyle: (cb) => (style = cb),
  };
  return {
    surface,
    sets,
    tools,
    commands,
    magnets,
    outcomes,
    texts,
    styles,
    hidden,
    openStyle: (e: StyleEdit | null) => style!(e),
    commit: (c: DrawingChange) => commit!(c),
    openText: (e: TextEdit | null) => text!(e),
    hasListeners: () => commit !== null || text !== null,
  };
}

interface Pending {
  resolve: () => void;
  reject: (e: unknown) => void;
}

/** A backend whose saves and deletes wait until the test settles them. */
function fakeBackend(stored: Drawing[]) {
  const calls: string[] = [];
  const pending: Pending[] = [];
  const loads: { id: InstrumentId; resolve: (l: Drawing[]) => void }[] = [];
  const resolves: {
    tf: TimeframeCode;
    positions: { id: string; position: PositionBody }[];
    resolve: (r: { id: string; outcome: PositionOutcome }[]) => void;
  }[] = [];
  const wait = () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  const backend = {
    getDrawings: (id: InstrumentId) => {
      calls.push(`get ${id.symbol}`);
      return new Promise<Drawing[]>((resolve) => loads.push({ id, resolve }));
    },
    saveDrawing: async (d: DrawingInput) => {
      calls.push(`save ${d.id} ${JSON.stringify(Object.keys(d).sort())}`);
      await wait();
      return { ...d, priceScale: 2, updatedAt: 9 };
    },
    deleteDrawing: async (id: string) => {
      calls.push(`delete ${id}`);
      await wait();
    },
    getPositionOutcomes: (_id: InstrumentId, tf: TimeframeCode, positions: { id: string; position: PositionBody }[]) =>
      new Promise<{ id: string; outcome: PositionOutcome }[]>((resolve) => resolves.push({ tf, positions, resolve })),
  };
  return { backend, calls, pending, loads, stored, resolves };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe("DrawingController", () => {
  it("clears the chart, then shows the instrument's drawings; a late answer for another one is dropped", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    void c.open(ETH);
    await flush();
    expect(s.sets).toEqual([[], []]);
    b.loads[1]!.resolve([drawing("e", 1, ETH)]);
    b.loads[0]!.resolve([drawing("b")]);
    await flush();
    expect(s.sets).toEqual([[], [], [drawing("e", 1, ETH)]]);
  });

  it("stores every change in order, without the fields the engine sets", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    const d = drawing("x");
    s.commit({ before: null, after: d });
    s.commit({ before: d, after: null });
    await flush();
    expect(b.calls).toEqual([`save x ${JSON.stringify(["body", "id", "instrument", "locked", "style", "z"])}`]);
    b.pending[0]!.resolve();
    await flush();
    expect(b.calls.at(-1)).toBe("delete x");
  });

  it("loads only after the changes before it are stored", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    s.commit({ before: null, after: drawing("x") });
    void c.open(BTC);
    await flush();
    expect(b.calls).toHaveLength(1);
    b.pending[0]!.resolve();
    await flush();
    expect(b.calls.at(-1)).toBe("get BTCUSDT");
  });

  it("reloads from the backend when a change could not be stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    b.loads[0]!.resolve([]);
    await flush();
    s.commit({ before: null, after: drawing("x") });
    await flush();
    b.pending[0]!.reject({ code: "other", message: "disk full" });
    await flush();
    expect(b.calls.at(-1)).toBe("get BTCUSDT");
    b.loads[1]!.resolve([drawing("y")]);
    await flush();
    // No blank frame before a reload: the list is replaced at once.
    expect(s.sets).toEqual([[], [], [drawing("y")]]);
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps the error of a failed store until a later one succeeds or another instrument opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    b.loads[0]!.resolve([]);
    s.commit({ before: drawing("x"), after: null });
    await flush();
    b.pending[0]!.reject({ code: "other", message: "disk full" });
    await flush();
    expect(c.error).toBe("disk full");
    b.loads[1]!.resolve([]);
    s.commit({ before: null, after: drawing("y") });
    await flush();
    b.pending[1]!.resolve();
    await flush();
    expect(c.error).toBeNull();

    s.commit({ before: null, after: drawing("z") });
    await flush();
    b.pending[2]!.reject(new Error("locked"));
    await flush();
    expect(c.error).toBe("locked");
    void c.open(ETH);
    expect(c.error).toBeNull();
  });

  it("mirrors the style popover and passes its actions to the chart", () => {
    const s = fakeSurface();
    let changes = 0;
    const c = new DrawingController(fakeBackend([]).backend, () => changes++);
    c.attach(s.surface);
    const edit = { drawing: drawing("x"), x: 10, y: 20 };
    s.openStyle(edit);
    expect(c.styleEdit).toEqual(edit);
    expect(changes).toBe(1);
    c.restyle({ locked: true });
    c.deleteStyled();
    c.closeStyle();
    expect(s.styles).toEqual([{ patch: { locked: true } }, { delete: true }, null]);
    s.openStyle(null);
    expect(c.styleEdit).toBeNull();
  });

  it("hides all for the session, and picking a tool shows them again", () => {
    const s = fakeSurface();
    const c = new DrawingController(fakeBackend([]).backend, () => {});
    c.attach(s.surface);
    expect(s.hidden).toEqual([false]);
    c.toggleHidden();
    expect(c.hidden).toBe(true);
    c.toggleTool("trend");
    expect(c.hidden).toBe(false);
    expect(s.hidden).toEqual([false, true, false]);
    expect(s.tools).toEqual(["trend"]);
    // A chart attached later starts hidden too.
    c.toggleHidden();
    const t = fakeSurface();
    c.attach(t.surface);
    expect(t.hidden).toEqual([true]);
  });

  it("mirrors the chart's tool, toggles it and passes commands on", () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const changed = vi.fn();
    const c = new DrawingController(b.backend, changed);
    // Without a chart nothing happens.
    c.toggleTool("trend");
    expect(c.command("undo")).toBe(false);
    const detach = c.attach(s.surface);
    c.toggleTool("trend");
    expect(c.tool).toBe("trend");
    c.toggleTool("trend");
    expect(c.tool).toBeNull();
    c.toggleTool("hline");
    expect(s.tools).toEqual(["trend", null, "hline"]);
    expect(changed).toHaveBeenCalled();
    expect(c.command("undo")).toBe(true);
    expect(c.command("redo")).toBe(false);
    expect(s.commands).toEqual(["undo", "redo"]);
    detach();
    expect(c.tool).toBeNull();
    expect(s.hasListeners()).toBe(false);
  });

  it("toggles the magnet, keeps the choice and sets it on every chart it attaches", () => {
    const saved: boolean[] = [];
    const pref: MagnetPref = { load: () => true, save: (on) => saved.push(on) };
    const changed = vi.fn();
    const c = new DrawingController(fakeBackend([]).backend, changed, pref);
    expect(c.magnet).toBe(true);
    const s = fakeSurface();
    c.attach(s.surface);
    expect(s.magnets).toEqual([true]);
    c.toggleMagnet();
    expect(c.magnet).toBe(false);
    expect(s.magnets).toEqual([true, false]);
    expect(saved).toEqual([false]);
    expect(changed).toHaveBeenCalled();
    // Off by default, and without a chart it is only remembered.
    const d = new DrawingController(fakeBackend([]).backend, () => {}, { load: () => null, save: (on) => saved.push(on) });
    expect(d.magnet).toBe(false);
    d.toggleMagnet();
    expect(d.magnet).toBe(true);
    expect(saved).toEqual([false, true]);
  });

  it("passes the chart's text editor to the popover and its answer back", () => {
    const s = fakeSurface();
    const changed = vi.fn();
    const c = new DrawingController(fakeBackend([]).backend, changed);
    c.attach(s.surface);
    const edit: TextEdit = { id: "n", text: "", isNew: true, x: 1, y: 2 };
    s.openText(edit);
    expect(c.textEdit).toEqual(edit);
    expect(changed).toHaveBeenCalled();
    c.saveText("hello");
    expect(c.textEdit).toBeNull();
    s.openText(edit);
    c.deleteText();
    s.openText(edit);
    c.cancelText();
    expect(s.texts).toEqual([{ text: "hello" }, { delete: true }, null]);
  });
});

describe("position outcomes", () => {
  const H = 3_600_000;
  const pos = (stop = 90, take = 130): DrawingBody => ({
    kind: "position",
    side: "long",
    entry: { t: 10 * H, p: 100 },
    stop,
    take,
    endT: 30 * H,
  });
  const TAKE: PositionOutcome = { status: "take", exitTime: 12 * H, ambiguous: false, r: 3 };
  const STOP: PositionOutcome = { status: "stop", exitTime: 11 * H, ambiguous: false, r: -1 };

  async function loaded(list: Drawing[]) {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    b.loads[0]!.resolve(list);
    await flush();
    return { b, s, c };
  }

  it("asks for every position in one call once drawings and candles are there", async () => {
    const { b, s, c } = await loaded([drawing("p1", 0, BTC, pos()), drawing("h"), drawing("p2", 0, BTC, pos(80))]);
    // No timeframe yet: nothing to ask.
    expect(b.resolves).toHaveLength(0);
    c.candles(BTC, "1h", 0, 100 * H);
    expect(b.resolves).toHaveLength(1);
    expect(b.resolves[0]!.tf).toBe("1h");
    expect(b.resolves[0]!.positions.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(b.resolves[0]!.positions[0]!.position).toEqual({ side: "long", entry: { t: 10 * H, p: 100 }, stop: 90, take: 130, endT: 30 * H });
    b.resolves[0]!.resolve([
      { id: "p1", outcome: TAKE },
      { id: "p2", outcome: STOP },
    ]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", TAKE], ["p2", STOP]]));
    // The same candles again (a live tick): no new call. A new bar, another timeframe or another instrument's candles:
    c.candles(BTC, "1h", 0, 100 * H);
    expect(b.resolves).toHaveLength(1);
    c.candles(ETH, "1h", 0, 101 * H);
    expect(b.resolves).toHaveLength(1);
    c.candles(BTC, "1h", 0, 101 * H);
    expect(b.resolves).toHaveLength(2);
    c.candles(BTC, "4h", 0, 101 * H);
    // Another timeframe: the old outcomes go at once.
    expect(s.outcomes.at(-1)).toEqual(new Map());
    expect(b.resolves.at(-1)!.tf).toBe("4h");
  });

  it("drops the outcome of a moved position at once and asks again", async () => {
    const { b, s, c } = await loaded([drawing("p1", 0, BTC, pos()), drawing("p2", 0, BTC, pos(80))]);
    c.candles(BTC, "1h", 0, 100 * H);
    b.resolves[0]!.resolve([
      { id: "p1", outcome: TAKE },
      { id: "p2", outcome: STOP },
    ]);
    await flush();
    const before = drawing("p1", 0, BTC, pos());
    s.commit({ before, after: { ...before, body: pos(95) } });
    expect(s.outcomes.at(-1)).toEqual(new Map([["p2", STOP]]));
    expect(b.resolves).toHaveLength(2);
    expect(b.resolves[1]!.positions.find((p) => p.id === "p1")!.position.stop).toBe(95);
    b.resolves[1]!.resolve([
      { id: "p1", outcome: STOP },
      { id: "p2", outcome: STOP },
    ]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", STOP], ["p2", STOP]]));
  });

  it("never shows an answer for a body that changed while it was asked for", async () => {
    const { b, s, c } = await loaded([drawing("p1", 0, BTC, pos())]);
    c.candles(BTC, "1h", 0, 100 * H);
    const before = drawing("p1", 0, BTC, pos());
    s.commit({ before, after: { ...before, body: pos(95) } });
    // The first answer is for the old body and arrives late: dropped.
    b.resolves[0]!.resolve([{ id: "p1", outcome: TAKE }]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map());
    b.resolves[1]!.resolve([{ id: "p1", outcome: STOP }]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", STOP]]));
    // Deleted: its outcome goes, and there is nothing left to ask.
    s.commit({ before: { ...before, body: pos(95) }, after: null });
    expect(s.outcomes.at(-1)).toEqual(new Map());
    expect(b.resolves).toHaveLength(2);
  });

  it("starts over on another instrument", async () => {
    const { b, s, c } = await loaded([drawing("p1", 0, BTC, pos())]);
    c.candles(BTC, "1h", 0, 100 * H);
    b.resolves[0]!.resolve([{ id: "p1", outcome: TAKE }]);
    await flush();
    void c.open(ETH);
    expect(s.outcomes.at(-1)).toEqual(new Map());
    await flush();
    b.loads[1]!.resolve([]);
    await flush();
    c.candles(ETH, "1h", 0, 100 * H);
    expect(b.resolves).toHaveLength(1);
  });
});
