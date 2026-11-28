import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBackend } from "../backend/mock";
import type { CandleColumns, ReplayCommand, ReplayState } from "../backend/types";
import { clampLevel, defaultLevels, ReplayController, replayKeyAction, validLevels, type ReplayKey } from "./replay";

const id = { source: "mock", symbol: "BTCUSDT" };

/** A controller on the mock (no latency) with a feed that keeps what the chart would show. */
async function setup(candles = 2000) {
  const backend = createMockBackend({ candles });
  const page = await backend.getCandles(id, "1h");
  const shown: number[] = [];
  const feed = {
    shows: 0,
    reloads: 0,
    show(st: ReplayState) {
      this.shows++;
      shown.length = 0;
      shown.push(...st.bars.time);
    },
    append(bars: CandleColumns) {
      shown.push(...bars.time);
    },
    reload() {
      this.reloads++;
    },
  };
  const c = new ReplayController(backend, () => undefined);
  c.attach(feed);
  return { backend, page, c, feed, shown };
}

async function started(candles = 2000) {
  const s = await setup(candles);
  const startTime = s.page.time[s.page.time.length - 100]!;
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
    expect(c.matches(id, "1h")).toBe(true);
    expect(c.matches(id, "4h")).toBe(false);
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

  it("shows the engine's message for a broken file and keeps the session", async () => {
    const { c, backend } = await started();
    await c.step();
    await c.open(new TextEncoder().encode("{}"));
    expect(c.error).toMatch(/./);
    expect(c.phase).toBe("on");
    expect((await backend.replayState("1h", 0, 0)).current).toBe(501);
    await c.step();
    expect(c.error).toBeNull();
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

  it("resyncs every revealed bar when the chart comes back to the replay", async () => {
    const { c, feed, shown } = await started();
    await c.step();
    await c.resync();
    expect(feed.shows).toBe(2);
    expect(shown).toHaveLength(502);
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
