import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drawing, DrawingBody, DrawingInput, InstrumentId, PositionBody, PositionOutcome, TimeframeCode } from "../backend/types";
import type { DrawingCommand, MenuAction, MenuEdit, StyleAction, StyleEdit, TextEdit, TextResult } from "../chart/drawings/layer";
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
    hidden: false,
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
  const storedCopies: [Drawing, Drawing][] = [];
  const menus: MenuAction[] = [];
  let showHidden = 0;
  let menu: ((e: MenuEdit | null) => void) | null = null;
  let style: ((e: StyleEdit | null) => void) | null = null;
  let commit: ((step: DrawingChange[]) => void) | null = null;
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
    drawingStored: (sent, saved) => storedCopies.push([sent, saved]),
    onDrawingStyle: (cb) => (style = cb),
    drawingMenu: (a) => menus.push(a),
    showHiddenDrawings: () => {
      showHidden++;
    },
    onDrawingMenu: (cb) => (menu = cb),
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
    storedCopies,
    menus,
    showHiddenCalls: () => showHidden,
    openMenu: (e: MenuEdit | null) => menu!(e),
    openStyle: (e: StyleEdit | null) => style!(e),
    /** One undo step: a single change or all of a group's. */
    commit: (c: DrawingChange | DrawingChange[]) => commit!(Array.isArray(c) ? c : [c]),
    openText: (e: TextEdit | null) => text!(e),
    hasListeners: () => commit !== null || text !== null,
  };
}

interface Pending {
  resolve: () => void;
  reject: (e: unknown) => void;
}

/** A backend whose saves and deletes wait until the test settles them. */
function fakeBackend(stored: Drawing[], scale = 2) {
  const calls: string[] = [];
  const pending: Pending[] = [];
  const loads: { id: InstrumentId; resolve: (l: Drawing[]) => void; reject: (e: unknown) => void }[] = [];
  const resolves: {
    tf: TimeframeCode;
    positions: { id: string; position: PositionBody }[];
    resolve: (r: { id: string; outcome: PositionOutcome }[]) => void;
  }[] = [];
  const wait = () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  const backend = {
    getDrawings: (id: InstrumentId) => {
      calls.push(`get ${id.symbol}`);
      return new Promise<Drawing[]>((resolve, reject) => loads.push({ id, resolve, reject }));
    },
    saveDrawings: async (list: DrawingInput[]) => {
      calls.push(`save ${list.map((d) => d.id).join(",")} ${JSON.stringify(Object.keys(list[0]!).sort())}`);
      await wait();
      // At another scale the engine rescales (here: one decimal more, ×10).
      return list.map((d) => {
        const body = d.priceScale === scale || d.body.kind !== "hline" ? d.body : { ...d.body, p: d.body.p * 10 };
        return { ...d, priceScale: scale, body, updatedAt: 9 };
      });
    },
    deleteDrawings: async (ids: string[]) => {
      calls.push(`delete ${ids.join(",")}`);
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
  it("clears the chart, then shows the instrument's drawings", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    void c.open(ETH);
    await flush();
    // BTC was left before its request went out.
    expect(b.calls).toEqual(["get ETHUSDT"]);
    b.loads[0]!.resolve([drawing("e", 1, ETH)]);
    await flush();
    expect(s.sets).toEqual([[], [], [drawing("e", 1, ETH)]]);
  });

  it("drops a late answer for an instrument that was left", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    void c.open(ETH);
    await flush();
    expect(s.sets).toEqual([[], []]);
    b.loads[1]!.resolve([drawing("e", 1, ETH)]);
    b.loads[0]!.resolve([drawing("b")]);
    await flush();
    expect(s.sets).toEqual([[], [], [drawing("e", 1, ETH)]]);
  });

  it("stores every change in order, with its price scale and without the update time", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    const d = drawing("x");
    s.commit({ before: null, after: d });
    s.commit({ before: d, after: null });
    await flush();
    expect(b.calls).toEqual([`save x ${JSON.stringify(["body", "hidden", "id", "instrument", "locked", "priceScale", "style", "z"])}`]);
    b.pending[0]!.resolve();
    await flush();
    expect(b.calls.at(-1)).toBe("delete x");
  });

  it("puts the engine's copy on the chart when it stored the drawing at a new price scale", async () => {
    const b = fakeBackend([], 3);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    const d = drawing("x", 100);
    s.commit({ before: null, after: d });
    await flush();
    b.pending[0]!.resolve();
    await flush();
    expect(s.storedCopies).toEqual([[d, { ...d, priceScale: 3, body: { kind: "hline", p: 1_000 }, updatedAt: 9 }]]);
    // Stored at the scale it was sent with: the chart keeps its own copy.
    const same = fakeBackend([]);
    const t = fakeSurface();
    new DrawingController(same.backend, () => {}).attach(t.surface);
    t.commit({ before: null, after: drawing("y") });
    await flush();
    same.pending[0]!.resolve();
    await flush();
    expect(t.storedCopies).toEqual([]);
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

  it("shows the error when the drawings cannot be loaded, and loads again once a change is stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    b.loads[0]!.reject({ code: "other", message: "database is locked" });
    await flush();
    expect(c.error).toEqual({ kind: "load", message: "database is locked" });
    expect(s.sets.at(-1)).toEqual([]);
    // The chart is not what is stored: the next stored change brings the full list back.
    s.commit({ before: null, after: drawing("x") });
    await flush();
    b.pending[0]!.resolve();
    await flush();
    expect(c.error).toBeNull();
    expect(b.calls.at(-1)).toBe("get BTCUSDT");
    b.loads[1]!.resolve([drawing("a"), drawing("x")]);
    await flush();
    expect(s.sets.at(-1)).toEqual([drawing("a"), drawing("x")]);
  });

  it("never keeps an unsaved drawing on the chart when the reload after a failed save fails too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    b.loads[0]!.resolve([drawing("a")]);
    await flush();
    s.commit({ before: null, after: drawing("x") });
    await flush();
    b.pending[0]!.reject({ code: "other", message: "disk full" });
    await flush();
    b.loads[1]!.reject({ code: "other", message: "disk gone" });
    await flush();
    expect(c.error).toEqual({ kind: "load", message: "disk gone" });
    expect(s.sets.at(-1)).toEqual([]);
  });

  it("loads again when a change was made while the list was on its way", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    // Drawn on the still empty chart while the list is asked for: its save waits.
    s.commit({ before: null, after: drawing("x") });
    b.loads[0]!.resolve([drawing("a")]);
    await flush();
    // The answer does not have "x" yet: it is dropped instead of wiping "x" and the undo history.
    expect(s.sets).toEqual([[]]);
    expect(b.calls).toEqual(["get BTCUSDT", `save x ${JSON.stringify(["body", "hidden", "id", "instrument", "locked", "priceScale", "style", "z"])}`]);
    b.pending[0]!.resolve();
    await flush();
    expect(b.calls.at(-1)).toBe("get BTCUSDT");
    b.loads[1]!.resolve([drawing("a"), drawing("x")]);
    await flush();
    expect(s.sets).toEqual([[], [drawing("a"), drawing("x")]]);
  });

  it("gives up waiting for a quiet moment after a few tries and shows what is stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    for (let i = 0; i < 10; i++) {
      await flush();
      if (b.loads.length <= i) break;
      s.commit({ before: null, after: drawing(`x${i}`) });
      b.loads[i]!.resolve([drawing(`seen${i}`)]);
      await flush();
      b.pending[i]!.resolve();
    }
    await flush();
    expect(b.loads.length).toBeLessThanOrEqual(4);
    expect(s.sets.at(-1)).toEqual([drawing(`seen${b.loads.length - 1}`)]);
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
    expect(c.error).toEqual({ kind: "save", message: "disk full" });
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
    expect(c.error).toEqual({ kind: "save", message: "locked" });
    void c.open(ETH);
    expect(c.error).toBeNull();
  });

  it("stores a group step in one call, and a failed one reloads what is stored and shows why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    const [x, y] = [drawing("x", 1), drawing("y", 2)];
    b.loads[0]!.resolve([x, y]);
    await flush();
    s.commit([
      { before: x, after: { ...x, body: { kind: "hline", p: 11 } } },
      { before: y, after: { ...y, body: { kind: "hline", p: 12 } } },
    ]);
    await flush();
    expect(b.calls.at(-1)).toMatch(/^save x,y /);
    b.pending[0]!.resolve();
    await flush();

    s.commit([
      { before: x, after: null },
      { before: y, after: null },
    ]);
    await flush();
    expect(b.calls.at(-1)).toBe("delete x,y");
    expect(b.calls.filter((l) => l.startsWith("delete"))).toHaveLength(1);
    b.pending[1]!.reject({ code: "other", message: "disk full" });
    await flush();
    expect(c.error).toEqual({ kind: "save", message: "disk full" });
    expect(b.calls.at(-1)).toBe("get BTCUSDT");
    // Nothing of the step was stored: the chart gets both back.
    b.loads[1]!.resolve([x, y]);
    await flush();
    expect(s.sets.at(-1)).toEqual([x, y]);
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

  it("mirrors the context menu and passes its items to the chart", () => {
    const s = fakeSurface();
    const c = new DrawingController(fakeBackend([]).backend, () => {});
    c.attach(s.surface);
    const edit = { ids: ["a", "b"], locked: false, single: false, x: 5, y: 6 };
    s.openMenu(edit);
    expect(c.menu).toEqual(edit);
    c.menuAction("lock");
    c.menuAction(null);
    expect(s.menus).toEqual(["lock", null]);
    s.openMenu(null);
    expect(c.menu).toBeNull();
  });

  it("counts the drawings hidden one by one, and shows them with hide all turned off", async () => {
    const b = fakeBackend([]);
    const s = fakeSurface();
    const c = new DrawingController(b.backend, () => {});
    c.attach(s.surface);
    void c.open(BTC);
    await flush();
    b.loads[0]!.resolve([{ ...drawing("h"), hidden: true }, drawing("v")]);
    await flush();
    expect(c.hiddenCount).toBe(1);
    const v = drawing("v");
    s.commit({ before: v, after: { ...v, hidden: true } });
    expect(c.hiddenCount).toBe(2);
    s.commit({ before: { ...v, hidden: true }, after: null });
    expect(c.hiddenCount).toBe(1);
    c.toggleHidden();
    c.showHidden();
    expect(c.hidden).toBe(false);
    expect(s.showHiddenCalls()).toBe(1);
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
  const OPEN: PositionOutcome = { status: "open", exitTime: null, ambiguous: false, r: 0 };

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
      { id: "p2", outcome: OPEN },
    ]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", TAKE], ["p2", OPEN]]));
    // The same candles again (a live tick): no new call. Another instrument's candles: none either.
    c.candles(BTC, "1h", 0, 100 * H);
    expect(b.resolves).toHaveLength(1);
    c.candles(ETH, "1h", 0, 101 * H);
    expect(b.resolves).toHaveLength(1);
    // A new bar: only the open position is asked again; a take or a stop is final.
    c.candles(BTC, "1h", 0, 101 * H);
    expect(b.resolves).toHaveLength(2);
    expect(b.resolves[1]!.positions.map((p) => p.id)).toEqual(["p2"]);
    b.resolves[1]!.resolve([{ id: "p2", outcome: STOP }]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", TAKE], ["p2", STOP]]));
    // Both closed: another new bar asks nothing.
    c.candles(BTC, "1h", 0, 102 * H);
    expect(b.resolves).toHaveLength(2);
    c.candles(BTC, "4h", 0, 101 * H);
    // Another timeframe: the old outcomes go at once, and every position is asked.
    expect(s.outcomes.at(-1)).toEqual(new Map());
    expect(b.resolves.at(-1)!.tf).toBe("4h");
    expect(b.resolves.at(-1)!.positions.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("does not ask for hidden positions until they are shown again", async () => {
    const hiddenPos = { ...drawing("hp", 0, BTC, pos()), hidden: true };
    const { b, s, c } = await loaded([hiddenPos, drawing("p", 0, BTC, pos(80))]);
    c.candles(BTC, "1h", 0, 100 * H);
    expect(b.resolves.map((r) => r.positions.map((p) => p.id))).toEqual([["p"]]);
    s.commit({ before: hiddenPos, after: { ...hiddenPos, hidden: false } });
    expect(b.resolves.at(-1)!.positions.map((p) => p.id)).toContain("hp");
  });

  it("asks a closed position again when older bars before its entry came in", async () => {
    const early = { ...(pos() as PositionBody), entry: { t: 2 * H, p: 100 } };
    const { b, s, c } = await loaded([drawing("early", 0, BTC, { kind: "position", ...early }), drawing("late", 0, BTC, pos())]);
    c.candles(BTC, "1h", 5 * H, 100 * H);
    b.resolves[0]!.resolve([
      { id: "early", outcome: TAKE },
      { id: "late", outcome: STOP },
    ]);
    await flush();
    // An older page from 0: the bars between 2h and 5h may change "early", not "late" (entry at 10h).
    c.candles(BTC, "1h", 0, 100 * H);
    expect(b.resolves[1]!.positions.map((p) => p.id)).toEqual(["early"]);
    b.resolves[1]!.resolve([{ id: "early", outcome: STOP }]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["early", STOP], ["late", STOP]]));
  });

  it("keeps the answer of an earlier call for the positions a later one did not ask", async () => {
    const { b, s, c } = await loaded([drawing("p1", 0, BTC, pos()), drawing("p2", 0, BTC, pos(80))]);
    c.candles(BTC, "1h", 0, 100 * H);
    // p2 moves while the first call is on its way: the second asks both (neither is known yet).
    const before = drawing("p2", 0, BTC, pos(80));
    s.commit({ before, after: { ...before, body: pos(85) } });
    expect(b.resolves[1]!.positions.map((p) => p.id)).toEqual(["p1", "p2"]);
    b.resolves[1]!.resolve([
      { id: "p1", outcome: TAKE },
      { id: "p2", outcome: STOP },
    ]);
    await flush();
    // The first answer is older for both: dropped.
    b.resolves[0]!.resolve([
      { id: "p1", outcome: OPEN },
      { id: "p2", outcome: OPEN },
    ]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", TAKE], ["p2", STOP]]));
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

  it("drops every outcome, final ones too, when a replay replaces the bars", async () => {
    const { b, s, c } = await loaded([drawing("p1", 0, BTC, pos()), drawing("p2", 0, BTC, pos(80))]);
    c.candles(BTC, "1h", 0, 100 * H);
    // An answer over the live bars is still on its way when the replay starts.
    c.resetOutcomes();
    expect(s.outcomes.at(-1)).toEqual(new Map());
    b.resolves[0]!.resolve([
      { id: "p1", outcome: TAKE },
      { id: "p2", outcome: STOP },
    ]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map());
    // The replay's bars (same first and last as before): both are asked again.
    c.candles(BTC, "1h", 0, 100 * H);
    expect(b.resolves[1]!.positions.map((p) => p.id)).toEqual(["p1", "p2"]);
    b.resolves[1]!.resolve([
      { id: "p1", outcome: OPEN },
      { id: "p2", outcome: OPEN },
    ]);
    await flush();
    expect(s.outcomes.at(-1)).toEqual(new Map([["p1", OPEN], ["p2", OPEN]]));
  });
});
