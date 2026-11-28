import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBackend } from "../backend/mock";
import type { CandleColumns, LiveEvent, ReplayCommand, ReplayState, TimeframeCode } from "../backend/types";
import { TIMEFRAME_CODES } from "../backend/types";
import {
  baseChoices,
  clampLevel,
  defaultLevels,
  RESULTS_COLLAPSED_KEY,
  ReplayController,
  replayFileProblem,
  replayKeyAction,
  validLevels,
  type KeyValue,
  type ReplayKey,
} from "./replay";

const H = 3_600_000;

const id = { source: "mock", symbol: "BTCUSDT" };

/** A controller on the mock (no latency) with a feed that keeps what the chart would show. */
async function setup(candles = 2000, storage?: KeyValue) {
  const backend = createMockBackend({ candles });
  const page = await backend.getCandles(id, "1h");
  const shown: number[] = [];
  /** The bars as the chart has them: a bar with the last one's time replaces it, as `updateLast` does. */
  const bars: { time: number; high: number; low: number; close: number }[] = [];
  const put = (b: CandleColumns, i: number) => {
    const bar = { time: b.time[i]!, high: b.high[i]!, low: b.low[i]!, close: b.close[i]! };
    if (bars.at(-1)?.time === bar.time) {
      bars[bars.length - 1] = bar;
    } else {
      bars.push(bar);
      shown.push(bar.time);
    }
  };
  const feed = {
    shows: 0,
    reloads: 0,
    follows: 0,
    last: null as ReplayState | null,
    show(st: ReplayState) {
      this.shows++;
      this.last = st;
      shown.length = 0;
      bars.length = 0;
      for (let i = 0; i < st.bars.time.length; i++) put(st.bars, i);
    },
    append(b: CandleColumns) {
      for (let i = 0; i < b.time.length; i++) put(b, i);
    },
    follow() {
      this.follows++;
    },
    reload() {
      this.reloads++;
    },
  };
  const c = new ReplayController(backend, () => undefined, storage);
  c.attach(feed);
  return { backend, page, c, feed, shown, bars };
}

/** A start at the bar `back` bars before the newest one. */
async function started(candles = 2000, back = 100) {
  const s = await setup(candles);
  const startTime = s.page.time[s.page.time.length - back]!;
  s.c.pick();
  await s.c.start(id, "1h", startTime);
  return { ...s, startTime };
}

const key = (code: string, extra: Partial<ReplayKey> = {}): ReplayKey => ({
  code,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  target: null,
  ...extra,
});

describe("replay controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts from picking at a bar and shows the context and the start bar only", async () => {
    const { c, feed, shown, startTime } = await started();
    expect(c.phase).toBe("on");
    expect(feed.shows).toBe(1);
    expect(shown).toHaveLength(501);
    expect(shown.at(-1)).toBe(startTime);
    expect(c.view).toMatchObject({ start: 500, current: 500, time: startTime, atEnd: false, open: null });
    expect(c.view).toMatchObject({ tf: "1h", base: "1h", caughtUp: false, partial: false });
    expect(c.replays(id)).toBe(true);
    expect(c.replays({ source: "mock", symbol: "ETHUSDT" })).toBe(false);
  });

  it("only starts while picking, and a refused start goes back to off with the message", async () => {
    const { c, page } = await setup();
    await c.start(id, "1h", page.time.at(-1)!);
    expect(c.phase).toBe("off");
    c.pick();
    expect(c.phase).toBe("picking");
    c.cancelPick();
    expect(c.phase).toBe("off");
    c.pick();
    await c.start(id, "1h", page.time.at(-1)! + 1);
    expect(c.phase).toBe("off");
    expect(c.error).toBe(`no cached 1h bar opens at ${page.time.at(-1)! + 1}`);
  });

  /** `replayStart` held until `release()`: the call is in flight meanwhile. */
  function holdStart(backend: Awaited<ReturnType<typeof setup>>["backend"]) {
    const real = backend.replayStart.bind(backend);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const start = vi.spyOn(backend, "replayStart").mockImplementation(async (...args) => {
      await gate;
      return real(...args);
    });
    const exit = vi.spyOn(backend, "replayExit");
    return { start, exit, release: () => release() };
  }

  it("a start cancelled while in flight ends the engine's replay and stays off", async () => {
    const { c, backend, page, feed } = await setup();
    const held = holdStart(backend);
    c.pick();
    const started = c.start(id, "1h", page.time.at(-50)!);
    c.cancelPick();
    held.release();
    await started;
    expect(c.phase).toBe("off");
    expect(c.view).toBeNull();
    expect(c.error).toBeNull();
    expect(feed.shows).toBe(0);
    expect(held.exit).toHaveBeenCalledTimes(1);
    await expect(backend.replayState("1h", 0, 0)).rejects.toMatchObject({ message: "no replay is open" });
  });

  it("a start overtaken by another chart (exit while picking) stays off", async () => {
    const { c, backend, page, feed } = await setup();
    const held = holdStart(backend);
    c.pick();
    const started = c.start(id, "1h", page.time.at(-50)!);
    await c.exit(false);
    held.release();
    await started;
    expect(c.phase).toBe("off");
    expect(feed.shows).toBe(0);
    await expect(backend.replayState("1h", 0, 0)).rejects.toMatchObject({ message: "no replay is open" });
    // Picking again later works.
    held.start.mockRestore();
    c.pick();
    await c.start(id, "1h", page.time.at(-50)!);
    expect(c.phase).toBe("on");
  });

  it("a second click while a start is in flight starts nothing more", async () => {
    const { c, backend, page, feed } = await setup();
    const held = holdStart(backend);
    c.pick();
    const first = c.start(id, "1h", page.time.at(-50)!);
    const second = c.start(id, "1h", page.time.at(-40)!);
    held.release();
    await Promise.all([first, second]);
    expect(held.start).toHaveBeenCalledTimes(1);
    expect(c.phase).toBe("on");
    expect(c.view!.time).toBe(page.time.at(-50));
    expect(feed.shows).toBe(1);
  });

  it("steps one bar at a time and appends only the new bars", async () => {
    const { c, shown, page, feed } = await started();
    await c.step();
    await c.step();
    expect(c.view!.current).toBe(502);
    expect(shown).toHaveLength(503);
    expect(shown.slice(-3)).toEqual(page.time.slice(-100, -97));
    expect(feed.shows).toBe(1);
    expect(c.view!.close).toBe(page.close[page.time.length - 98]);
  });

  it("keeps a failed load of newer bars as a notice, not an error, and keeps playing", async () => {
    const { c, backend } = await started();
    const real = backend.replayState.bind(backend);
    const state = vi.spyOn(backend, "replayState").mockImplementation(async (...args) => ({
      ...(await real(...args)),
      newerError: "the newest 1h candles could not be loaded: network error",
    }));
    c.play();
    await c.step();
    expect(c.view!.newerError).toBe("the newest 1h candles could not be loaded: network error");
    expect(c.error).toBeNull();
    expect(c.playing).toBe(true);
    c.pause();
    state.mockRestore();
    await c.step();
    expect(c.view!.newerError).toBeNull();
  });

  it("plays at the chosen speed with one timer and stops at the end", async () => {
    vi.useFakeTimers();
    const { c } = await started(560); // 99 bars after the start bar
    const start = c.view!.current;
    c.play();
    expect(c.playing).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(c.view!.current).toBe(start);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.view!.current).toBe(start + 1);
    c.setSpeed(10);
    await vi.advanceTimersByTimeAsync(500);
    expect(c.view!.current).toBe(start + 6);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.view!.atEnd).toBe(true);
    expect(c.view!.current).toBe(start + 99);
    expect(c.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    c.play();
    expect(c.playing).toBe(false);
  });

  it("pauses when the window is hidden, leaving no timer", async () => {
    vi.useFakeTimers();
    const { c } = await started();
    c.togglePlay();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(c.view!.current).toBe(502);
    c.visibility(true);
    expect(c.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.view!.current).toBe(502);
    c.visibility(false);
    expect(c.playing).toBe(false);
  });

  it("buys at the close with the default stop and take, one trade at a time", async () => {
    const { c } = await started();
    const close = c.view!.close;
    await c.buy();
    const t = c.view!.open!;
    expect(t).toMatchObject({ side: "long", entryPrice: close, reason: "open", ...defaultLevels("long", close) });
    expect(t.take - close).toBe(2 * (close - t.stop));
    await c.sell();
    expect(c.view!.trades).toHaveLength(1);
    expect(c.error).toBeNull();
    // Two clicks before the first answer: one trade, no error.
    await c.closeTrade();
    await Promise.all([c.buy(), c.buy(), c.closeTrade(), c.closeTrade()]);
    expect(c.view!.trades).toHaveLength(2);
    expect(c.error).toBeNull();
  });

  it("edits only changed levels, refuses invalid ones, and closes manually", async () => {
    const { c, backend, startTime } = await started();
    const H = 3_600_000;
    const sent: ReplayCommand[] = [];
    const send = backend.replayCommand.bind(backend);
    vi.spyOn(backend, "replayCommand").mockImplementation((cmd) => {
      sent.push(cmd);
      return send(cmd);
    });
    await c.sell();
    const t = c.view!.open!;
    const close = c.view!.close;
    await c.edit(t.stop, t.take); // nothing changed: nothing sent
    await c.edit(close - 1, t.take); // a short's stop below the close: refused here
    // Far levels, so the next (noisy) mock bar reaches neither.
    await c.edit(t.stop + 2_000, t.take);
    await c.edit(t.stop + 2_000, t.take - 2_000);
    expect(sent.slice(1)).toEqual([
      // Commands carry the cut: the close time of the current bar.
      { kind: "edit", time: startTime + H, stop: t.stop + 2_000 },
      { kind: "edit", time: startTime + H, take: t.take - 2_000 },
    ]);
    await c.step();
    await c.closeTrade();
    expect(sent.at(-1)).toEqual({ kind: "close", time: startTime + 2 * H });
    expect(c.view!.open).toBeNull();
    expect(c.view!.trades[0]).toMatchObject({ reason: "manual", exitTime: startTime + H, initialStop: t.stop });
    expect(c.view!.stats.count).toBe(1);
  });

  it("drops an edit queued behind a close, without a message and without stopping Play", async () => {
    vi.useFakeTimers();
    const { c, backend } = await started();
    await c.buy();
    const t = c.view!.open!;
    const sent = vi.spyOn(backend, "replayCommand");
    c.play();
    await Promise.all([c.closeTrade(), c.edit(t.stop - 10, t.take)]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(c.error).toBeNull();
    expect(c.playing).toBe(true);
    c.pause();
  });

  it("checks a queued edit against the close of the bar it is sent at", async () => {
    const { c, backend, page } = await started();
    await c.buy();
    const t0 = c.view!.open!;
    // Far levels first, so the next bar reaches neither.
    await c.edit(Math.round(t0.entryPrice / 2), t0.entryPrice * 2);
    const t = c.view!.open!;
    const now = c.view!.close;
    const next = page.close[page.time.length - 99]!;
    // Valid at this close, not at the next one: the level the next close crosses.
    const [stop, take] = next < now ? [next, t.take] : [t.stop, next];
    const sent = vi.spyOn(backend, "replayCommand");
    await Promise.all([c.step(), c.edit(stop, take)]);
    expect(c.view!.close).toBe(next);
    expect(sent).not.toHaveBeenCalled();
    expect(c.error).toBeNull();
    expect(c.view!.open).toMatchObject({ stop: t.stop, take: t.take });
  });

  it("keeps the engine's message when a command is refused and stops Play", async () => {
    const { c, backend } = await started();
    vi.spyOn(backend, "replayCommand").mockRejectedValueOnce({ code: "other", message: "command 1: refused" });
    c.play();
    await c.buy();
    expect(c.error).toBe("command 1: refused");
    expect(c.playing).toBe(false);
    expect(c.view!.open).toBeNull();
  });

  it("saves, exits with a reload, and opens the saved text to the same results", async () => {
    const { c, backend, feed } = await started();
    const switched: string[] = [];
    c.onSwitch((i, tf) => switched.push(`${i.symbol}/${tf}`));
    await c.buy();
    await c.step();
    await c.step();
    await c.save();
    const before = c.view!;
    const text = backend.replayFile()!;
    expect(text).toContain('"version": 2');

    await c.exit();
    expect(c.phase).toBe("off");
    expect(c.view).toBeNull();
    expect(feed.reloads).toBe(1);
    await expect(backend.replayState("1h", 0, 0)).rejects.toMatchObject({ message: "no replay is open" });

    await c.open(new TextEncoder().encode(text));
    expect(c.phase).toBe("on");
    expect(switched).toEqual(["BTCUSDT/1h"]);
    expect(c.view!.stats).toEqual(before.stats);
    expect(c.view!.trades).toEqual(before.trades);
    expect(c.view!.current).toBe(before.current);
    expect(c.view!.atEnd).toBe(true);
  });

  it("says why a broken file was refused and keeps the session", async () => {
    const { c, backend } = await started();
    await c.step();
    await c.open(new TextEncoder().encode("{}"));
    expect(c.fileError?.detail).toMatch(/./);
    expect(c.phase).toBe("on");
    expect((await backend.replayState("1h", 0, 0)).current).toBe(501);
    await c.step();
    expect(c.error).toBeNull();
  });

  /** `method` of the backend held until `release()`: the call is in flight meanwhile. */
  function hold<K extends "replayState" | "replaySetBase" | "replayStep">(backend: Awaited<ReturnType<typeof setup>>["backend"], method: K) {
    const real = (backend[method] as (...a: unknown[]) => Promise<unknown>).bind(backend);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(backend, method).mockImplementation((async (...args: unknown[]) => {
      await gate;
      return real(...args);
    }) as never);
    return { spy, release: () => release() };
  }

  it("another pair picked while a step is on its way: off at once, and the old bars never reach the new chart", async () => {
    const { c, backend, feed } = await started();
    const appends = vi.spyOn(feed, "append");
    const held = hold(backend, "replayState");
    const step = c.step();
    // The chart is told to open another pair now; the replay must be gone before it loads.
    const exit = c.exit(false);
    expect(c.phase).toBe("off");
    expect(c.view).toBeNull();
    expect(c.replays(id)).toBe(false);
    held.release();
    await Promise.all([step, exit]);
    expect(appends).not.toHaveBeenCalled();
    expect(feed.shows).toBe(1);
    expect(c.view).toBeNull();
    expect(c.error).toBeNull();
    await expect(backend.replayState("1h", 0, 0)).rejects.toMatchObject({ message: "no replay is open" });
  });

  it("another pair picked during a timeframe switch or a re-base shows nothing of the old one", async () => {
    for (const method of ["replayState", "replaySetBase"] as const) {
      const { c, backend, feed } = await started();
      const held = hold(backend, method);
      const switched = method === "replayState" ? c.setTimeframe("4h") : c.setBase("15m");
      const exit = c.exit(false);
      held.release();
      await Promise.all([switched, exit]);
      expect(feed.shows).toBe(1);
      expect(c.phase).toBe("off");
      expect(c.view).toBeNull();
      expect(c.error).toBeNull();
    }
  });

  it("steps and trades queued behind the step that catches up end quietly", async () => {
    const { c, backend } = await started(2000, 2);
    const sent = vi.spyOn(backend, "replayStep");
    const cmd = vi.spyOn(backend, "replayCommand");
    await Promise.all([c.step(), c.step(), c.step(), c.closeTrade(), c.buy(), c.step()]);
    expect(c.view).toMatchObject({ caughtUp: true, atEnd: true });
    expect(c.error).toBeNull();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(cmd).not.toHaveBeenCalled();
  });

  it("exits without a reload when the user opened another chart, and picking just cancels", async () => {
    const { c, feed } = await started();
    await c.exit(false);
    expect(feed.reloads).toBe(0);
    c.pick();
    await c.exit();
    expect(c.phase).toBe("off");
    expect(feed.reloads).toBe(0);
  });


  it("asks only for the trades after the closed ones it has, and keeps them all", async () => {
    const { c, backend } = await started();
    const asked: number[] = [];
    const state = backend.replayState.bind(backend);
    vi.spyOn(backend, "replayState").mockImplementation((tf, cursor, from) => {
      asked.push(from);
      return state(tf, cursor, from);
    });
    await c.buy();
    await c.closeTrade();
    await c.buy();
    // Far levels: the next bar reaches neither, so the second trade stays open.
    await c.edit(Math.round(c.view!.close / 2), c.view!.close * 2);
    await c.step();
    expect(asked).toEqual([0, 0, 1, 1, 1]);
    expect(c.view!.trades).toHaveLength(2);
    expect(c.view!.trades[0]).toMatchObject({ reason: "manual", exitTime: c.view!.trades[0]!.entryTime });
    expect(c.view!.open).toBe(c.view!.trades[1]);
    expect(c.view!.trades).toEqual((await state("1h", 0, 0)).trades);
  });

  it("keeps each closed trade's object across steps, so its row is not drawn again", async () => {
    const { c } = await started();
    await c.buy();
    await c.closeTrade();
    const closed = c.view!.trades[0]!;
    await c.buy();
    await c.step();
    await c.step();
    expect(c.view!.trades).toHaveLength(2);
    expect(c.view!.trades[0]).toBe(closed);
  });

  it("a held → queues no step while one is on its way", async () => {
    const { c, backend } = await started();
    const sent = vi.spyOn(backend, "replayStep");
    // A press, then key repeats faster than the engine answers.
    const presses = [c.step(), ...Array.from({ length: 20 }, () => c.step(true))];
    await Promise.all(presses);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(c.view!.current).toBe(501);
    // Once it is done, the next repeat steps again.
    await c.step(true);
    expect(c.view!.current).toBe(502);
  });

  it("runs calls one after another, in the order given", async () => {
    const { c, shown } = await started();
    await Promise.all([c.step(), c.buy(), c.step(), c.step()]);
    expect(c.view!.current).toBe(503);
    expect(c.view!.trades[0]!.entryTime).toBe(shown[501]);
    expect(shown).toHaveLength(504);
  });
});

/** A start on the first 1h bar of a 4h bucket, about 100 bars before the newest one. */
async function startedOn4h(candles = 2000) {
  const s = await setup(candles);
  const times = [...s.page.time];
  const startTime = times.slice(0, -100).filter((t) => t % (4 * H) === 0).at(-1)!;
  s.c.pick();
  await s.c.start(id, "1h", startTime);
  return { ...s, startTime };
}

describe("replay across timeframes", () => {
  it("switches to a higher timeframe without a reset, and the forming bar grows with each step", async () => {
    const { c, backend, bars, startTime } = await startedOn4h();
    await c.buy();
    const trades = c.view!.trades;
    const base = vi.spyOn(backend, "replaySetBase");
    await c.setTimeframe("4h");
    expect(base).not.toHaveBeenCalled();
    expect(c.phase).toBe("on");
    expect(c.view).toMatchObject({ tf: "4h", base: "1h", partial: true, cut: startTime + H, trades });
    expect(bars.at(-1)!.time).toBe(startTime);
    const close1 = (await backend.replayState("1h", 0, 0)).bars;
    const highs = [bars.at(-1)!.high];
    for (let k = 1; k <= 3; k++) {
      await c.step();
      expect(bars.at(-1)!.time).toBe(startTime);
      highs.push(bars.at(-1)!.high);
    }
    // Complete now; its close is the close of its last 1h candle.
    expect(c.view!.partial).toBe(false);
    const hourly = (await backend.replayState("1h", 0, 0)).bars;
    expect(bars.at(-1)!.close).toBe(hourly.close.at(-1));
    expect(highs).toEqual([...highs].sort((a, b) => a - b));
    expect(close1.time.length + 3).toBe(hourly.time.length);
    await c.step();
    expect(bars.at(-1)!.time).toBe(startTime + 4 * H);
    expect(c.view!.trades).toHaveLength(1);
    expect(c.view!.trades[0]).toMatchObject({ entryTime: trades[0]!.entryTime, entryPrice: trades[0]!.entryPrice });
  });

  it("re-bases on a lower timeframe and keeps the trades", async () => {
    const { c, backend, bars, startTime } = await startedOn4h();
    await c.step();
    await c.buy();
    const before = c.view!.open!;
    const base = vi.spyOn(backend, "replaySetBase");
    await c.setTimeframe("15m");
    expect(base).toHaveBeenCalledWith("15m");
    expect(c.view).toMatchObject({ tf: "15m", base: "15m", cut: startTime + 2 * H });
    expect(bars.at(-1)!.time).toBe(startTime + 2 * H - H / 4);
    expect(c.view!.trades).toHaveLength(1);
    expect(c.view!.open).toMatchObject({ side: "long", entryPrice: before.entryPrice, stop: before.stop, take: before.take });
    // Back up to 1h: built from the 15m candles, no re-base.
    await c.setTimeframe("1h");
    expect(base).toHaveBeenCalledTimes(1);
    expect(c.view).toMatchObject({ tf: "1h", base: "15m" });
    await c.step();
    expect(c.view).toMatchObject({ partial: true, cut: startTime + 2 * H + H / 4 });
  });

  it("puts the chart back on its timeframe when the replay cannot show the new one", async () => {
    const { c } = await started();
    const switched: string[] = [];
    c.onSwitch((i, tf) => switched.push(`${i.symbol}/${tf}`));
    await c.setTimeframe("3d");
    expect(switched).toEqual(["BTCUSDT/1h"]);
    expect(c.error).toBe("3d candles cannot be built from 1h candles");
    expect(c.view).toMatchObject({ tf: "1h", base: "1h" });
    expect(c.phase).toBe("on");
  });

  it("follows quick switches in order and ends on the last one", async () => {
    const { c, bars } = await started();
    await Promise.all([c.setTimeframe("4h"), c.setTimeframe("1h")]);
    expect(c.view!.tf).toBe("1h");
    expect(bars.at(-1)!.time).toBe(c.view!.time);
  });

  it("changes the update interval, keeps the chart's timeframe, and shows a refusal", async () => {
    const { c, startTime } = await startedOn4h();
    await c.setTimeframe("4h");
    await c.setBase("15m");
    expect(c.view).toMatchObject({ tf: "4h", base: "15m", cut: startTime + H });
    await c.step();
    expect(c.view!.cut).toBe(startTime + H + H / 4);
    // Back to 1h only on a 1h boundary: the engine says where to step to.
    await c.setBase("1h");
    expect(c.error).toMatch(/step to .* first/);
    expect(c.view!.base).toBe("15m");
    for (let k = 0; k < 3; k++) await c.step();
    await c.setBase("1h");
    expect(c.error).toBeNull();
    expect(c.view).toMatchObject({ tf: "4h", base: "1h", cut: startTime + 2 * H });
  });

  it("offers the intervals the chart builds from, and a higher one only on its boundary", () => {
    const tfs = (choices: ReturnType<typeof baseChoices>) => choices.map((ch) => (ch.stepTo === null ? ch.tf : `${ch.tf}@${ch.stepTo}`));
    const at = Date.UTC(2026, 0, 5, 10, 15);
    expect(tfs(baseChoices("1h", "1h", at, TIMEFRAME_CODES))).toEqual(["1m", "3m", "5m", "15m", "30m", "1h"]);
    // Stepping 15m at 10:15 on a 4h chart: 30m from 10:30, 1h from 11:00, 2h and 4h from 12:00.
    expect(tfs(baseChoices("4h", "15m", at, TIMEFRAME_CODES))).toEqual([
      "1m",
      "3m",
      "5m",
      "15m",
      `30m@${at + 15 * 60_000}`,
      `1h@${at + 45 * 60_000}`,
      `2h@${at + 105 * 60_000}`,
      `4h@${at + 105 * 60_000}`,
    ]);
    // 5m and 3m do not line up: a 15m chart stepping 3m cannot step 5m.
    expect(tfs(baseChoices("15m", "3m", Date.UTC(2026, 0, 5, 10, 0), TIMEFRAME_CODES))).toEqual(["1m", "3m", "15m"]);
    // 3d builds only from itself; 1w from 1d and lower.
    expect(tfs(baseChoices("3d", "3d", 0, TIMEFRAME_CODES))).toEqual(["3d"]);
    const week: TimeframeCode[] = baseChoices("1w", "1d", Date.UTC(2026, 0, 5), TIMEFRAME_CODES).map((ch) => ch.tf);
    expect(week).toContain("1d");
    expect(week).not.toContain("3d");
  });
});

describe("replay select bar", () => {
  it("without trades goes straight back to the live chart to pick a new start", async () => {
    const { c, backend, feed, page } = await started();
    await c.step();
    const exit = vi.spyOn(backend, "replayExit");
    await c.selectBar();
    expect(c.confirming).toBeNull();
    expect(c.phase).toBe("picking");
    expect(c.view).toBeNull();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(feed.reloads).toBe(1);
    await c.start(id, "1h", page.time.at(-30)!);
    expect(c.phase).toBe("on");
    expect(c.view!.time).toBe(page.time.at(-30));
  });

  it("with trades asks first; cancel keeps the session, confirm drops it", async () => {
    const { c, backend, feed } = await started();
    await c.buy();
    const exit = vi.spyOn(backend, "replayExit");
    await c.selectBar();
    expect(c.confirming).toBe("select");
    expect(c.phase).toBe("on");
    expect(exit).not.toHaveBeenCalled();
    c.cancelConfirm();
    expect(c.confirming).toBeNull();
    expect(c.view!.trades).toHaveLength(1);
    await c.selectBar();
    await c.confirm();
    expect(c.confirming).toBeNull();
    expect(c.phase).toBe("picking");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(feed.reloads).toBe(1);
  });

  it("forgets a pending question when the replay ends", async () => {
    const { c } = await started();
    await c.buy();
    await c.selectBar();
    await c.exit(false);
    expect(c.confirming).toBeNull();
    expect(c.phase).toBe("off");
  });
});

describe("replay exit and pair switch with trades", () => {
  it("exits at once without trades", async () => {
    const { c, feed } = await started();
    await c.requestExit();
    expect(c.confirming).toBeNull();
    expect(c.phase).toBe("off");
    expect(feed.reloads).toBe(1);
  });

  it("asks before an exit drops trades; cancel keeps them, discard exits", async () => {
    const { c, backend, feed } = await started();
    await c.buy();
    const exit = vi.spyOn(backend, "replayExit");
    await c.requestExit();
    expect(c.confirming).toBe("exit");
    expect(c.phase).toBe("on");
    c.cancelConfirm();
    expect(c.confirming).toBeNull();
    expect(c.view!.trades).toHaveLength(1);
    expect(exit).not.toHaveBeenCalled();
    await c.requestExit();
    await c.confirm();
    expect(c.phase).toBe("off");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(feed.reloads).toBe(1);
  });

  it("holds a pair switch until the answer: cancel never switches, discard does", async () => {
    const { c } = await started();
    await c.buy();
    const go = vi.fn();
    c.requestSwitch(go);
    expect(c.confirming).toBe("switch");
    expect(go).not.toHaveBeenCalled();
    c.cancelConfirm();
    expect(go).not.toHaveBeenCalled();
    expect(c.phase).toBe("on");
    c.requestSwitch(go);
    await c.confirm();
    expect(go).toHaveBeenCalledTimes(1);
    expect(c.confirming).toBeNull();
  });

  it("switches at once without trades or without a replay", async () => {
    const { c } = await started();
    const go = vi.fn();
    c.requestSwitch(go);
    expect(go).toHaveBeenCalledTimes(1);
    await c.exit(false);
    c.requestSwitch(go);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it("save first saves, then goes on; a cancelled save panel keeps asking", async () => {
    const { c, backend } = await started();
    await c.buy();
    const save = vi.spyOn(backend, "replaySave");
    save.mockResolvedValueOnce(null);
    await c.requestExit();
    await c.saveFirst();
    expect(save).toHaveBeenCalledTimes(1);
    expect(c.confirming).toBe("exit");
    expect(c.phase).toBe("on");
    await c.saveFirst();
    expect(save).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(c.phase).toBe("off"));
    expect(c.confirming).toBeNull();
  });

  it("does not ask while the trades are saved as they are, and asks again after a change", async () => {
    const { c } = await started();
    await c.buy();
    await c.save();
    await c.requestExit();
    expect(c.confirming).toBeNull();
    expect(c.phase).toBe("off");

    const again = await started();
    await again.c.buy();
    await again.c.save();
    await again.c.step();
    await again.c.requestExit();
    expect(again.c.confirming).toBe("exit");
  });

  it("a failed save keeps the replay and says why", async () => {
    const { c, backend } = await started();
    await c.buy();
    vi.spyOn(backend, "replaySave").mockRejectedValueOnce(new Error("disk full"));
    const go = vi.fn();
    c.requestSwitch(go);
    await c.saveFirst();
    expect(go).not.toHaveBeenCalled();
    expect(c.phase).toBe("on");
    expect(c.error).toContain("disk full");
  });
});

describe("replay caught up", () => {
  it("jumps to the newest data, then refuses steps and commands without asking the engine", async () => {
    const { c, backend, feed } = await started(2000, 40);
    await c.buy();
    await c.jumpToEnd();
    expect(c.view).toMatchObject({ caughtUp: true, atEnd: true });
    expect(feed.last!.caughtUp).toBe(true);
    const step = vi.spyOn(backend, "replayStep");
    const cmd = vi.spyOn(backend, "replayCommand");
    await c.step();
    await c.jumpToEnd();
    await c.buy();
    await c.closeTrade();
    c.play();
    expect(c.playing).toBe(false);
    expect(step).not.toHaveBeenCalled();
    expect(cmd).not.toHaveBeenCalled();
    expect(c.error).toBeNull();
  });

  it("jumps reading only the flags, at the base, and the whole chart once at the end", async () => {
    const { c, backend } = await started(2000, 40);
    await c.setTimeframe("4h");
    const asked = vi.spyOn(backend, "replayState");
    await c.jumpToEnd();
    const calls = asked.mock.calls;
    expect(calls.at(-1)).toEqual(["4h", 0, 0]);
    for (const [tf, cursor] of calls.slice(0, -1)) expect([tf, cursor]).toEqual(["1h", 0xffff_ffff]);
    expect(c.view).toMatchObject({ tf: "4h", caughtUp: true });
  });

  it("asks the live chart to follow when a step catches up", async () => {
    const { c, feed } = await started(2000, 2);
    expect(c.view!.caughtUp).toBe(false);
    await c.step();
    expect(c.view!.caughtUp).toBe(true);
    expect(feed.follows).toBe(1);
  });

  it("ends the backtest at the catch-up cut: the open trade is unfinished and live candles change nothing", async () => {
    const { c, backend } = await started(2000, 40);
    await c.buy();
    // Far levels: no bar until the newest one reaches either.
    await c.edit(Math.round(c.view!.close / 2), c.view!.close * 2);
    await c.jumpToEnd();
    const v = c.view!;
    expect(v.caughtUpAt).toBe(v.cut);
    expect(c.finished).toBe(true);
    expect(v.open).toBeNull();
    expect(v.trades).toHaveLength(1);
    expect(v.trades[0]).toMatchObject({ reason: "unfinished", exitTime: null });
    expect(v.stats.count).toBe(0);
    // The chart's live stream of the pair flows again, but the replay stays at its cut.
    const got: LiveEvent[] = [];
    await backend.subscribeLive(id, "1h", (e) => got.push(e));
    const last = v.time;
    backend.emitLive({ kind: "candle", time: last + H, open: 1, high: 2, low: 1, close: 2, volume: 1, closed: true });
    expect(got).toHaveLength(1);
    const st = await backend.replayState("1h", 0, 0);
    expect(st).toMatchObject({ cut: v.cut, caughtUpAt: v.cut });
    expect(st.trades[0]!.reason).toBe("unfinished");
  });

  it("stays finished on another timeframe and another update interval", async () => {
    const { c } = await started(2000, 40);
    await c.jumpToEnd();
    const at = c.view!.cut;
    await c.setTimeframe("15m");
    expect(c.view).toMatchObject({ tf: "15m", base: "15m", cut: at, caughtUpAt: at, atEnd: true });
    await c.step();
    expect(c.error).toBeNull();
    expect(c.view!.cut).toBe(at);
  });
});

describe("replay results panel", () => {
  it("remembers whether it is collapsed", async () => {
    const store = new Map<string, string>();
    const storage: KeyValue = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) };
    const { c } = await setup(2000, storage);
    expect(c.resultsCollapsed).toBe(false);
    c.toggleResults();
    expect(c.resultsCollapsed).toBe(true);
    expect(store.get(RESULTS_COLLAPSED_KEY)).toBe("1");
    const again = await setup(2000, storage);
    expect(again.c.resultsCollapsed).toBe(true);
  });

  it("works without storage", async () => {
    const broken: KeyValue = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const { c } = await setup(2000, broken);
    expect(c.resultsCollapsed).toBe(false);
    c.toggleResults();
    expect(c.resultsCollapsed).toBe(true);
  });
});

describe("replay levels", () => {
  it("puts the stop 1.5 % away and the take at 2R", () => {
    expect(defaultLevels("long", 10_000)).toEqual({ stop: 9_850, take: 10_300 });
    expect(defaultLevels("short", 10_000)).toEqual({ stop: 10_150, take: 9_700 });
    expect(defaultLevels("long", 10)).toEqual({ stop: 9, take: 12 });
  });

  it("checks and clamps levels against the close like the engine", () => {
    expect(validLevels("long", 100, 99, 101)).toBe(true);
    expect(validLevels("long", 100, 100, 101)).toBe(false);
    expect(validLevels("short", 100, 101, 99)).toBe(true);
    expect(validLevels("short", 100, 99, 101)).toBe(false);
    expect(clampLevel("long", "stop", 100, 150)).toBe(99);
    expect(clampLevel("long", "take", 100, 50)).toBe(101);
    expect(clampLevel("short", "stop", 100, 50)).toBe(101);
    expect(clampLevel("short", "take", 100, 150)).toBe(99);
    expect(clampLevel("long", "stop", 100, 80)).toBe(80);
  });
});

describe("replay keys", () => {
  it("maps → Space and Shift+B/S/C while replaying, Esc while picking", () => {
    expect(replayKeyAction(key("ArrowRight"), "on")).toBe("step");
    expect(replayKeyAction(key("Space"), "on")).toBe("play");
    expect(replayKeyAction(key("KeyB", { shiftKey: true }), "on")).toBe("buy");
    expect(replayKeyAction(key("KeyS", { shiftKey: true }), "on")).toBe("sell");
    expect(replayKeyAction(key("KeyC", { shiftKey: true }), "on")).toBe("close");
    expect(replayKeyAction(key("Escape"), "picking")).toBe("cancel");
    expect(replayKeyAction(key("Escape"), "on")).toBeNull();
    expect(replayKeyAction(key("ArrowRight"), "off")).toBeNull();
    expect(replayKeyAction(key("Space"), "picking")).toBeNull();
  });

  it("leaves the drawing tools' Alt keys, ⌘ keys, typing and held keys alone", () => {
    expect(replayKeyAction(key("KeyB", { altKey: true }), "on")).toBeNull();
    expect(replayKeyAction(key("KeyS", { altKey: true, shiftKey: true }), "on")).toBeNull();
    expect(replayKeyAction(key("KeyB"), "on")).toBeNull();
    expect(replayKeyAction(key("ArrowRight", { metaKey: true }), "on")).toBeNull();
    expect(replayKeyAction(key("ArrowRight", { target: { tagName: "INPUT", type: "date" } }), "on")).toBeNull();
    expect(replayKeyAction(key("Space", { target: { tagName: "BUTTON" } }), "on")).toBeNull();
    expect(replayKeyAction(key("Space", { repeat: true }), "on")).toBeNull();
    expect(replayKeyAction(key("ArrowRight", { repeat: true }), "on")).toBe("step");
  });
});

describe("refused replay files", () => {
  it("sorts the engine's words into what the user is told", () => {
    expect(replayFileProblem("not a replay file: expected value at line 1 column 1")).toBe("notFile");
    expect(replayFileProblem("not a replay file: missing field `version`")).toBe("notFile");
    expect(replayFileProblem("replay file version 3 is not supported (this app reads versions 1 and 2)")).toBe("version");
    expect(replayFileProblem("the replay file is 40 MiB; the limit is 32 MiB")).toBe("tooLarge");
    expect(replayFileProblem("the candles do not match the file's sha256")).toBe("damaged");
    expect(replayFileProblem("command 2: no open trade to close")).toBe("damaged");
  });

  it("keeps the open replay, says why, and forgets it on dismiss or the next file", async () => {
    const { c } = await started();
    await c.buy();
    await c.open(new TextEncoder().encode("{}"));
    expect(c.fileError).toEqual({ kind: "notFile", detail: "not a replay file: missing field `version`" });
    expect(c.error).toBeNull();
    expect(c.phase).toBe("on");
    expect(c.view!.trades).toHaveLength(1);
    c.dismissFileError();
    expect(c.fileError).toBeNull();
    await c.open(new TextEncoder().encode('{"version": 9}'));
    expect(c.fileError?.kind).toBe("version");
  });
});
