import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBackend } from "../backend/mock";
import type { Backend, Candles, LiveCandle, LiveEvent } from "../backend/types";
import { ChartSession, type SessionChart, type SessionState } from "./chartSession";

const BTC = { source: "mock", symbol: "BTCUSDT" };
const ETH = { source: "mock", symbol: "ETHUSDT" };

/** Records what the session does to the chart; keeps the series like the real one. */
class FakeChart implements SessionChart {
  time: number[] = [];
  close: number[] = [];
  symbol: string | null = null;
  calls: string[] = [];
  releases = 0;
  needOlder: (() => void) | null = null;

  setData(c: Candles): void {
    this.calls.push(`setData ${c.instrument.id.symbol}`);
    this.symbol = c.instrument.id.symbol;
    this.time = [...c.time];
    this.close = [...c.close];
  }
  prependData(c: Candles): void {
    this.calls.push("prependData");
    const n = c.time.filter((t) => t < (this.time[0] ?? Infinity)).length;
    this.time = [...c.time.slice(0, n), ...this.time];
    this.close = [...c.close.slice(0, n), ...this.close];
  }
  updateLast(c: LiveCandle): void {
    this.calls.push("updateLast");
    const last = this.time.length - 1;
    if (last < 0 || c.time < this.time[last]!) return;
    if (c.time > this.time[last]!) {
      this.time.push(c.time);
      this.close.push(c.close);
    } else this.close[last] = c.close;
  }
  clear(): void {
    this.calls.push("clear");
    this.symbol = null;
    this.time = [];
    this.close = [];
  }
  releaseOlder(): void {
    this.releases++;
    this.needOlder?.();
  }
  candle(i: number): LiveCandle | null {
    if (i < 0 || i >= this.time.length) return null;
    const c = this.close[i]!;
    return { time: this.time[i]!, open: c, high: c, low: c, close: c, volume: 0, closed: true };
  }
  get count(): number {
    return this.time.length;
  }
}

function setup(backend: Backend) {
  const chart = new FakeChart();
  const states: SessionState[] = [];
  const session = new ChartSession(backend, chart, (s) => states.push(s));
  return { chart, session, states, last: () => states[states.length - 1]! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChartSession", () => {
  it("chartSession drops stale results", async () => {
    const mock = createMockBackend({ candles: 3000, latencyMs: 10, slow: { symbol: "BTCUSDT", latencyMs: 300 } });
    const { chart, session, last } = setup(mock);

    const a = session.open(BTC, "1h");
    const b = session.open(ETH, "1h");
    await Promise.all([a, b]);

    expect(chart.symbol).toBe("ETHUSDT");
    expect(chart.calls.filter((c) => c.startsWith("setData"))).toEqual(["setData ETHUSDT"]);
    expect(last().id).toEqual(ETH);
    expect(last().instrument?.id.symbol).toBe("ETHUSDT");
    expect(last().status).toBe("ready");
  });

  it("clears the old series as soon as another chart opens", async () => {
    const { chart, session, last } = setup(createMockBackend({ candles: 3000, latencyMs: 5 }));
    await session.open(BTC, "1h");
    expect(chart.count).toBe(1000);

    const p = session.open(ETH, "4h");
    // Synchronously: no candles, no instrument, loading the new chart.
    expect(chart.count).toBe(0);
    expect(last()).toMatchObject({ id: ETH, tf: "4h", status: "loading", instrument: null });
    await p;
    expect(chart.count).toBe(1000);
  });

  it("drops live events of an older generation and stops its stream", async () => {
    const listeners: { symbol: string; cb: (e: LiveEvent) => void; stopped: boolean }[] = [];
    const mock = createMockBackend({ candles: 3000 });
    const backend: Backend = {
      ...mock,
      async subscribeLive(id, _tf, cb) {
        const l = { symbol: id.symbol, cb, stopped: false };
        listeners.push(l);
        return () => {
          l.stopped = true;
        };
      },
    };
    const { chart, session } = setup(backend);
    await session.open(BTC, "1h");
    await session.open(ETH, "1h");
    expect(listeners.map((l) => [l.symbol, l.stopped])).toEqual([
      ["BTCUSDT", true],
      ["ETHUSDT", false],
    ]);

    const lastTime = chart.time[chart.count - 1]!;
    listeners[0]!.cb({ kind: "candle", time: lastTime + 3_600_000, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: false });
    expect(chart.count).toBe(1000);
    listeners[1]!.cb({ kind: "candle", time: lastTime + 3_600_000, open: 2, high: 2, low: 2, close: 2, volume: 1, closed: false });
    expect(chart.count).toBe(1001);

    session.close();
    expect(listeners[1]!.stopped).toBe(true);
    listeners[1]!.cb({ kind: "candle", time: lastTime + 7_200_000, open: 3, high: 3, low: 3, close: 3, volume: 1, closed: false });
    expect(chart.count).toBe(1001);
  });

  it("a live stream that resolves after a switch is stopped at once", async () => {
    let stopped = 0;
    const mock = createMockBackend({ candles: 3000 });
    const backend: Backend = {
      ...mock,
      async subscribeLive() {
        await new Promise((r) => setTimeout(r, 30));
        return () => {
          stopped++;
        };
      },
    };
    const { session } = setup(backend);
    const a = session.open(BTC, "1h");
    await new Promise((r) => setTimeout(r, 5));
    const b = session.open(ETH, "1h");
    await Promise.all([a, b]);
    // BTC's stream arrived after the switch and was stopped; ETH's stays.
    expect(stopped).toBe(1);
  });

  it("loads older pages and ignores them after a switch", async () => {
    const mock = createMockBackend({ candles: 3000, latencyMs: 20 });
    const { chart, session } = setup(mock);
    await session.open(BTC, "1h");
    const older = session.loadOlder();
    await session.open(ETH, "1h");
    await older;
    expect(chart.calls).not.toContain("prependData");
    await session.loadOlder();
    expect(chart.count).toBe(2000);
  });

  it("a failed older load shows the problem and retries after a backoff", async () => {
    vi.useFakeTimers();
    const mock = createMockBackend({ candles: 3000 });
    let fail = true;
    const backend: Backend = {
      ...mock,
      async getCandles(id, tf, before) {
        if (before !== undefined && fail) throw new Error("network down");
        return mock.getCandles(id, tf, before);
      },
    };
    const { chart, session, last } = setup(backend);
    chart.needOlder = () => void session.loadOlder();
    await session.open(BTC, "1h");

    await session.loadOlder();
    expect(chart.count).toBe(1000);
    const problem = last().problem;
    expect(problem?.message).toBe("network down");
    expect(problem?.retryAt).toBeGreaterThan(Date.now());
    expect(chart.releases).toBe(0);

    fail = false;
    await vi.advanceTimersByTimeAsync(problem!.retryAt! - Date.now());
    // The pending flag is released, the chart asks again and the page arrives.
    expect(chart.releases).toBe(1);
    await vi.runAllTimersAsync();
    expect(chart.count).toBe(2000);
    expect(last().problem).toBeNull();
  });

  it("backs off longer after each failure", async () => {
    vi.useFakeTimers();
    const mock = createMockBackend({ candles: 3000 });
    const backend: Backend = {
      ...mock,
      async getCandles() {
        throw new Error("offline");
      },
    };
    const { session, last } = setup(backend);
    await session.open(BTC, "1h");
    expect(last().status).toBe("failed");
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const retryAt = last().problem!.retryAt!;
      delays.push(retryAt - Date.now());
      await vi.advanceTimersByTimeAsync(retryAt - Date.now());
    }
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
    session.close();
  });

  it("a page with a warning keeps the candles, shows the problem and retries", async () => {
    vi.useFakeTimers();
    const mock = createMockBackend({ candles: 3000 });
    let warning: string | null = "connect timeout";
    let calls = 0;
    const backend: Backend = {
      ...mock,
      async getCandles(id, tf, before) {
        calls++;
        return { ...(await mock.getCandles(id, tf, before)), warning };
      },
    };
    const { chart, session, last } = setup(backend);
    await session.open(BTC, "1h");
    expect(chart.count).toBe(1000);
    expect(last().status).toBe("ready");
    expect(last().problem?.message).toBe("connect timeout");

    warning = null;
    await vi.advanceTimersByTimeAsync(last().problem!.retryAt! - Date.now());
    expect(calls).toBe(2);
    expect(last().problem).toBeNull();
    // The retry merged the newest page; it did not reload the chart.
    expect(chart.calls.filter((c) => c.startsWith("setData"))).toHaveLength(1);
    session.close();
  });

  it("retryNow retries at once and close cancels the timer", async () => {
    vi.useFakeTimers();
    const mock = createMockBackend({ candles: 3000 });
    let calls = 0;
    const backend: Backend = {
      ...mock,
      async getCandles() {
        calls++;
        throw new Error("offline");
      },
    };
    const { session } = setup(backend);
    await session.open(BTC, "1h");
    expect(calls).toBe(1);
    await session.retryNow();
    expect(calls).toBe(2);
    session.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(2);
  });
});
