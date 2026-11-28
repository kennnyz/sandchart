import { describe, expect, it } from "vitest";
import fixture from "../../../../crates/core/tests/fixtures/replay.json";
import { createMockBackend } from "./mock";
import { type MockCandle, mockAggregate, mockBucketStart, mockCandleHash, mockHigher, mockReadReplay, mockRevealed, mockSimulate, mockSimulateFile, mockSplit } from "./mockReplay";
import type { CandleColumns, LiveEvent, ReplayCommand, ReplayStats, ReplayTrade, TimeframeCode } from "./types";

const id = { source: "mock", symbol: "BTCUSDT" };
const H = 3_600_000;

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
const rows6 = (c: number[][]): MockCandle[] =>
  c.map(([time, open, high, low, close, volume]) => ({ time: time!, open: open!, high: high!, low: low!, close: close!, volume: volume! }));
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe("mock replay (TEST-ONLY copy of sandchart_core::replay)", () => {
  it("simulates every fixture case like Rust", () => {
    for (const c of fixture.cases) {
      const run = () => mockSimulate(c.base as TimeframeCode, rows(c.candles), c.start, c.cut, c.commands as ReplayCommand[]);
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
        expectSim(mockSimulateFile(f), c.expect as Sim, c.name);
      }
    }
  });

  it("aggregates every fixture case like Rust", () => {
    for (const c of fixture.aggregates) {
      const run = () => mockAggregate(rows6(c.candles), c.base as TimeframeCode, c.tf as TimeframeCode);
      if ("error" in c) expect(run, c.name).toThrow(c.error);
      else expect(run(), c.name).toEqual(rows6(c.expect!));
    }
  });

  it("shows every fixture view like Rust: the chart grows, the trade does not depend on it", () => {
    for (const v of fixture.views) {
      const base = v.base as TimeframeCode;
      const candles = rows6(v.candles);
      for (const ch of v.charts) {
        expect(mockAggregate(mockRevealed(base, candles, ch.cut), base, v.tf as TimeframeCode), `${v.name} at ${ch.cut}`).toEqual(rows6(ch.candles));
      }
      expectSim(mockSimulate(base, candles, v.start, v.cut, v.commands as ReplayCommand[]), v.expect as Sim, v.name);
    }
  });

  it("re-bases up like the engine and splits candles that Rust aggregates back", () => {
    for (const c of fixture.rebase.higher) {
      const run = () => mockHigher(rows6(c.candles), c.base as TimeframeCode, c.tf as TimeframeCode);
      if ("error" in c) expect(run, c.name).toThrow(c.error);
      else expect(run(), c.name).toEqual(rows6(c.expect!));
    }
    for (const c of fixture.rebase.splits) {
      const [candle] = rows6([c.candle]);
      expect(mockSplit(candle!, c.base as TimeframeCode, c.lower as TimeframeCode), c.name).toEqual(rows6(c.expect));
    }
  });

  it("lays buckets out like Binance", () => {
    // Expected times worked out with Python's datetime.
    expect(mockBucketStart("1w", 1_795_651_200_000)).toBe(1_795_392_000_000); // Thu 2026-11-26 -> Mon 2026-11-23
    expect(mockBucketStart("1M", 1_709_164_800_000)).toBe(1_706_745_600_000); // 2024-02-29 -> 2024-02-01
    expect(mockBucketStart("3d", 1_732_883_640_000)).toBe(1_732_752_000_000);
    expect(mockBucketStart("15m", -1)).toBe(-900_000);
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
    // A step returns the cut.
    expect(await b.replayStep(2)).toBe(st.cut + 2 * H);
    const next = await b.replayState("1h", 501, 0);
    expect(next.from).toBe(501);
    expect(next.bars.time).toEqual(page.time.slice(-99, -97));
    expect((await b.replayState("1h", 10_000, 0)).bars.time).toEqual([]);
    expect(await b.replayStep(1_000)).toBe(page.time.at(-1)! + H);
    // At the newest candle it has caught up: no more steps or commands.
    expect(await b.replayState("1h", 0, 0)).toMatchObject({ atEnd: true, caughtUp: true, current: 599 });
    await expect(b.replayStep(1)).rejects.toMatchObject({
      message: "the replay has caught up with real time, so its backtest is finished: it takes no steps",
    });
    await expect(b.replayStart(id, "1h", startTime + 1)).rejects.toMatchObject({
      message: `no cached 1h bar opens at ${startTime + 1}`,
    });
  });

  it("checks commands like Rust and keeps the trades", async () => {
    const { b, st, startTime } = await started();
    const close = st.bars.close.at(-1)!;
    expect(st.cut).toBe(startTime + H);
    const open: ReplayCommand = { kind: "open", time: st.cut, side: "long", stop: close - 1_000, take: close + 1_000 };
    await expect(b.replayCommand({ ...open, time: st.cut + H })).rejects.toMatchObject({
      message: `a command is given at the cut ${st.cut}, not at ${st.cut + H}`,
    });
    await b.replayCommand(open);
    await expect(b.replayCommand(open)).rejects.toMatchObject({ message: "command 2: a trade is already open" });
    await b.replayStep(1);
    // A command made before the step is refused: only the bar on screen can be traded.
    await expect(b.replayCommand({ kind: "close", time: st.cut })).rejects.toMatchObject({
      message: `a command is given at the cut ${st.cut + H}, not at ${st.cut}`,
    });
    await b.replayCommand({ kind: "close", time: st.cut + H });
    const s = await b.replayState("1h", 0, 0);
    expect(s.trades[0]).toMatchObject({ reason: "manual", entryPrice: close, entryTime: startTime, exitTime: startTime + H });
    expect(s.stats.count).toBe(1);
  });

  it("sends closed trades from the index given and always the open one, as Rust", async () => {
    const { b, st } = await started();
    const close = st.bars.close.at(-1)!;
    // Far levels: no mock bar reaches them, so the first trade is still open to close by hand.
    const open = (time: number): ReplayCommand => ({ kind: "open", time, side: "long", stop: Math.round(close / 2), take: close * 2 });
    await b.replayCommand(open(st.cut));
    await b.replayStep(1);
    await b.replayCommand({ kind: "close", time: st.cut + H });
    await b.replayCommand(open(st.cut + H));
    const all = await b.replayState("1h", 0, 0);
    expect([all.tradesFrom, all.trades.length]).toEqual([0, 2]);
    expect(all).not.toHaveProperty("commands");
    const later = await b.replayState("1h", 0, 1);
    expect(later.tradesFrom).toBe(1);
    expect(later.trades).toEqual(all.trades.slice(1));
    const past = await b.replayState("1h", 0, 9);
    expect([past.tradesFrom, past.trades.length]).toEqual([1, 1]);
  });

  it("saves only revealed bars and opens the file to the same state", async () => {
    const { b, st } = await started();
    const close = st.bars.close.at(-1)!;
    await b.replayCommand({ kind: "open", time: st.cut, side: "short", stop: close + 1_000, take: close - 1_000 });
    await b.replayStep(3);
    const before = await b.replayState("1h", 0, 0);
    expect(await b.replaySave()).toBe("BTCUSDT-1h.replay");
    const text = b.replayFile()!;
    expect(text.match(/^ {4}\[\d+, /gm)).toHaveLength(before.current + 1);

    await b.replayExit();
    await expect(b.replayState("1h", 0, 0)).rejects.toMatchObject({ message: "no replay is open" });
    const opened = await b.replayOpen(new TextEncoder().encode(text));
    expect(opened).toEqual({ ...before, atEnd: true });
    expect(text).toContain(`\n  "base": "1h",\n  "start": ${before.cut - 3 * H},\n  "cut": ${before.cut},\n`);
    await expect(b.replayOpen(new TextEncoder().encode(text.replace('"version": 2', '"version": 3')))).rejects.toMatchObject({
      message: "replay file version 3 is not supported (this app reads versions 1 and 2)",
    });
  });

  it("holds back live events of the replayed instrument", async () => {
    const b = createMockBackend({ candles: 2000 });
    const got: string[] = [];
    await b.subscribeLive(id, "1h", () => got.push("btc"));
    await b.subscribeLive({ source: "mock", symbol: "ETHUSDT" }, "1h", () => got.push("eth"));
    const e: LiveEvent = { kind: "disconnected" };
    const page = await b.getCandles(id, "1h");
    await b.replayStart(id, "1h", page.time.at(-2)!);
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

const rowsOf = (b: CandleColumns): MockCandle[] =>
  b.time.map((time, i) => ({ time, open: b.open[i]!, high: b.high[i]!, low: b.low[i]!, close: b.close[i]!, volume: b.volume[i]! }));

describe("mock replay across timeframes", () => {
  async function started() {
    const b = createMockBackend({ candles: 2000 });
    const page = await b.getCandles(id, "1h");
    // The start opens in the second hour of a 4h bucket: its cut is two hours before the bucket ends.
    const st = await b.replayStart(id, "1h", page.time[page.time.length - 100]!);
    return { b, st, page };
  }

  it("splits a candle into lower ones that aggregate back to it", () => {
    const c = { time: 0, open: 10, high: 15, low: 5, close: 12, volume: 7 };
    expect(mockAggregate(mockSplit(c, "1h", "15m"), "15m", "1h")).toEqual([c]);
    expect(mockAggregate(mockSplit(c, "1d", "1h"), "1h", "1d")).toEqual([c]);
    expect(mockSplit(c, "1h", "1h")).toEqual([c]);
  });

  it("shows higher timeframes built from the revealed candles and refuses lower ones, as the engine", async () => {
    const { b, st } = await started();
    const v = await b.replayState("4h", 0, 0);
    expect(rowsOf(v.bars)).toEqual(mockAggregate(rowsOf(st.bars), "1h", "4h"));
    expect(v).toMatchObject({ base: "1h", tf: "4h", cut: st.cut, partial: true, current: v.bars.time.length - 1, start: v.bars.time.length - 1 });
    await b.replayStep(2);
    expect((await b.replayState("4h", 0, 0)).partial).toBe(false);
    await expect(b.replayState("15m", 0, 0)).rejects.toMatchObject({
      message: "the replay steps 1h candles, so 15m candles cannot be built from them; re-base it to 15m first",
    });
    await expect(b.replayState("3d", 0, 0)).rejects.toMatchObject({ message: "3d candles cannot be built from 1h candles" });
    await expect(b.computeIndicators(id, "15m", 0)).rejects.toMatchObject({ message: /re-base it to 15m first/ });
  });

  it("re-bases down and up keeping the cut, the commands and the fills", async () => {
    const { b, st } = await started();
    const close = st.bars.close.at(-1)!;
    await b.replayCommand({ kind: "open", time: st.cut, side: "long", stop: Math.round(close / 2), take: close * 2 });
    await b.replayStep(1);
    const hourly = await b.replayState("1h", 0, 0);
    expect(await b.replaySetBase("15m")).toMatchObject({ base: "15m", tf: "15m", cut: hourly.cut });
    const again = await b.replayState("1h", 0, 0);
    expect(again.bars).toEqual(hourly.bars);
    expect(again.trades[0]!.entryPrice).toBe(hourly.trades[0]!.entryPrice);
    expect(await b.replayStep(1)).toBe(hourly.cut + H / 4);
    await expect(b.replaySetBase("1h")).rejects.toMatchObject({
      message: `the replay is at ${hourly.cut + H / 4}, inside a 1h candle; step to ${hourly.cut + H} first, where it closes`,
    });
    await b.replayStep(3);
    const back = await b.replaySetBase("1h");
    expect(back).toMatchObject({ base: "1h", tf: "1h", cut: hourly.cut + H });
    expect(back.trades[0]!.entryPrice).toBe(hourly.trades[0]!.entryPrice);
    expect(await b.replaySave()).toBe("BTCUSDT-1h.replay");
    await expect(b.replaySetBase("1w")).rejects.toMatchObject({ message: /inside a 1w candle/ });
  });

  it("catches up at the newest candle: the backtest ends there and live candles flow for display only", async () => {
    const b = createMockBackend({ candles: 2000 });
    const page = await b.getCandles(id, "1h");
    const got: LiveEvent[] = [];
    await b.subscribeLive(id, "1h", (e) => got.push(e));
    const st0 = await b.replayStart(id, "1h", page.time.at(-2)!);
    expect(st0).toMatchObject({ caughtUp: false, caughtUpAt: null });
    await b.replayCommand({ kind: "open", time: st0.cut, side: "long", stop: 1, take: 10 ** 9 });
    await b.replayStep(1);
    const st = await b.replayState("1h", 0, 0);
    expect(st).toMatchObject({ caughtUp: true, caughtUpAt: st.cut, atEnd: true });
    expect(st.trades[0]!.reason).toBe("unfinished");
    expect(st.stats.count).toBe(0);
    await expect(b.replayCommand({ kind: "close", time: st.cut })).rejects.toMatchObject({
      message: "the replay has caught up with real time, so its backtest is finished: it takes no commands",
    });
    const next = { time: page.time.at(-1)! + H, open: 1, high: 2, low: 1, close: 2, volume: 3 };
    b.emitLive({ kind: "candle", ...next, closed: true });
    expect(got).toHaveLength(1);
    expect((await b.replayState("1h", 0, 0)).cut).toBe(st.cut);
    await b.replaySave();
    const text = b.replayFile()!;
    expect(text).toContain(`"caughtUpAt": ${st.cut},`);
    expect(text).not.toContain(`[${next.time}, `);
    const opened = await b.replayOpen(new TextEncoder().encode(text));
    expect(opened).toMatchObject({ caughtUp: false, caughtUpAt: st.cut, atEnd: true });
    expect(opened.trades[0]!.reason).toBe("unfinished");
  });

});
