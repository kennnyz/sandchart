import { afterEach, describe, expect, it, vi } from "vitest";
import type { Drawing, DrawingInput, DrawingKind, InstrumentId } from "../backend/types";
import type { DrawingCommand } from "../chart/drawings/layer";
import type { DrawingChange } from "../chart/drawings/state";
import { DrawingController, type DrawingSurface, type MagnetPref } from "./drawings";

const BTC = { source: "mock", symbol: "BTCUSDT" };
const ETH = { source: "mock", symbol: "ETHUSDT" };

function drawing(id: string, p = 100, instrument: InstrumentId = BTC): Drawing {
  return {
    id,
    instrument,
    priceScale: 2,
    body: { kind: "hline", p },
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
  const tools: (DrawingKind | null)[] = [];
  const commands: DrawingCommand[] = [];
  const magnets: boolean[] = [];
  let commit: ((c: DrawingChange) => void) | null = null;
  let tool: ((k: DrawingKind | null) => void) | null = null;
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
    onDrawingCommit: (cb) => (commit = cb),
    onDrawingTool: (cb) => (tool = cb),
  };
  return { surface, sets, tools, commands, magnets, commit: (c: DrawingChange) => commit!(c), hasListeners: () => commit !== null };
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
  };
  return { backend, calls, pending, loads, stored };
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
    expect(b.calls).toEqual([`save x ${JSON.stringify(["body", "hidden", "id", "instrument", "locked", "style", "z"])}`]);
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
});
