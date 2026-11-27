import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend, UpdateInfo, UpdateProgress } from "../backend/types";
import { AUTO_KEY, CHECK_EVERY_MS, FIRST_CHECK_MS, TICK_MS, UpdateState, type KeyValueStore } from "./update";

const INFO: UpdateInfo = { version: "0.3.0", notes: "Fixes", date: null, blocker: null };

interface Install {
  onProgress: (p: UpdateProgress) => void;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/** The update part of a backend; every check and install waits until the test settles it. */
function fakeBackend() {
  const checks: { resolve: (i: UpdateInfo | null) => void; reject: (e: unknown) => void }[] = [];
  const installs: Install[] = [];
  const backend = {
    checkUpdate: () => new Promise<UpdateInfo | null>((resolve, reject) => checks.push({ resolve, reject })),
    installUpdate: (onProgress: (p: UpdateProgress) => void) =>
      new Promise<void>((resolve, reject) => installs.push({ onProgress, resolve, reject })),
  } as unknown as Backend;
  return { backend, checks, installs };
}

/** A scheduler the test runs by hand. */
function manualScheduler() {
  const due: { fn: () => void; ms: number }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    due.push({ fn, ms });
  };
  /** Runs what is due now (not what that schedules) and returns their delays. */
  const runDue = () => {
    const now = due.splice(0);
    for (const d of now) d.fn();
    return now.map((d) => d.ms);
  };
  return { due, schedule, runDue };
}

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A wall clock the test moves by hand. */
function fakeClock() {
  const clock = { t: Date.UTC(2026, 10, 28), now: () => clock.t };
  return clock;
}

function setup(store = memoryStore()) {
  const fake = fakeBackend();
  const sched = manualScheduler();
  const clock = fakeClock();
  const state = new UpdateState(fake.backend, () => undefined, sched.schedule, store, clock.now);
  return { ...fake, sched, state, store, clock };
}

/** A state that already found `INFO` with a manual check. */
async function withUpdate() {
  const s = setup();
  const done = s.state.checkNow();
  s.checks[0]!.resolve(INFO);
  await done;
  return s;
}

describe("UpdateState", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs the hourly ticks, moving the wall clock with them, for `hours`. */
  async function tickHours(s: ReturnType<typeof setup>, hours: number) {
    for (let h = 0; h < hours; h++) {
      s.clock.t += TICK_MS;
      s.sched.runDue();
      await flush();
    }
  }

  it("checks 10 s after start, then every 24 h of wall-clock time on hourly ticks", async () => {
    const s = setup();
    const { state, sched, checks } = s;
    expect(state.auto).toBe(true);
    state.start();
    expect(sched.due.map((d) => d.ms)).toEqual([FIRST_CHECK_MS]);
    expect(FIRST_CHECK_MS).toBe(10_000);
    expect(checks).toHaveLength(0);

    sched.runDue();
    expect(checks).toHaveLength(1);
    expect(sched.due.map((d) => d.ms)).toEqual([TICK_MS]);
    expect(TICK_MS).toBe(3_600_000);
    expect(CHECK_EVERY_MS).toBe(86_400_000);
    checks[0]!.resolve(null);
    await flush();

    await tickHours(s, 23);
    expect(checks).toHaveLength(1);
    await tickHours(s, 1);
    expect(checks).toHaveLength(2);
    expect(sched.due.map((d) => d.ms)).toEqual([TICK_MS]);
  });

  it("checks at the next tick after the clock jumped 30 h (the Mac slept)", async () => {
    const s = setup();
    s.state.start();
    s.sched.runDue();
    s.checks[0]!.resolve(null);
    await flush();
    // One timer tick of awake time, 30 h of wall-clock time.
    s.clock.t += 30 * 3_600_000;
    s.sched.runDue();
    expect(s.checks).toHaveLength(2);
  });

  it("checks on wake when one is due, and not before", async () => {
    const s = setup();
    s.state.start();
    s.sched.runDue();
    s.checks[0]!.resolve(null);
    await flush();
    s.clock.t += 5 * 3_600_000;
    s.state.wake();
    expect(s.checks).toHaveLength(1);
    s.clock.t += 20 * 3_600_000;
    s.state.wake();
    expect(s.checks).toHaveLength(2);
  });

  it("a failed or manual check also counts as the last check", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = setup();
    s.state.start();
    s.sched.runDue();
    s.checks[0]!.reject({ code: "other", message: "offline" });
    await flush();
    await tickHours(s, 23);
    expect(s.checks).toHaveLength(1);
    const manual = s.state.checkNow();
    s.checks[1]!.resolve(null);
    await manual;
    await tickHours(s, 23);
    expect(s.checks).toHaveLength(2);
    await tickHours(s, 1);
    expect(s.checks).toHaveLength(3);
  });

  it("stop cancels the ticks and wake", async () => {
    const s = setup();
    s.state.start();
    s.state.stop();
    await tickHours(s, 72);
    s.state.wake();
    expect(s.checks).toHaveLength(0);
  });

  it("with auto off makes no check after start, even after days of ticks and wakes", async () => {
    const s = setup(memoryStore({ [AUTO_KEY]: "0" }));
    expect(s.state.auto).toBe(false);
    s.state.start();
    for (let day = 0; day < 3; day++) {
      await tickHours(s, 24);
      s.clock.t += 30 * 3_600_000;
      s.state.wake();
    }
    await flush();
    expect(s.checks).toHaveLength(0);
  });

  it("turning auto off stops the scheduled checks and is stored", async () => {
    const { state, sched, checks, store } = setup();
    state.start();
    state.setAuto(false);
    expect(store.data[AUTO_KEY]).toBe("0");
    for (let i = 0; i < 3; i++) sched.runDue();
    expect(checks).toHaveLength(0);

    state.setAuto(true);
    expect(store.data[AUTO_KEY]).toBe("1");
    expect(state.auto).toBe(true);
    expect(sched.due.at(-1)!.ms).toBe(FIRST_CHECK_MS);
    sched.runDue();
    expect(checks).toHaveLength(1);
  });

  it("reads anything but \"0\" as auto on and survives a throwing storage", () => {
    expect(setup(memoryStore({ [AUTO_KEY]: "yes" })).state.auto).toBe(true);
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const state = new UpdateState(fakeBackend().backend, () => undefined, () => undefined, throwing);
    expect(state.auto).toBe(true);
    expect(() => state.setAuto(false)).not.toThrow();
    expect(state.auto).toBe(false);
  });

  it("an auto check that fails stays silent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state, sched, checks, clock } = setup();
    state.start();
    sched.runDue();
    checks[0]!.reject({ code: "other", message: "offline" });
    await flush();
    expect(state.phase).toBe("idle");
    expect(state.error).toBeNull();
    expect(state.available).toBeNull();
    // ...and the first tick 24 h later tries again.
    clock.t += CHECK_EVERY_MS;
    sched.runDue();
    expect(checks).toHaveLength(2);
  });

  it("an auto check that finds an update makes it available", async () => {
    const { state, sched, checks } = setup();
    state.start();
    sched.runDue();
    checks[0]!.resolve(INFO);
    await flush();
    expect(state.available).toEqual(INFO);
    expect(state.phase).toBe("idle");
  });

  it("a manual check that fails shows the error", async () => {
    const { state, checks } = setup();
    const done = state.checkNow();
    expect(state.phase).toBe("checking");
    checks[0]!.reject({ code: "other", message: "could not reach the update server" });
    await done;
    expect(state.phase).toBe("error");
    expect(state.error).toBe("could not reach the update server");
  });

  it("a manual check with no update says it is up to date", async () => {
    const { state, checks } = setup(memoryStore({ [AUTO_KEY]: "0" }));
    const done = state.checkNow();
    checks[0]!.resolve(null);
    await done;
    expect(state.phase).toBe("upToDate");
    expect(state.available).toBeNull();
  });

  it("maps install progress to a fraction, null while the size is unknown", async () => {
    const { state, installs } = await withUpdate();
    void state.install();
    await flush();
    expect(state.phase).toBe("downloading");
    const { onProgress } = installs[0]!;
    onProgress({ kind: "started", total: 200 });
    expect(state.progress).toBe(0);
    onProgress({ kind: "chunk", downloaded: 50 });
    expect(state.progress).toBe(0.25);
    onProgress({ kind: "chunk", downloaded: 200 });
    expect(state.progress).toBe(1);
    onProgress({ kind: "installing" });
    expect(state.phase).toBe("installing");
  });

  it("an unknown size gives a null progress", async () => {
    const { state, installs } = await withUpdate();
    void state.install();
    await flush();
    installs[0]!.onProgress({ kind: "started", total: null });
    installs[0]!.onProgress({ kind: "chunk", downloaded: 999 });
    expect(state.progress).toBeNull();
  });

  it("a failed install keeps the update and the retry checks again first", async () => {
    const { state, installs, checks } = await withUpdate();
    let done = state.install();
    await flush();
    installs[0]!.onProgress({ kind: "started", total: 100 });
    installs[0]!.onProgress({ kind: "chunk", downloaded: 40 });
    installs[0]!.reject({ code: "other", message: "connection reset" });
    await done;
    expect(state.phase).toBe("error");
    expect(state.error).toBe("connection reset");
    expect(state.available).toEqual(INFO);

    done = state.install();
    await flush();
    // Rust kept nothing of the failed attempt: a fresh check runs before the download.
    expect(checks).toHaveLength(2);
    expect(installs).toHaveLength(1);
    expect(state.error).toBeNull();
    checks[1]!.resolve(INFO);
    await flush();
    expect(installs).toHaveLength(2);
    expect(state.progress).toBeNull();
    installs[1]!.resolve();
    await done;
    expect(state.phase).toBe("restarting");
  });

  it("an error after installing is shown, not swallowed", async () => {
    const { state, installs } = await withUpdate();
    const done = state.install();
    await flush();
    installs[0]!.onProgress({ kind: "installing" });
    installs[0]!.reject({ code: "other", message: "signature mismatch" });
    await done;
    expect(state.phase).toBe("error");
    expect(state.error).toBe("signature mismatch");
  });

  it("an install that never answers stays installing, with no error", async () => {
    const { state, installs, sched, checks } = await withUpdate();
    state.start();
    void state.install();
    await flush();
    installs[0]!.onProgress({ kind: "installing" });
    for (let i = 0; i < 5; i++) sched.runDue(); // days of scheduled time
    await flush();
    expect(state.phase).toBe("installing");
    expect(state.error).toBeNull();
    // No automatic check runs during an install.
    expect(checks).toHaveLength(1);
  });

  it("an auto check that finds an update replaces a stale up-to-date answer", async () => {
    const { state, sched, checks, clock } = setup();
    const done = state.checkNow();
    checks[0]!.resolve(null);
    await done;
    expect(state.phase).toBe("upToDate");
    state.start();
    clock.t += CHECK_EVERY_MS;
    sched.runDue();
    checks[1]!.resolve(INFO);
    await flush();
    expect(state.phase).toBe("idle");
    expect(state.shown).toBe(true);
  });

  it("install waits for a check in flight and keeps its update on screen", async () => {
    const { state, sched, checks, installs, clock } = await withUpdate();
    state.start();
    clock.t += CHECK_EVERY_MS;
    sched.runDue(); // an automatic check starts...
    expect(checks).toHaveLength(2);
    const done = state.install(); // ...and the user presses Install before it answers
    await flush();
    expect(installs).toHaveLength(0);
    expect(state.phase).toBe("downloading");
    checks[1]!.resolve({ ...INFO, version: "0.3.1" });
    await flush();
    expect(installs).toHaveLength(1);
    expect(state.shown).toBe(true);
    expect(state.available?.version).toBe("0.3.1");
    installs[0]!.resolve();
    await done;
    expect(state.phase).toBe("restarting");
  });

  it("install does not download when the check in flight found nothing", async () => {
    const { state, sched, checks, installs, clock } = await withUpdate();
    state.start();
    clock.t += CHECK_EVERY_MS;
    sched.runDue();
    const done = state.install();
    checks[1]!.resolve(null);
    await done;
    expect(installs).toHaveLength(0);
    expect(state.phase).toBe("upToDate");
    expect(state.available).toBeNull();
  });

  it("install goes on when the check in flight fails (Rust keeps the update)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state, sched, checks, installs, clock } = await withUpdate();
    state.start();
    clock.t += CHECK_EVERY_MS;
    sched.runDue();
    void state.install();
    checks[1]!.reject({ code: "other", message: "offline" });
    await flush();
    expect(installs).toHaveLength(1);
    expect(state.available).toEqual(INFO);
  });

  it("does not install a blocked update", async () => {
    const { state, checks, installs } = setup();
    const done = state.checkNow();
    checks[0]!.resolve({ ...INFO, blocker: "translocated" });
    await done;
    await state.install();
    expect(installs).toHaveLength(0);
    expect(state.phase).toBe("idle");
  });

  it("later hides the update until the next start", async () => {
    const { state } = await withUpdate();
    expect(state.shown).toBe(true);
    state.later();
    expect(state.shown).toBe(false);
    expect(state.available).toEqual(INFO);
    state.start();
    expect(state.shown).toBe(true);
  });

  it("notifies on every change", async () => {
    const { backend, checks } = fakeBackend();
    const onChange = vi.fn();
    const state = new UpdateState(backend, onChange, () => undefined, memoryStore());
    const done = state.checkNow();
    checks[0]!.resolve(INFO);
    await done;
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // WebKit (the macOS and Linux app) throws "Can only call Window.setTimeout on instances of
  // Window" when setTimeout runs with another `this`; Chromium does not, so e2e missed it.
  it("the default scheduler calls setTimeout without a foreign this", () => {
    const strict = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Can only call Window.setTimeout on instances of Window");
      return 0;
    });
    vi.stubGlobal("setTimeout", strict);
    const state = new UpdateState(fakeBackend().backend, () => undefined, undefined, memoryStore());
    expect(() => state.start()).not.toThrow();
    expect(strict).toHaveBeenCalled();
  });
});
