import { describe, expect, it } from "vitest";
import fixture from "../../../../crates/core/tests/fixtures/replay.json";
import { createMockBackend } from "./mock";
import { mockCandleHash, mockReadReplay, mockSimulate } from "./mockReplay";
import type { LiveEvent, ReplayCommand, ReplayStats, ReplayTrade } from "./types";

const id = { source: "mock", symbol: "BTCUSDT" };

interface Sim {
  trades: ReplayTrade[];
  stats: ReplayStats;
}

/** Fractional numbers within 1e-9, as the Rust test compares them. */
function expectSim(got: Sim, want: Sim, name: string) {
  expect(got.trades.length, name).toBe(want.trades.length);
  got.trades.forEach((t, i) => {
    const w = want.trades[i]!;
    expect(t.r, name).toBeCloseTo(w.r, 9);
    expect({ ...t, r: 0 }, name).toEqual({ ...w, r: 0 });
  });
  for (const k of ["winRate", "totalR", "averageR", "maxDrawdownR"] as const) {
    expect(got.stats[k], `${name}: ${k}`).toBeCloseTo(want.stats[k], 9);
  }
  if (want.stats.profitFactor === null) expect(got.stats.profitFactor, name).toBeNull();
  else expect(got.stats.profitFactor, name).toBeCloseTo(want.stats.profitFactor, 9);
  const ints = (s: ReplayStats) => [s.count, s.wins, s.losses, s.longestLosingStreak];
  expect(ints(got.stats), name).toEqual(ints(want.stats));
}

const rows = (c: number[][]) => c.map(([time, open, high, low, close]) => ({ time: time!, open: open!, high: high!, low: low!, close: close!, volume: 0 }));
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("mock replay (TEST-ONLY copy of sandchart_core::replay)", () => {
  it("simulates every fixture case like Rust", () => {
    for (const c of fixture.cases) {
      const run = () => mockSimulate(rows(c.candles), c.start, c.current, c.commands as ReplayCommand[]);
      if ("error" in c) expect(run, c.name).toThrow(c.error);
      else expectSim(run(), c.expect as Sim, c.name);
    }
  });

  it("reads every fixture file like Rust", async () => {
    for (const c of fixture.files) {
      const read = mockReadReplay(bytes(c.file));
      if ("error" in c) {
        await expect(read, c.name).rejects.toThrow(c.error);
      } else {
        const f = await read;
        expectSim(mockSimulate(f.candles, f.start, f.current, f.commands), c.expect as Sim, c.name);
      }
    }
  });

  it("hashes six little-endian int64 per candle", async () => {
    expect(await mockCandleHash([{ time: 1, open: 2, high: 3, low: 4, close: 5, volume: -1 }])).toBe(
      "d916e34d2e70caec5f17ad7b98b22eab344f94f34eb54ee0b474ef3fcda6d20f",
    );
  });
});

describe("mock replay session", () => {
  async function started(candles = 2000) {
    const b = createMockBackend({ candles });
    const page = await b.getCandles(id, "1h");
    const startTime = page.time[page.time.length - 100]!;
    const st = await b.replayStart(id, "1h", startTime);
    return { b, st, page, startTime };
  }

  it("starts with context, reveals bar by bar and sends only new bars", async () => {
    const { b, st, page, startTime } = await started();
    expect(st.start).toBe(500);
    expect(st.current).toBe(500);
    expect(st.bars.time).toHaveLength(501);
    expect(st.bars.time.at(-1)).toBe(startTime);
    expect(st.atEnd).toBe(false);
    expect(await b.replayStep(2)).toBe(502);
    const next = await b.replayState(501);
    expect(next.from).toBe(501);
    expect(next.bars.time).toEqual(page.time.slice(-99, -97));
    expect((await b.replayState(10_000)).bars.time).toEqual([]);
    expect(await b.replayStep(1_000)).toBe(599);
    expect((await b.replayState(0)).atEnd).toBe(true);
    await expect(b.replayStart(id, "1h", startTime + 1)).rejects.toMatchObject({
      message: `no cached 1h bar opens at ${startTime + 1}`,
    });
  });

  it("checks commands like Rust and keeps the trades", async () => {
    const { b, st } = await started();
    const close = st.bars.close.at(-1)!;
    const open: ReplayCommand = { kind: "open", bar: st.current, side: "long", stop: close - 1_000, take: close + 1_000 };
    await expect(b.replayCommand({ ...open, bar: st.current + 1 })).rejects.toMatchObject({
      message: `command 1: bar ${st.current + 1} is outside the replay (500..=500)`,
    });
    await b.replayCommand(open);
    await expect(b.replayCommand(open)).rejects.toMatchObject({ message: "command 2: a trade is already open" });
    await b.replayStep(1);
    await b.replayCommand({ kind: "close", bar: st.current + 1 });
    const s = await b.replayState(0);
    expect(s.commands).toHaveLength(2);
    expect(s.trades[0]).toMatchObject({ reason: "manual", entryPrice: close, exitBar: st.current + 1 });
    expect(s.stats.count).toBe(1);
  });

  it("saves only revealed bars and opens the file to the same state", async () => {
    const { b, st } = await started();
    const close = st.bars.close.at(-1)!;
    await b.replayCommand({ kind: "open", bar: st.current, side: "short", stop: close + 1_000, take: close - 1_000 });
    await b.replayStep(3);
    const before = await b.replayState(0);
    expect(await b.replaySave()).toBe("BTCUSDT-1h.replay");
    const text = b.replayFile()!;
    expect(text.match(/^ {4}\[\d+, /gm)).toHaveLength(before.current + 1);

    await b.replayExit();
    await expect(b.replayState(0)).rejects.toMatchObject({ message: "no replay is open" });
    const opened = await b.replayOpen(new TextEncoder().encode(text));
    expect(opened).toEqual({ ...before, atEnd: true });
    await expect(b.replayOpen(new TextEncoder().encode(text.replace('"version": 1', '"version": 2')))).rejects.toMatchObject({
      message: "replay file version 2 is not supported (this app reads version 1)",
    });
  });

  it("holds back live events of the replayed instrument", async () => {
    const b = createMockBackend({ candles: 2000 });
    const got: string[] = [];
    await b.subscribeLive(id, "1h", () => got.push("btc"));
    await b.subscribeLive({ source: "mock", symbol: "ETHUSDT" }, "1h", () => got.push("eth"));
    const e: LiveEvent = { kind: "disconnected" };
    const page = await b.getCandles(id, "1h");
    await b.replayStart(id, "1h", page.time.at(-1)!);
    b.emitLive(e);
    expect(got).toEqual(["eth"]);
    await b.replayExit();
    b.emitLive(e);
    expect(got).toEqual(["eth", "btc", "eth"]);
  });

  it("computes indicators and position outcomes over the revealed bars only", async () => {
    const { b, page, startTime } = await started();
    await b.setChartIndicators([
      { instance: "sma", moduleId: "builtin.sma", params: [["period", { int: 2 }]], colors: {}, hidden: false },
    ]);
    const lastTime = async () => {
      const [r] = await b.computeIndicators(id, "1h", 0);
      if (!("ok" in r!.result)) throw new Error(r!.result.err);
      return r!.result.ok.lastTime;
    };
    expect(await lastTime()).toBe(startTime);
    await b.replayStep(3);
    expect(await lastTime()).toBe(page.time[page.time.length - 97]);
    // Another timeframe is not replayed.
    const [h4] = await b.computeIndicators(id, "4h", 0);
    expect("ok" in h4!.result && h4!.result.ok.lastTime).toBeGreaterThan(startTime);

    // A take far above every revealed bar's high but reached later stays open in the replay.
    const i = page.time.length - 97;
    const take = Math.max(...page.high.slice(i + 1));
    const position = { side: "long" as const, entry: { t: page.time[i]!, p: page.close[i]! }, stop: 1, take, endT: page.time.at(-1)! };
    const outcome = async () => (await b.getPositionOutcomes(id, "1h", [{ id: "p", position }]))[0]!.outcome.status;
    expect(await outcome()).toBe("open");
    await b.replayExit();
    expect(await lastTime()).toBe(page.time.at(-1));
    expect(await outcome()).toBe("take");
  });
});
