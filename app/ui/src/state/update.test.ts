import { afterEach, describe, expect, it, vi } from "vitest";
import type { Backend, UpdateInfo, UpdateProgress } from "../backend/types";
import { AUTO_KEY, CHECK_EVERY_MS, FIRST_CHECK_MS, UpdateState, type KeyValueStore } from "./update";

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

function setup(store = memoryStore()) {
  const fake = fakeBackend();
  const sched = manualScheduler();
  const state = new UpdateState(fake.backend, () => undefined, sched.schedule, store);
  return { ...fake, sched, state, store };
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

  it("checks 10 s after start, then every 24 h", async () => {
    const { state, sched, checks } = setup();
    expect(state.auto).toBe(true);
    state.start();
    expect(sched.due.map((d) => d.ms)).toEqual([FIRST_CHECK_MS]);
    expect(FIRST_CHECK_MS).toBe(10_000);
    expect(checks).toHaveLength(0);

    sched.runDue();
    expect(checks).toHaveLength(1);
    expect(sched.due.map((d) => d.ms)).toEqual([CHECK_EVERY_MS]);
    expect(CHECK_EVERY_MS).toBe(86_400_000);
    checks[0]!.resolve(null);
    await flush();

    sched.runDue();
    expect(checks).toHaveLength(2);
    expect(sched.due.map((d) => d.ms)).toEqual([CHECK_EVERY_MS]);
  });

  it("with auto off makes no check after start, even after two days", async () => {
    const { state, sched, checks } = setup(memoryStore({ [AUTO_KEY]: "0" }));
    expect(state.auto).toBe(false);
    state.start();
    let elapsed = 0;
    while (sched.due.length > 0 && elapsed < 2 * CHECK_EVERY_MS) elapsed += Math.max(...sched.runDue());
    await flush();
    expect(checks).toHaveLength(0);
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
    const { state, sched, checks } = setup();
    state.start();
    sched.runDue();
    checks[0]!.reject({ code: "other", message: "offline" });
    await flush();
    expect(state.phase).toBe("idle");
    expect(state.error).toBeNull();
    expect(state.available).toBeNull();
    // ...and the next tick tries again.
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
    const { state, sched, checks } = setup();
    const done = state.checkNow();
    checks[0]!.resolve(null);
    await done;
    expect(state.phase).toBe("upToDate");
    state.start();
    sched.runDue();
    checks[1]!.resolve(INFO);
    await flush();
    expect(state.phase).toBe("idle");
    expect(state.shown).toBe(true);
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
