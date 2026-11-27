import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Backend,
  IndicatorInfo,
  IndicatorInstance,
  IndicatorResult,
  InstrumentId,
  TimeframeCode,
} from "../backend/types";
import { IndicatorState } from "./indicators";

const BTC = { source: "mock", symbol: "BTCUSDT" };
const ETH = { source: "mock", symbol: "ETHUSDT" };

const SMA: IndicatorInfo = {
  meta: {
    id: "builtin.sma",
    name: "SMA",
    version: "0.2.0",
    description: "",
    params: [
      { id: "period", label: "Period", kind: { int: [1, 1000] }, default: { int: 20 } },
      { id: "source", label: "Source", kind: { choice: ["close", "open"] }, default: { choice: "close" } },
    ],
    series: [{ id: "sma", label: "SMA", kind: "line", pane: "price", color: 0 }],
  },
  builtin: true,
  repaints: false,
};
const RSI: IndicatorInfo = {
  meta: {
    id: "builtin.rsi",
    name: "RSI",
    version: "0.2.0",
    description: "",
    params: [{ id: "period", label: "Period", kind: { int: [2, 1000] }, default: { int: 14 } }],
    series: [{ id: "rsi", label: "RSI", kind: "line", pane: "own", color: 4 }],
  },
  builtin: true,
  repaints: false,
};

interface Call {
  id: InstrumentId;
  tf: TimeframeCode;
  fromTime: number;
  resolve: (r: IndicatorResult[]) => void;
}

/** The indicator part of a backend; every compute waits until the test resolves it. */
function fakeBackend(saved: IndicatorInstance[] = []) {
  const calls: Call[] = [];
  const saves: IndicatorInstance[][] = [];
  const backend = {
    listIndicators: async () => ({ indicators: [SMA, RSI], failed: [], error: null }),
    getChartIndicators: async () => saved.map((i) => ({ ...i })),
    setChartIndicators: async (items: IndicatorInstance[]) => {
      saves.push(items.map((i) => ({ ...i })));
    },
    computeIndicators: (id: InstrumentId, tf: TimeframeCode, fromTime: number) =>
      new Promise<IndicatorResult[]>((resolve) => calls.push({ id, tf, fromTime, resolve })),
  } as unknown as Backend;
  return { backend, calls, saves };
}

/** A scheduler the test runs by hand. */
function manualScheduler() {
  const due: { fn: () => void; ms: number }[] = [];
  const schedule = ((fn: () => void, ms: number) => {
    due.push({ fn, ms });
    return 0;
  }) as unknown as typeof setTimeout;
  const runAll = () => {
    for (const d of due.splice(0)) d.fn();
  };
  return { due, schedule, runAll };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function ok(instance: string, firstTime: number, values: number[]): IndicatorResult {
  return {
    instance,
    result: {
      ok: { firstTime, lastTime: firstTime, series: [{ id: "x", data: { values: Float64Array.from(values) } }], log: "" },
    },
  };
}

describe("IndicatorState", () => {
  it("add saves the list with default params and the spec colours", async () => {
    const { backend, saves } = fakeBackend();
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    await state.add("builtin.sma");

    expect(saves).toHaveLength(1);
    const [inst] = saves[0]!;
    expect(inst!.moduleId).toBe("builtin.sma");
    expect(inst!.instance).toMatch(/^[0-9a-f-]{36}$/);
    expect(inst!.params).toEqual([
      ["period", { int: 20 }],
      ["source", { choice: "close" }],
    ]);
    expect(inst!.colors).toEqual({ sma: 0 });
    expect(inst!.hidden).toBe(false);
    expect(state.instances.map((i) => i.moduleId)).toEqual(["builtin.sma"]);
    // Pending until the first compute: a layer without a result or an error.
    expect(state.layers().map((l) => [l.computed, l.error])).toEqual([[null, null]]);
  });

  afterEach(() => vi.unstubAllGlobals());

  // WebKit (the macOS and Linux app) throws "Can only call Window.setTimeout on instances of
  // Window" when setTimeout runs with another `this`; Chromium does not, so e2e missed it.
  it("the default scheduler calls setTimeout without a foreign this", async () => {
    const { backend } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false },
    ]);
    const strict = vi.fn(function (this: unknown, fn: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Can only call Window.setTimeout on instances of Window");
      fn();
      return 0;
    });
    vi.stubGlobal("setTimeout", strict);
    const state = new IndicatorState(backend, () => undefined);
    await state.load();
    expect(() => state.recompute({ id: BTC, tf: "1h", fromTime: 1000 })).not.toThrow();
    expect(strict).toHaveBeenCalled();
  });

  it("three live triggers in 100 ms give one compute", async () => {
    const { backend, calls } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false },
    ]);
    const sched = manualScheduler();
    const state = new IndicatorState(backend, () => undefined, sched.schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 });
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 });
    state.recompute({ id: BTC, tf: "1h", fromTime: 2000 });

    expect(calls).toHaveLength(0);
    expect(sched.due.map((d) => d.ms)).toEqual([250]);
    sched.runAll();
    expect(calls).toHaveLength(1);
    // The trailing call wins: the latest arguments are computed.
    expect(calls[0]!.fromTime).toBe(2000);
  });

  it("drops a result for the old chart after a symbol switch", async () => {
    const { backend, calls } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false },
    ]);
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    state.clear(); // the user switched to ETHUSDT
    state.recompute({ id: ETH, tf: "1h", fromTime: 5000 }, true);
    expect(calls).toHaveLength(2);

    // ETH answers first, then the slow BTC result arrives.
    calls[1]!.resolve([ok("a", 5000, [2])]);
    await flush();
    calls[0]!.resolve([ok("a", 1000, [1])]);
    await flush();
    expect(state.layers()[0]!.computed!.firstTime).toBe(5000);

    // A result that arrives after a switch with nothing recomputed yet is dropped too.
    state.recompute({ id: ETH, tf: "1h", fromTime: 5000 }, true);
    state.clear();
    calls[2]!.resolve([ok("a", 5000, [3])]);
    await flush();
    expect(state.layers()[0]!.computed).toBeNull();
  });

  it("shows an err result as the layer error and keeps the other layers", async () => {
    const { backend, calls } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false },
      { instance: "b", moduleId: "builtin.rsi", params: [], colors: {}, hidden: false },
    ]);
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    calls[0]!.resolve([ok("a", 1000, [1]), { instance: "b", result: { err: "out of fuel" } }]);
    await flush();

    const [a, b] = state.layers();
    expect(a!.error).toBeNull();
    expect(a!.computed!.firstTime).toBe(1000);
    expect(b!.error).toBe("out of fuel");
    expect(b!.computed).toBeNull();
  });

  it("does not start a live compute while one is in flight, and runs it after", async () => {
    const { backend, calls } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false },
    ]);
    const sched = manualScheduler();
    const state = new IndicatorState(backend, () => undefined, sched.schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 });
    sched.runAll();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([ok("a", 1000, [1])]);
    await flush();
    expect(calls).toHaveLength(2);
    expect(state.layers()[0]!.computed).not.toBeNull();
  });

  it("recomputes after a params change once the list is saved, and hidden ones are not drawn", async () => {
    const { backend, calls, saves } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false },
    ]);
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    await state.update("a", { params: [["period", { int: 50 }]] });
    expect(saves.at(-1)![0]!.params).toEqual([["period", { int: 50 }]]);
    expect(calls).toHaveLength(2);

    await state.update("a", { hidden: true });
    expect(state.layers()).toEqual([]);
    await state.remove("a");
    expect(saves.at(-1)).toEqual([]);
    expect(state.instances).toEqual([]);
  });

  it("a rejected compute shows its message on every drawn layer", async () => {
    const backend = {
      listIndicators: async () => ({ indicators: [SMA], failed: [], error: null }),
      getChartIndicators: async () => [{ instance: "a", moduleId: "builtin.sma", params: [], colors: {}, hidden: false }],
      setChartIndicators: async () => undefined,
      computeIndicators: async () => {
        throw { code: "other", message: "engine closed" };
      },
    } as unknown as Backend;
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    await flush();
    expect(state.layers()[0]!.error).toBe("engine closed");
  });

  it("a failed save on add rolls the list back, rejects and computes nothing", async () => {
    const { backend, calls } = fakeBackend();
    (backend as { setChartIndicators: unknown }).setChartIndicators = async () => {
      throw { code: "other", message: "disk full" };
    };
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    await expect(state.add("builtin.sma")).rejects.toThrow("disk full");
    expect(state.instances).toEqual([]);
    expect(state.layers()).toEqual([]);
    expect(calls).toHaveLength(1); // only the recompute above
  });

  it("a failed save of new params restores the saved ones", async () => {
    const { backend, calls } = fakeBackend([
      { instance: "a", moduleId: "builtin.sma", params: [["period", { int: 20 }]], colors: {}, hidden: false },
    ]);
    (backend as { setChartIndicators: unknown }).setChartIndicators = async () => {
      throw new Error("disk full");
    };
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    state.recompute({ id: BTC, tf: "1h", fromTime: 1000 }, true);
    calls[0]!.resolve([ok("a", 1000, [1])]);
    await flush();
    await expect(state.update("a", { params: [["period", { int: 50 }]] })).rejects.toThrow("disk full");
    expect(state.instances[0]!.params).toEqual([["period", { int: 20 }]]);
    // Nothing to recompute: the engine still has period 20 and its result is shown.
    expect(calls).toHaveLength(1);
    expect(state.layers()[0]!.computed).not.toBeNull();
  });

  it("keeps the modules that failed to load and the service error", async () => {
    const { backend } = fakeBackend([
      { instance: "a", moduleId: "me.broken", params: [], colors: {}, hidden: false },
    ]);
    const failed = [{ id: "me.broken", builtin: false, error: "not an indicator component" }];
    (backend as { listIndicators: unknown }).listIndicators = async () => ({
      indicators: [SMA],
      failed,
      error: "cannot read the installed indicators",
    });
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await state.load();
    expect(state.infos).toEqual([SMA]);
    expect(state.failed).toEqual(failed);
    expect(state.serviceError).toBe("cannot read the installed indicators");
    expect(state.layers()).toEqual([]);
  });

  it("a failed load is kept as loadError until a retry succeeds", async () => {
    const { backend } = fakeBackend();
    const list = backend.listIndicators.bind(backend);
    let fail = true;
    (backend as { listIndicators: unknown }).listIndicators = async () => {
      if (fail) throw { code: "other", message: "engine starting" };
      return list();
    };
    const state = new IndicatorState(backend, () => undefined, manualScheduler().schedule);
    await expect(state.load()).rejects.toThrow("engine starting");
    expect(state.loadError).toBe("engine starting");
    fail = false;
    await state.load();
    expect(state.loadError).toBeNull();
    expect(state.infos.map((i) => i.meta.id)).toEqual(["builtin.sma", "builtin.rsi"]);
  });
});
