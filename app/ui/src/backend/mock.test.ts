import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBackend, mockSma } from "./mock";
import type { IndicatorInstance, IndicatorResult } from "./types";

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
});
