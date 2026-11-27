import { toProblem, type Backend, type UpdateInfo, type UpdateProgress } from "../backend/types";

/** The first automatic check waits for the chart to load. */
export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 86_400_000;
/** `"0"` turns the automatic check off; anything else, or nothing, leaves it on. */
export const AUTO_KEY = "sandchart.updates.auto";

/** The part of `localStorage` used here. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage` that never throws (it can, in private mode or with storage blocked). */
export const safeLocalStorage: KeyValueStore = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // No storage: the choice lasts for this session only.
    }
  },
};

/**
 * `restarting`: the install finished and the app is about to restart (macOS, Linux). On
 * Windows the installer ends the process, so the phase stays `installing` until then.
 */
export type UpdatePhase = "idle" | "checking" | "downloading" | "installing" | "restarting" | "error" | "upToDate";

/**
 * When to look for an update and the state of its install. Rust checks and installs; this
 * only decides timing and keeps what the UI draws. With auto off nothing is ever checked
 * unless `checkNow` is called. An automatic check that fails is only logged and tried again
 * at the next tick. An install has no timeout: on Windows success never answers.
 */
export class UpdateState {
  /** The newer version from the last successful check. */
  available: UpdateInfo | null = null;
  phase: UpdatePhase = "idle";
  /** Download progress 0..1; null when the size is unknown. */
  progress: number | null = null;
  error: string | null = null;
  /** What failed: the check (the version popover shows it) or the install (the banner does). */
  failed: "check" | "install" | null = null;
  auto: boolean;
  /** Hidden by "Later" until the next start. */
  private dismissed = false;
  private started = false;
  /** Bumped to cancel the scheduled checks (`schedule` gives no handle). */
  private generation = 0;
  /** The check in flight; a manual and an automatic check share it. */
  private checking: Promise<UpdateInfo | null> | null = null;
  /** A failed install leaves nothing in Rust, so the next one checks again first. */
  private needsCheck = false;
  private total: number | null = null;

  constructor(
    private readonly backend: Backend,
    private readonly onChange: () => void,
    // A wrapper, not `setTimeout` itself: called as a method, WebKit throws on the foreign `this`.
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly storage: KeyValueStore = safeLocalStorage,
  ) {
    let stored: string | null = null;
    try {
      stored = storage.getItem(AUTO_KEY);
    } catch {
      // Unreadable storage: the default.
    }
    this.auto = stored !== "0";
  }

  /** The banner shows: an update exists and "Later" was not pressed since the start. */
  get shown(): boolean {
    return this.available !== null && !this.dismissed;
  }

  /** Once per app start: shows a dismissed update again and schedules the automatic checks. */
  start(firstMs = FIRST_CHECK_MS): void {
    this.started = true;
    this.dismissed = false;
    this.generation++;
    if (this.auto) this.scheduleCheck(firstMs);
    this.onChange();
  }

  setAuto(on: boolean): void {
    this.auto = on;
    try {
      this.storage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      // No storage: the choice lasts for this session only.
    }
    this.generation++;
    if (on && this.started) this.scheduleCheck(FIRST_CHECK_MS);
    this.onChange();
  }

  /** A check the user asked for; its failure is shown. */
  async checkNow(): Promise<void> {
    if (this.busy()) return;
    this.setPhase("checking");
    try {
      const info = await this.check();
      this.dismissed = false;
      this.phase = info ? "idle" : "upToDate";
    } catch (e) {
      this.fail("check", e);
      return;
    }
    this.onChange();
  }

  /** Downloads and installs `available`. A failure is shown and a second attempt starts clean. */
  async install(): Promise<void> {
    if (this.busy() || !this.available || this.available.blocker) return;
    this.total = null;
    this.progress = null;
    this.setPhase("downloading");
    try {
      if (this.needsCheck) {
        const info = await this.check();
        if (!info || info.blocker) {
          this.phase = info ? "idle" : "upToDate";
          this.onChange();
          return;
        }
      }
      await this.backend.installUpdate((p) => this.onProgress(p));
    } catch (e) {
      this.needsCheck = true;
      this.fail("install", e);
      return;
    }
    this.setPhase("restarting");
  }

  /** Hides the update until the next start. */
  later(): void {
    this.dismissed = true;
    this.onChange();
  }

  private busy(): boolean {
    return this.phase === "checking" || this.phase === "downloading" || this.phase === "installing" || this.phase === "restarting";
  }

  private scheduleCheck(ms: number): void {
    const generation = this.generation;
    this.schedule(() => {
      if (generation !== this.generation || !this.auto) return;
      // The next tick is set now, so the cadence does not drift with a slow check.
      this.scheduleCheck(CHECK_EVERY_MS);
      void this.autoCheck();
    }, ms);
  }

  private async autoCheck(): Promise<void> {
    // During an install the check would race it; a manual check shows its own result.
    if (this.busy()) return;
    try {
      await this.check();
    } catch (e) {
      console.error("checking for updates failed", toProblem(e).message);
      return;
    }
    // A stale manual result would contradict this one.
    if (this.failed === "check" || (this.phase === "upToDate" && this.available)) this.setPhase("idle");
    else this.onChange();
  }

  private check(): Promise<UpdateInfo | null> {
    this.checking ??= this.backend
      .checkUpdate()
      .then((info) => {
        this.available = info;
        this.needsCheck = false;
        return info;
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  private onProgress(p: UpdateProgress): void {
    if (p.kind === "started") {
      this.total = p.total;
      this.progress = p.total ? 0 : null;
    } else if (p.kind === "chunk") {
      this.progress = this.total ? Math.min(1, p.downloaded / this.total) : null;
    } else {
      this.phase = "installing";
    }
    this.onChange();
  }

  private setPhase(phase: UpdatePhase): void {
    this.phase = phase;
    this.error = null;
    this.failed = null;
    this.onChange();
  }

  private fail(what: "check" | "install", e: unknown): void {
    this.phase = "error";
    this.error = toProblem(e).message;
    this.failed = what;
    this.onChange();
  }
}

/** An `UpdateState` that React components subscribe to (`useSyncExternalStore`). */
export interface UpdateStore {
  state: UpdateState;
  subscribe(cb: () => void): () => void;
  version(): number;
}

export function updateStore(backend: Backend): UpdateStore {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = new UpdateState(backend, () => {
    version++;
    for (const l of listeners) l();
  });
  return {
    state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    version: () => version,
  };
}
