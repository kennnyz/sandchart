import { typing, type KeyLike } from "../chart/drawings/keys";
export { clampLevel } from "../chart/replay";
import {
  toProblem,
  type Backend,
  type CandleColumns,
  type Instrument,
  type InstrumentId,
  type ReplayCommand,
  type ReplayState,
  type ReplayStats,
  type ReplayTrade,
  type Side,
  type TimeframeCode,
} from "../backend/types";
import { buildsFrom, bucketStart, closeTime } from "../timeframes";

/** Bars per second of Play. */
export const SPEEDS = [1, 2, 3, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];
/** A new trade risks this share of the close... */
export const TRADE_STOP = 0.015;
/** ...for this many times the risk (ADR 0005). */
export const TRADE_RR = 2;
/** The engine refuses bigger `.replay` files; checked here too, before the file is read. */
export const MAX_REPLAY_FILE_MIB = 32;
const MAX_TICKS = Number.MAX_SAFE_INTEGER;
/** Base candles one step of "jump to real time" asks for: a whole session (the engine's cap). */
const JUMP_STEP = 200_000;
/** `replay_state` clamps its cursors: this asks for no bars and no trades, only the flags. */
const NOTHING = 0xffff_ffff;
/** Where the results panel remembers that it was collapsed. */
export const RESULTS_COLLAPSED_KEY = "sandchart.replay.resultsCollapsed";

/** The part of `Storage` the controller uses; reads and writes may throw (no storage). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage: KeyValue = {
  getItem: (k) => (typeof localStorage === "undefined" ? null : localStorage.getItem(k)),
  setItem: (k, v) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(k, v);
  },
};

type ReplayBackend = Pick<
  Backend,
  "replayStart" | "replayStep" | "replaySetBase" | "replayCommand" | "replayState" | "replaySave" | "replayOpen" | "replayExit"
>;

/** What the controller needs from the chart view: put bars on the chart, or go back to live. */
export interface ReplayFeed {
  /** The revealed bars are the whole chart now (a start, an open file, a resync). */
  show(st: ReplayState): void;
  /** Newly revealed bars from the last one shown on (a forming bar is sent again as it grows). */
  append(bars: CandleColumns): void;
  /** The replay caught up: show the pair's live candles again (for display; the backtest ended at the cut). */
  follow(): void;
  /** The replay ended: load the live chart again (candles and live updates). */
  reload(): void;
}

/** The session as the UI shows it; the engine's numbers, never computed here. */
export interface ReplayView {
  instrument: Instrument;
  /** The chart's timeframe, the one the bars are in. */
  tf: TimeframeCode;
  /** The step resolution (the update interval). */
  base: TimeframeCode;
  start: number;
  /** Index of the last revealed bar. */
  current: number;
  /** The close time of the current bar; commands carry it. */
  cut: number;
  atEnd: boolean;
  /** Reached the newest data in this session: the chart shows live candles again (ADR 0008). */
  caughtUp: boolean;
  /** The cut at which the backtest ended at real time (a file's too): no steps or commands. */
  caughtUpAt: number | null;
  /** The last bar is still forming (a chart above the base). */
  partial: boolean;
  /** Newer candles could not be loaded at the last step: a notice, the next step tries again. */
  newerError: string | null;
  /** Open time and close of the last revealed bar. */
  time: number;
  close: number;
  trades: ReplayTrade[];
  stats: ReplayStats;
  /** The trade still open, if any (its `r` is marked to the close). */
  open: ReplayTrade | null;
}

/** `off`: the live chart; `picking`: the next click on a bar starts; `on`: replaying. */
export type ReplayPhase = "off" | "picking" | "on";

export type ReplayKeyAction = "step" | "play" | "buy" | "sell" | "close" | "cancel";

/** The parts of a KeyboardEvent the replay keys read. */
export interface ReplayKey extends KeyLike {
  /** Repeated keydown while the key is held. */
  repeat?: boolean;
}

const BUTTON_LIKE = new Set(["BUTTON", "A", "SUMMARY"]);

/**
 * Replay keys: → steps, Space plays or pauses, Shift+B buys, Shift+S sells, Shift+C closes the
 * trade, Esc cancels picking a start. None fires while typing, with ⌘/Ctrl/Alt (Alt keys are
 * the drawing tools), or outside the phase it belongs to. Space on a focused button is left
 * to the button.
 */
export function replayKeyAction(e: ReplayKey, phase: ReplayPhase): ReplayKeyAction | null {
  if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (phase === "picking") return e.code === "Escape" ? "cancel" : null;
  if (phase !== "on") return null;
  if (e.code === "ArrowRight" && !e.shiftKey) return "step";
  if (e.code === "Space" && !e.shiftKey && !e.repeat) {
    const tag = (e.target as { tagName?: string } | null)?.tagName ?? "";
    return BUTTON_LIKE.has(tag) ? null : "play";
  }
  if (e.shiftKey && !e.repeat) {
    if (e.code === "KeyB") return "buy";
    if (e.code === "KeyS") return "sell";
    if (e.code === "KeyC") return "close";
  }
  return null;
}

/** The default levels of a trade opened at `close`: a stop TRADE_STOP away, a take at TRADE_RR R. */
export function defaultLevels(side: Side, close: number): { stop: number; take: number } {
  const risk = Math.max(1, Math.round(Math.abs(close) * TRADE_STOP));
  const dir = side === "long" ? 1 : -1;
  const clamp = (p: number) => Math.min(MAX_TICKS, Math.max(-MAX_TICKS, p));
  return { stop: clamp(close - dir * risk), take: clamp(close + dir * TRADE_RR * risk) };
}

/** As the engine checks an open or an edit: long stop < close < take, short take < close < stop. */
export function validLevels(side: Side, close: number, stop: number, take: number): boolean {
  const inRange = [stop, take].every((v) => Number.isInteger(v) && Math.abs(v) <= MAX_TICKS);
  return inRange && (side === "long" ? stop < close && close < take : take < close && close < stop);
}

/** One update interval the replay can step: `stepTo` is set when the cut must reach that time first. */
export interface BaseChoice {
  tf: TimeframeCode;
  stepTo: number | null;
}

/**
 * The update intervals a replay shown at `tf` can step, finest first: the base and every
 * timeframe the chart builds from that the engine can re-base to (ADR 0008, decision 8). A lower
 * one always qualifies (the engine may still refuse it, e.g. a span too long for 1m); a higher
 * one only at a cut on its boundary, else it names the time to step to.
 */
export function baseChoices(tf: TimeframeCode, base: TimeframeCode, cut: number, all: readonly TimeframeCode[]): BaseChoice[] {
  const out: BaseChoice[] = [];
  for (const b of all) {
    if (!buildsFrom(tf, b)) continue;
    if (b === base || buildsFrom(base, b)) out.push({ tf: b, stepTo: null });
    else if (buildsFrom(b, base)) {
      const at = bucketStart(b, cut);
      out.push({ tf: b, stepTo: at === cut ? null : closeTime(b, at) });
    }
  }
  return out;
}

/**
 * Runs the replay from the UI: picks a start, steps and plays, sends trade commands, saves and
 * opens files. Every engine call runs one after another; after each step or command it asks the
 * engine for the bars since `cursor` (`from + bars` of the last answer) and the results. Play
 * runs on one timeout at a time and stops at the end of the data, on an error, and when the
 * window is hidden (`visibility`).
 */
export class ReplayController {
  phase: ReplayPhase = "off";
  playing = false;
  speed: Speed = 1;
  view: ReplayView | null = null;
  /** The engine's message for the last call that failed; cleared by the next action. */
  error: string | null = null;
  /** "Select bar" asked whether the trades so far may be dropped; waiting for the answer. */
  confirming = false;
  /** The results panel is folded to its header (remembered). */
  resultsCollapsed: boolean;
  private cursor = 0;
  /** Closed trades so far; they never change, so only later ones are asked for. */
  private closed: ReplayTrade[] = [];
  private feed: ReplayFeed | null = null;
  private switchTo: ((id: InstrumentId, tf: TimeframeCode) => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by cancelling a pick and by exit: a start in flight from before is stale. */
  private generation = 0;
  /** A start is in flight; another click starts nothing more. */
  private starting = false;
  /** Steps queued or running. */
  private steps = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly backend: ReplayBackend,
    private readonly onChange: () => void,
    private readonly storage: KeyValue = browserStorage,
  ) {
    let collapsed = false;
    try {
      collapsed = storage.getItem(RESULTS_COLLAPSED_KEY) === "1";
    } catch {
      // No storage: the panel starts open.
    }
    this.resultsCollapsed = collapsed;
  }

  /** The backtest ended at real time: no steps and no trade commands any more. */
  get finished(): boolean {
    return this.view?.caughtUpAt != null;
  }

  /** Connects the chart view; the returned function disconnects it. */
  attach(feed: ReplayFeed): () => void {
    this.feed = feed;
    return () => {
      if (this.feed === feed) this.feed = null;
    };
  }

  /** How an opened file (or a timeframe the replay cannot show) switches the chart to an instrument and timeframe. */
  onSwitch(fn: ((id: InstrumentId, tf: TimeframeCode) => void) | null): void {
    this.switchTo = fn;
  }

  /** The replay is on and replays `id` (at any timeframe). */
  replays(id: InstrumentId): boolean {
    const v = this.view;
    return this.phase === "on" && v !== null && v.instrument.id.source === id.source && v.instrument.id.symbol === id.symbol;
  }

  /** The next click on a bar picks the start (the Replay button). */
  pick(): void {
    if (this.phase !== "off") return;
    this.error = null;
    this.set({ phase: "picking" });
  }

  cancelPick(): void {
    if (this.phase !== "picking") return;
    this.generation++;
    this.set({ phase: "off" });
  }

  /**
   * Starts at the bar of `(id, tf)` opening at `time` (a bar's own open time). A start that was
   * cancelled (or overtaken by exit) while in flight ends the engine's replay again and shows nothing.
   */
  start(id: InstrumentId, tf: TimeframeCode, time: number): Promise<void> {
    if (this.phase !== "picking" || this.starting) return Promise.resolve();
    this.starting = true;
    const generation = this.generation;
    const stale = () => generation !== this.generation || this.phase !== "picking";
    return this.run(async () => {
      try {
        let st: ReplayState;
        try {
          st = await this.backend.replayStart(id, tf, time);
        } catch (e) {
          if (stale()) return;
          throw e;
        }
        if (stale()) {
          await this.backend.replayExit();
          return;
        }
        this.cursor = 0;
        this.phase = "on";
        this.show(st);
      } finally {
        this.starting = false;
      }
    }, () => this.set({ phase: "off" }));
  }

  /**
   * Reveals the next bar. `held` (a key repeat of →) steps only when no step is on its way, so
   * holding the key runs at the engine's pace instead of queueing steps it cannot keep up with.
   */
  step(held = false): Promise<void> {
    if (this.phase !== "on" || this.view?.atEnd || this.finished || (held && this.steps > 0)) return Promise.resolve();
    this.steps++;
    return this.run(async () => {
      try {
        if (this.phase !== "on") return;
        await this.backend.replayStep(1);
        await this.sync();
      } finally {
        this.steps--;
      }
    });
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.phase !== "on" || this.playing || this.view?.atEnd) return;
    this.error = null;
    this.set({ playing: true });
    this.schedule();
  }

  pause(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.playing) this.set({ playing: false });
  }

  /**
   * Steps to the newest data: every loaded candle, then the newer ones the engine loads, until
   * it has caught up (or a file reaches its end). The chart then shows every revealed bar.
   */
  jumpToEnd(): Promise<void> {
    if (this.phase !== "on" || !this.view || this.view.atEnd) return Promise.resolve();
    this.pause();
    return this.run(async () => {
      let v = this.view;
      if (this.phase !== "on" || !v || v.atEnd) return;
      let cut = v.cut;
      // Each step loads one more batch of newer candles at most; the cut stops moving at the end.
      for (;;) {
        const next = await this.backend.replayStep(JUMP_STEP);
        const st = await this.backend.replayState(v.tf, NOTHING, NOTHING);
        if (st.atEnd || st.caughtUp || next === cut) break;
        cut = next;
      }
      v = this.view;
      if (this.phase !== "on" || !v) return;
      this.show(await this.backend.replayState(v.tf, 0, 0));
    });
  }

  /**
   * The chart switched to `tf`: one the base builds shows its bars at once (the forming bar
   * too); a lower one re-bases the session to it first. Trades and results stay. One the
   * replay cannot show, or a re-base the engine refuses, puts the chart back on its timeframe.
   */
  setTimeframe(tf: TimeframeCode): Promise<void> {
    if (this.phase !== "on") return Promise.resolve();
    return this.run(async () => {
      const v = this.view;
      if (this.phase !== "on" || !v || v.tf === tf) return;
      let st: ReplayState;
      try {
        st = tf !== v.base && buildsFrom(v.base, tf) ? await this.backend.replaySetBase(tf) : await this.backend.replayState(tf, 0, 0);
      } catch (e) {
        this.switchTo?.(v.instrument.id, v.tf);
        throw e;
      }
      if (this.phase === "on") this.show(st);
    });
  }

  /** Steps `base` candles from now on (the update interval); the engine's message when it refuses. */
  setBase(base: TimeframeCode): Promise<void> {
    if (this.phase !== "on") return Promise.resolve();
    this.pause();
    return this.run(async () => {
      const v = this.view;
      if (this.phase !== "on" || !v || v.base === base) return;
      await this.backend.replaySetBase(base);
      const st = await this.backend.replayState(v.tf, 0, 0);
      if (this.phase === "on") this.show(st);
    });
  }

  /**
   * "Select bar": pick a new start. With trades so far it asks first (`confirming`), since a new
   * start drops them; then the live chart comes back to pick on.
   */
  selectBar(): Promise<void> {
    if (this.phase !== "on" || !this.view) return Promise.resolve();
    if (this.view.trades.length > 0) {
      this.set({ confirming: true });
      return Promise.resolve();
    }
    return this.repick();
  }

  /** The trades may go: pick a new start. */
  confirmSelectBar(): Promise<void> {
    if (!this.confirming) return Promise.resolve();
    return this.repick();
  }

  cancelSelectBar(): void {
    if (this.confirming) this.set({ confirming: false });
  }

  toggleResults(): void {
    this.set({ resultsCollapsed: !this.resultsCollapsed });
    try {
      this.storage.setItem(RESULTS_COLLAPSED_KEY, this.resultsCollapsed ? "1" : "0");
    } catch {
      // No storage: the choice lasts for this session only.
    }
  }

  setSpeed(speed: Speed): void {
    this.set({ speed });
    if (this.playing) {
      // The next bar comes at the new pace.
      if (this.timer !== null) clearTimeout(this.timer);
      this.schedule();
    }
  }

  /** The window was hidden or shown: Play stops while hidden, so no timer runs in the background. */
  visibility(hidden: boolean): void {
    if (hidden) this.pause();
  }

  buy(): Promise<void> {
    return this.openTrade("long");
  }

  sell(): Promise<void> {
    return this.openTrade("short");
  }

  /** Closes the open trade at the close of the current bar. */
  closeTrade(): Promise<void> {
    if (!this.view?.open || this.finished) return Promise.resolve();
    return this.command(() => (this.view!.open ? { kind: "close", time: this.view!.cut } : null));
  }

  /**
   * New stop and take of the open trade, in force from the next bar; a level that did not change is
   * not sent. It is checked when its turn comes, against the trade and the close then: an edit
   * whose trade closed in the meantime, or whose levels no longer hold, is dropped without a word.
   */
  edit(stop: number, take: number): Promise<void> {
    const entryTime = this.view?.open?.entryTime;
    if (entryTime === undefined || this.finished) return Promise.resolve();
    return this.command(() => {
      const v = this.view!;
      const t = v.open;
      if (!t || t.entryTime !== entryTime || !validLevels(t.side, v.close, stop, take)) return null;
      if (stop === t.stop && take === t.take) return null;
      const cmd: ReplayCommand = { kind: "edit", time: v.cut };
      if (stop !== t.stop) cmd.stop = stop;
      if (take !== t.take) cmd.take = take;
      return cmd;
    });
  }

  /** Saves the session as a `.replay` file (a save panel in the app). */
  save(): Promise<void> {
    if (this.phase !== "on") return Promise.resolve();
    return this.run(async () => {
      await this.backend.replaySave();
    });
  }

  /** Opens a `.replay` file and shows it on its own instrument and timeframe. A bad file leaves everything as it was. */
  open(bytes: Uint8Array): Promise<void> {
    this.pause();
    return this.run(async () => {
      const st = await this.backend.replayOpen(bytes);
      if (this.phase === "picking") this.phase = "off";
      this.cursor = 0;
      this.phase = "on";
      this.show(st);
      this.switchTo?.(st.instrument.id, st.tf);
    });
  }

  /**
   * Ends the replay. With `reload` the chart loads the live data again; without, the caller
   * opens another chart itself.
   */
  exit(reload = true): Promise<void> {
    this.pause();
    this.generation++;
    this.confirming = false;
    if (this.phase === "picking") {
      this.set({ phase: "off" });
      return Promise.resolve();
    }
    if (this.phase === "off") return Promise.resolve();
    return this.run(async () => {
      this.phase = "off";
      this.view = null;
      this.cursor = 0;
      this.closed = [];
      this.changed();
      try {
        await this.backend.replayExit();
      } finally {
        if (reload) this.feed?.reload();
      }
    });
  }

  /** Ends the engine's session and shows the live chart to pick a new start on. */
  private repick(): Promise<void> {
    this.pause();
    this.generation++;
    this.confirming = false;
    return this.run(async () => {
      if (this.phase !== "on") return;
      this.phase = "picking";
      this.view = null;
      this.cursor = 0;
      this.closed = [];
      this.changed();
      try {
        await this.backend.replayExit();
      } finally {
        this.feed?.reload();
      }
    });
  }

  private openTrade(side: Side): Promise<void> {
    const v = this.view;
    if (this.phase !== "on" || !v || v.open || this.finished) return Promise.resolve();
    return this.command(() => {
      // A second click while the first trade was on its way opens nothing.
      if (this.view!.open) return null;
      const { stop, take } = defaultLevels(side, this.view!.close);
      return { kind: "open", time: this.view!.cut, side, stop, take };
    });
  }

  /** Sends a command made at run time (from the then current bar) and reads the results back. */
  private command(make: () => ReplayCommand | null): Promise<void> {
    return this.run(async () => {
      if (this.phase !== "on" || !this.view) return;
      const cmd = make();
      if (!cmd) return;
      await this.backend.replayCommand(cmd);
      await this.sync();
    });
  }

  private async sync(): Promise<void> {
    const tf = this.view!.tf;
    const st = await this.backend.replayState(tf, this.cursor, this.closed.length);
    if (this.phase !== "on") return;
    if (st.from !== this.cursor) {
      // Not where the chart is: show everything again.
      const all = await this.backend.replayState(tf, 0, 0);
      this.cursor = 0;
      this.show(all);
      return;
    }
    if (st.bars.time.length > 0) this.feed?.append(st.bars);
    const was = this.view?.caughtUp ?? false;
    this.apply(st);
    if (st.caughtUp && !was) this.feed?.follow();
  }

  private show(st: ReplayState): void {
    this.feed?.show(st);
    this.view = null;
    this.closed = [];
    this.apply(st);
  }

  private apply(st: ReplayState): void {
    const n = st.bars.time.length;
    // A forming bar is asked for again, from its index, until it is complete.
    this.cursor = st.from + n - (st.partial && n > 0 ? 1 : 0);
    const prev = this.view;
    const trades = [...this.closed.slice(0, st.tradesFrom), ...st.trades];
    const last = trades.at(-1);
    const open = last?.reason === "open" ? last : null;
    this.closed = open ? trades.slice(0, -1) : trades;
    this.view = {
      instrument: st.instrument,
      tf: st.tf,
      base: st.base,
      start: st.start,
      current: st.current,
      cut: st.cut,
      atEnd: st.atEnd,
      caughtUp: st.caughtUp,
      caughtUpAt: st.caughtUpAt,
      partial: st.partial,
      newerError: st.newerError,
      time: n > 0 ? st.bars.time[n - 1]! : (prev?.time ?? 0),
      close: n > 0 ? st.bars.close[n - 1]! : (prev?.close ?? 0),
      trades,
      stats: st.stats,
      open,
    };
    if (st.atEnd) this.pause();
    this.changed();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.playing) return;
      void this.step().then(() => {
        if (this.playing && this.timer === null) this.schedule();
      });
    }, 1000 / this.speed);
  }

  /** Runs `job` after every earlier one; a failure keeps the engine's message and stops Play. */
  private run(job: () => Promise<void>, onError?: () => void): Promise<void> {
    this.error = null;
    const next = this.queue.then(async () => {
      try {
        await job();
      } catch (e) {
        this.pause();
        this.error = toProblem(e).message;
        onError?.();
        this.changed();
      }
    });
    this.queue = next;
    return next;
  }

  private set(patch: Partial<Pick<ReplayController, "phase" | "playing" | "speed" | "confirming" | "resultsCollapsed">>): void {
    Object.assign(this, patch);
    this.changed();
  }

  private changed(): void {
    this.onChange();
  }
}

/** A `ReplayController` that React components subscribe to (`useSyncExternalStore`). */
export interface ReplayStore {
  state: ReplayController;
  subscribe(cb: () => void): () => void;
  version(): number;
}

export function replayStore(backend: ReplayBackend): ReplayStore {
  const listeners = new Set<() => void>();
  let version = 0;
  const state = new ReplayController(backend, () => {
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
