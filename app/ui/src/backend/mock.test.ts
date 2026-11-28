import { afterEach, describe, expect, it, vi } from "vitest";
import invalidDrawings from "../../../../crates/core/tests/fixtures/drawings_invalid.json";
import validDrawings from "../../../../crates/core/tests/fixtures/drawings_valid.json";
import fixture from "../../../../crates/core/tests/fixtures/positions.json";
import { createMockBackend, mockResolve, mockSma, mockValidateDrawing } from "./mock";
import type { Drawing, DrawingBody, DrawingInput, IndicatorInstance, IndicatorResult, PositionBody, PositionOutcome } from "./types";

const id = { source: "mock", symbol: "BTCUSDT" };

describe("mock backend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns ascending pages and stops at history start", async () => {
    const b = createMockBackend({ candles: 2500 });

    const p1 = await b.getCandles(id, "1h");
    expect(p1.time).toHaveLength(1000);
    expect(p1.atHistoryStart).toBe(false);
    expect(p1.time).toEqual([...p1.time].sort((a, c) => a - c));

    const p2 = await b.getCandles(id, "1h", p1.time[0]);
    expect(p2.time).toHaveLength(1000);
    expect(p2.time.at(-1)).toBe(p1.time[0]! - 3_600_000);
    expect(p2.atHistoryStart).toBe(false);

    const p3 = await b.getCandles(id, "1h", p2.time[0]);
    expect(p3.time).toHaveLength(500);
    expect(p3.atHistoryStart).toBe(true);
    expect(p3.time.at(-1)).toBe(p2.time[0]! - 3_600_000);

    const p4 = await b.getCandles(id, "1h", p3.time[0]);
    expect(p4.time).toHaveLength(0);
    expect(p4.atHistoryStart).toBe(true);
  });

  it("honours historyStartAt", async () => {
    const full = await createMockBackend({ candles: 300 }).getCandles(id, "1h");
    const cut = full.time[100]!;
    const page = await createMockBackend({ candles: 300, historyStartAt: cut }).getCandles(id, "1h");
    expect(page.time).toHaveLength(200);
    expect(page.time[0]).toBe(cut);
    expect(page.atHistoryStart).toBe(true);
  });

  it("returns columns of equal length with ints", async () => {
    const page = await createMockBackend({ candles: 10 }).getCandles(id, "1d");
    for (const col of [page.open, page.high, page.low, page.close, page.volume]) {
      expect(col).toHaveLength(page.time.length);
      expect(col.every(Number.isInteger)).toBe(true);
    }
  });

  it("generates prices around basePrice with the given priceScale", async () => {
    const page = await createMockBackend({ candles: 50, basePrice: 1_234, priceScale: 8 }).getCandles(id, "1h");
    expect(page.instrument.priceScale).toBe(8);
    for (const p of [...page.low, ...page.high]) {
      expect(p).toBeGreaterThan(900);
      expect(p).toBeLessThan(1_600);
    }
  });

  it("reports the connection state", async () => {
    expect(await createMockBackend({ candles: 1 }).getConnection()).toBe("connected");
  });

  it("subscribeLive resolves to a stop function", async () => {
    const stop = await createMockBackend({ candles: 1 }).subscribeLive(id, "1h", () => {});
    expect(typeof stop).toBe("function");
    stop();
  });

  it("emits live events to open subscriptions only", async () => {
    const b = createMockBackend({ candles: 1 });
    const seen: string[] = [];
    const stop = await b.subscribeLive(id, "1h", (e) => seen.push(e.kind));
    b.emitLive({ kind: "disconnected" });
    stop();
    b.emitLive({ kind: "disconnected" });
    expect(seen).toEqual(["disconnected"]);
  });

  it("has no instruments until the sync delay has passed", async () => {
    vi.useFakeTimers();
    const b = createMockBackend({ candles: 1, instrumentsAfterMs: 500 });
    let synced = 0;
    await b.onInstrumentsSynced(() => synced++);
    expect(await b.instrumentsReady()).toBe(false);
    expect(await b.searchInstruments("BTC")).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(synced).toBe(1);
    expect(await b.instrumentsReady()).toBe(true);
    expect((await b.searchInstruments("BTC")).map((i) => i.id.symbol)).toContain("BTCUSDT");
  });

  describe("indicators", () => {
    const inst = (moduleId: string, params: IndicatorInstance["params"] = []): IndicatorInstance => ({
      instance: `i-${moduleId}`,
      moduleId,
      params,
      colors: {},
      hidden: false,
    });
    const ok = (r: IndicatorResult) => {
      if (!("ok" in r.result)) throw new Error(r.result.err);
      return r.result.ok;
    };
    const values = (r: IndicatorResult, series: string) => {
      const d = ok(r).series.find((s) => s.id === series)!.data;
      if (!("values" in d)) throw new Error("not values");
      return d.values;
    };

    it("sma 2 over [1, 2, 3] is [NaN, 1.5, 2.5]", () => {
      expect(Array.from(mockSma([1, 2, 3], 2))).toEqual([NaN, 1.5, 2.5]);
    });

    it("computes the sma of the closes in price units", async () => {
      const b = createMockBackend({ candles: 300 });
      await b.setChartIndicators([inst("builtin.sma", [["period", { int: 2 }]])]);
      const page = await b.getCandles(id, "1h");
      const [r] = await b.computeIndicators(id, "1h", page.time[0]!);
      const v = values(r!, "sma");
      const closes = page.close.map((c) => c / 100);
      expect(v).toHaveLength(page.time.length);
      expect(v[0]).toBeNaN();
      expect(v[5]).toBeCloseTo((closes[4]! + closes[5]!) / 2, 9);
      expect(ok(r!).firstTime).toBe(page.time[0]);
      expect(ok(r!).lastTime).toBe(page.time.at(-1));
    });

    it("lists the built-ins and cuts results at fromTime", async () => {
      const b = createMockBackend({ candles: 300, indicators: ["sma", "bollinger", "rsi", "macd"] });
      const { indicators: list, failed, error } = await b.listIndicators();
      expect(failed).toEqual([]);
      expect(error).toBeNull();
      expect(list.filter((i) => i.builtin).map((i) => i.meta.id)).toEqual(
        expect.arrayContaining(["builtin.sma", "builtin.bollinger", "builtin.rsi", "builtin.macd"]),
      );
      expect((await b.getChartIndicators()).map((i) => i.instance)).toEqual([
        "mock-sma", "mock-bollinger", "mock-rsi", "mock-macd",
      ]);
      const page = await b.getCandles(id, "1h");
      const from = page.time[250]!;
      const results = await b.computeIndicators(id, "1h", from);
      expect(results).toHaveLength(4);
      for (const r of results) expect(ok(r).firstTime).toBe(from);
      const bb = results[1]!;
      expect(values(bb, "fill")).toHaveLength(0);
      expect(values(bb, "upper")[0]).toBeGreaterThan(values(bb, "lower")[0]!);
    });

    it("lists a broken module and a service error with indicatorProblems, and removes it", async () => {
      const b = createMockBackend({ candles: 300, indicatorProblems: true });
      const list = await b.listIndicators();
      expect(list.failed).toEqual([{ id: "test.broken", builtin: false, error: "mock: not an indicator component" }]);
      expect(list.error).toBe("mock: cannot read the installed indicators");
      await b.removeIndicator("test.broken");
      expect((await b.listIndicators()).failed).toEqual([]);
    });

    it("answers with an error when mockIndicatorError is set", async () => {
      const b = createMockBackend({ candles: 300, indicators: ["sma"], indicatorError: true });
      const [r] = await b.computeIndicators(id, "1h", 0);
      expect(r!.result).toEqual({ err: "mock: out of fuel" });
    });

    it("installs any bytes as test.echo and removes it with its instances", async () => {
      const b = createMockBackend({ candles: 300 });
      const checked = await b.inspectIndicator(new Uint8Array([1]));
      expect(checked.meta.id).toBe("test.echo");
      expect(checked.replaces).toBeNull();
      const info = await b.installIndicator(new Uint8Array([1]));
      expect(info.repaints).toBe(true);
      expect((await b.inspectIndicator(new Uint8Array([1]))).replaces).toBe(info.meta.version);
      await b.setChartIndicators([inst("test.echo")]);
      await b.removeIndicator("test.echo");
      expect(await b.getChartIndicators()).toEqual([]);
      await expect(b.removeIndicator("builtin.sma")).rejects.toThrow();
    });
  });

  describe("drawings", () => {
    const input = (drawingId: string, body: DrawingBody, z = 0): DrawingInput => ({
      id: drawingId,
      instrument: id,
      priceScale: 2,
      body,
      style: { color: 2, width: 1, dash: false },
      locked: false,
      z,
    });
    const long = (over: Partial<PositionBody> = {}): DrawingBody => ({
      kind: "position",
      side: "long",
      entry: { t: 1_000, p: 100 },
      stop: 90,
      take: 120,
      endT: 2_000,
      ...over,
    });

    it("saves, lists in z then id order, replaces and deletes", async () => {
      const b = createMockBackend({ candles: 10 });
      const saved = await b.saveDrawing(input("b", { kind: "hline", p: 5 }));
      expect(saved.priceScale).toBe(2);
      expect(saved.updatedAt).toBeGreaterThan(0);
      await b.saveDrawing(input("a", { kind: "note", t: 1, text: "hi" }));
      await b.saveDrawing(input("c", long(), -1));
      await b.saveDrawing({ ...input("x", { kind: "hline", p: 1 }), instrument: { source: "mock", symbol: "ETHUSDT" } });
      expect((await b.getDrawings(id)).map((d) => d.id)).toEqual(["c", "a", "b"]);

      await b.saveDrawing(input("b", { kind: "hline", p: 7 }, 5));
      const list = await b.getDrawings(id);
      expect(list.at(-1)!.body).toEqual({ kind: "hline", p: 7 });
      // The list is a copy: changing it does not change what is stored.
      list[0]!.z = 99;
      expect((await b.getDrawings(id))[0]!.z).toBe(-1);

      await b.deleteDrawing("b");
      await b.deleteDrawing("b");
      expect((await b.getDrawings(id)).map((d) => d.id)).toEqual(["c", "a"]);
    });

    it("rescales a drawing made at another tick size, as the engine does", async () => {
      // The UI got the drawings at scale 2; the instrument now quotes four decimals.
      const b = createMockBackend({ candles: 10, priceScale: 4 });
      const saved = await b.saveDrawing(input("p", long()));
      expect(saved.priceScale).toBe(4);
      expect(saved.body).toMatchObject({ entry: { t: 1_000, p: 10_000 }, stop: 9_000, take: 12_000, endT: 2_000 });
      // Down to scale 0: 12 345 (123.45) is stored as 123, and -12 350 as -124.
      const down = createMockBackend({ candles: 10, priceScale: 0 });
      expect((await down.saveDrawing(input("h", { kind: "hline", p: 12_345 }))).body).toEqual({ kind: "hline", p: 123 });
      expect((await down.saveDrawing(input("n", { kind: "hline", p: -12_350 }))).body).toEqual({ kind: "hline", p: -124 });
      await expect(b.saveDrawing(input("big", { kind: "hline", p: Math.floor(Number.MAX_SAFE_INTEGER / 10) }))).rejects.toMatchObject({
        message: expect.stringMatching(/price scale 4.*±\(2\^53 - 1\)/),
      });
      await expect(down.saveDrawing(input("tight", long({ stop: 9_999, entry: { t: 1_000, p: 10_000 }, take: 10_001 })))).rejects.toMatchObject({
        message: expect.stringMatching(/price scale 0.*stop < entry < take/),
      });
      expect((await b.getDrawings(id)).map((d) => d.id)).toEqual(["p"]);
    });

    it("lists drawings stored at another tick size rescaled, leaving out those that do not fit", async () => {
      let kept: Drawing[] | null = null;
      const store = { load: () => kept, save: (all: Drawing[]) => (kept = structuredClone(all)) };
      const first = createMockBackend({ candles: 10, latencyMs: 0, drawingStore: store });
      await first.saveDrawing(input("h", { kind: "hline", p: 12_345 }));
      await first.saveDrawing(input("tight", long({ stop: 9_999, entry: { t: 1_000, p: 10_000 }, take: 10_001 })));
      const later = createMockBackend({ candles: 10, latencyMs: 0, priceScale: 0, drawingStore: store });
      const list = await later.getDrawings(id);
      expect(list.map((d) => [d.id, d.priceScale, d.body])).toEqual([["h", 0, { kind: "hline", p: 123 }]]);
      expect(kept!.length).toBe(2);
    });

    it("keeps drawings in the given store across backends", async () => {
      let kept: Drawing[] | null = null;
      const store = { load: () => kept, save: (all: Drawing[]) => (kept = structuredClone(all)) };
      const first = createMockBackend({ candles: 10, latencyMs: 0, drawingStore: store });
      await first.saveDrawing(input("a", { kind: "hline", p: 5 }));
      await first.saveDrawing(input("b", { kind: "hline", p: 6 }));
      await first.deleteDrawing("a");
      const second = createMockBackend({ candles: 10, latencyMs: 0, drawingStore: store });
      expect((await second.getDrawings(id)).map((d) => [d.id, d.body])).toEqual([["b", { kind: "hline", p: 6 }]]);
    });

    it("rejects what Rust rejects, with its message", async () => {
      const b = createMockBackend({ candles: 10 });
      await expect(b.saveDrawing(input("a b", { kind: "hline", p: 1 }))).rejects.toMatchObject({
        code: "other",
        message: expect.stringContaining("drawing id"),
      });
      await expect(b.saveDrawing(input("p", long({ stop: 100 })))).rejects.toMatchObject({
        message: "a long position needs stop < entry < take",
      });
      await expect(b.saveDrawing({ ...input("u", { kind: "hline", p: 1 }), instrument: { source: "mock", symbol: "NOPE" } })).rejects.toMatchObject({
        message: expect.stringContaining("unknown instrument"),
      });
      expect(await b.getDrawings(id)).toEqual([]);
    });

    it("validates as Rust does: the shared fixture, with the same messages", () => {
      type Case = { name: string; drawing: Omit<DrawingInput, "instrument" | "priceScale" | "locked">; error?: string };
      const full = (c: Case): DrawingInput => ({ ...c.drawing, instrument: id, priceScale: 2, locked: false });
      const ok = validDrawings.cases as Case[];
      const bad = invalidDrawings.cases as Case[];
      expect(ok.length).toBeGreaterThanOrEqual(10);
      expect(bad.length).toBeGreaterThanOrEqual(30);
      for (const c of ok) expect(mockValidateDrawing(full(c)), c.name).toBeNull();
      for (const c of bad) expect(mockValidateDrawing(full(c)), c.name).toBe(c.error);
      // JSON has no NaN or infinity: these are checked here and in drawing.rs.
      const fib = (levels: number[]) => input("f", { kind: "fib", a: { t: 1, p: 1 }, b: { t: 2, p: 2 }, levels });
      expect(mockValidateDrawing(fib([NaN]))).toBe("Fibonacci level NaN is not a number in -5..=5");
      expect(mockValidateDrawing(fib([Infinity]))).toBe("Fibonacci level inf is not a number in -5..=5");
      expect(mockValidateDrawing(fib([0.5, -Infinity]))).toBe("Fibonacci level -inf is not a number in -5..=5");
    });

    it("keeps at most 2000 drawings per instrument", async () => {
      const b = createMockBackend({ candles: 10 });
      for (let i = 0; i < 2000; i++) await b.saveDrawing(input(`d${i}`, { kind: "hline", p: i }));
      await expect(b.saveDrawing(input("more", { kind: "hline", p: 1 }))).rejects.toMatchObject({
        message: expect.stringContaining("at most 2000"),
      });
      await b.saveDrawing(input("d0", { kind: "hline", p: 9 }));
    });

    it("resolve matches the Rust fixture", () => {
      type Case = PositionBody & { name: string; candles: number[][]; expect: PositionOutcome };
      const cases = fixture.cases as Case[];
      expect(cases.length).toBeGreaterThanOrEqual(12);
      for (const c of cases) {
        const bars = c.candles.map((r) => ({ time: r[0]!, high: r[2]!, low: r[3]! }));
        expect(mockResolve(c, bars), c.name).toEqual(c.expect);
      }
    });

    it("resolves positions over its own candles", async () => {
      const b = createMockBackend({ candles: 500 });
      const page = await b.getCandles(id, "1h");
      const i = 100;
      const entry = { t: page.time[i]! + 1, p: page.close[i]! };
      // A take just above the next bar's high and a far stop: the next bars decide.
      const position: PositionBody = { side: "long", entry, stop: 1, take: page.high[i + 1]!, endT: page.time.at(-1)! };
      const [r] = await b.getPositionOutcomes(id, "1h", [{ id: "p", position }]);
      expect(r).toEqual({ id: "p", outcome: { status: "take", exitTime: page.time[i + 1], ambiguous: false, r: expect.any(Number) } });
      const short: PositionBody = { ...position, endT: page.time[i]! + 2 };
      expect((await b.getPositionOutcomes(id, "1h", [{ id: "q", position: short }]))[0]!.outcome.status).toBe("open");
      await expect(b.getPositionOutcomes(id, "1h", [{ id: "z", position: { ...position, stop: entry.p } }])).rejects.toMatchObject({
        message: expect.stringContaining("position z"),
      });
    });

    it("resolves a position over every bar to its end, as the engine does (no bar cap)", async () => {
      const n = 150_000;
      const b = createMockBackend({ candles: n });
      const page = await b.getCandles(id, "1h");
      const last = page.time.at(-1)!;
      const first = last - (n - 1) * 3_600_000;
      // Runs through all 150 000 bars without a hit: open, and quickly, bar by bar.
      const position: PositionBody = { side: "long", entry: { t: first, p: 10_000 }, stop: 1, take: 1e12, endT: last };
      const started = performance.now();
      const [r] = await b.getPositionOutcomes(id, "1h", [{ id: "p", position }]);
      expect(r!.outcome.status).toBe("open");
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });

  it("installs a checked update once, then needs a new check", async () => {
    const b = createMockBackend({
      candles: 10,
      update: { version: "0.3.0", notes: "", date: null, blocker: null },
    });
    await expect(b.installUpdate(() => undefined)).rejects.toMatchObject({ message: "check for updates first" });
    expect(await b.checkUpdate()).toMatchObject({ version: "0.3.0" });
    const kinds: string[] = [];
    vi.useFakeTimers();
    const done = b.installUpdate((p) => kinds.push(p.kind));
    await vi.runAllTimersAsync();
    await done;
    expect(kinds).toEqual(["started", ...Array<string>(10).fill("chunk"), "installing"]);
    await expect(b.installUpdate(() => undefined)).rejects.toMatchObject({ code: "other" });
  });

  it("fails a download halfway with updateError install", async () => {
    const b = createMockBackend({
      candles: 10,
      update: { version: "0.3.0", notes: "", date: null, blocker: null },
      updateError: "install",
    });
    await b.checkUpdate();
    const kinds: string[] = [];
    vi.useFakeTimers();
    const failed = expect(b.installUpdate((p) => kinds.push(p.kind))).rejects.toMatchObject({ message: "mock: connection reset" });
    await vi.runAllTimersAsync();
    await failed;
    expect(kinds).toEqual(["started", ...Array<string>(5).fill("chunk")]);
  });
});

describe("mock alerts", () => {
  const candle = (time: number, low: number, high: number, close: number) =>
    ({ kind: "candle", time, open: close, high, low, close, volume: 1, closed: false }) as const;
  const hline = (drawingId: string, p: number): DrawingInput => ({
    id: drawingId,
    instrument: id,
    priceScale: 2,
    body: { kind: "hline", p },
    style: { color: 0, width: 1, dash: false },
    locked: false,
    z: 0,
  });

  it("fires an alert once from the live feed of its pair and reports it", async () => {
    const b = createMockBackend({ candles: 1 });
    const fired: string[] = [];
    let changed = 0;
    await b.onAlertFired((a) => fired.push(`${a.id}@${a.triggeredPrice}`));
    await b.onAlertsChanged(() => changed++);
    const set = await b.setAlert({ id: "a1", instrument: id, priceScale: 2, kind: { kind: "price", price: 10_000 }, direction: "above" });
    expect(set.active).toBe(true);
    expect(changed).toBe(1);
    // Fed only while the pair is subscribed.
    b.emitLive(candle(0, 9_000, 9_990, 9_990));
    const stop = await b.subscribeLive(id, "1h", () => {});
    b.emitLive(candle(0, 9_000, 9_990, 9_990));
    b.emitLive(candle(0, 9_000, 10_010, 10_005));
    b.emitLive(candle(0, 9_000, 10_100, 9_000));
    expect(fired).toEqual(["a1@10005"]);
    const [stored] = await b.getAlerts();
    expect(stored).toMatchObject({ active: false, triggeredPrice: 10_005 });
    await b.rearmAlert("a1");
    expect((await b.getAlerts())[0]!.active).toBe(true);
    stop();
  });

  it("follows hlines only, and deleting the drawing deletes its alerts", async () => {
    const b = createMockBackend({ candles: 1 });
    await b.saveDrawing(hline("h1", 10_000));
    await b.saveDrawing({ ...hline("n1", 1), body: { kind: "note", t: 0, text: "x" } });
    await expect(
      b.setAlert({ id: "a", instrument: id, priceScale: 2, kind: { kind: "drawing", drawingId: "n1" }, direction: "cross" }),
    ).rejects.toMatchObject({ message: "an alert can follow only a horizontal or a trend line" });
    await expect(
      b.setAlert({ id: "a", instrument: id, priceScale: 2, kind: { kind: "drawing", drawingId: "zz" }, direction: "cross" }),
    ).rejects.toMatchObject({ message: "drawing zz does not exist" });
    await b.setAlert({ id: "a", instrument: id, priceScale: 2, kind: { kind: "drawing", drawingId: "h1" }, direction: "cross" });
    await b.setAlert({ id: "p", instrument: id, priceScale: 2, kind: { kind: "price", price: 1 }, direction: "cross" });
    let changed = 0;
    await b.onAlertsChanged(() => changed++);
    await b.deleteDrawing("h1");
    expect((await b.getAlerts()).map((a) => a.id)).toEqual(["p"]);
    expect(changed).toBe(1);
    await b.deleteAlert("p");
    expect(await b.getAlerts()).toEqual([]);
  });

  it("deletes the alerts of a drawing saved as a shape that is not a line", async () => {
    const b = createMockBackend({ candles: 1 });
    await b.saveDrawing(hline("h1", 10_000));
    await b.setAlert({ id: "a", instrument: id, priceScale: 2, kind: { kind: "drawing", drawingId: "h1" }, direction: "cross" });
    await b.saveDrawing(hline("h1", 10_500));
    expect((await b.getAlerts()).map((a) => a.id)).toEqual(["a"]);
    let changed = 0;
    await b.onAlertsChanged(() => changed++);
    await b.saveDrawing({ ...hline("h1", 1), body: { kind: "note", t: 0, text: "x" } });
    expect(await b.getAlerts()).toEqual([]);
    expect(changed).toBe(1);
  });

  it("refuses past 100 active alerts", async () => {
    const b = createMockBackend({ candles: 1 });
    for (let i = 0; i < 100; i++) {
      await b.setAlert({ id: `a${i}`, instrument: id, priceScale: 2, kind: { kind: "price", price: i }, direction: "cross" });
    }
    await expect(
      b.setAlert({ id: "more", instrument: id, priceScale: 2, kind: { kind: "price", price: 1 }, direction: "cross" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("at most 100 alerts can be active") });
  });
});
