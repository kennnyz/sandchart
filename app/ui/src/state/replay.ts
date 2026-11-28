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

/** Bars per second of Play. */
export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];
/** A new trade risks this share of the close... */
export const TRADE_STOP = 0.015;
/** ...for this many times the risk (ADR 0005). */
export const TRADE_RR = 2;
/** The engine refuses bigger `.replay` files; checked here too, before the file is read. */
export const MAX_REPLAY_FILE_MIB = 32;
const MAX_TICKS = Number.MAX_SAFE_INTEGER;

type ReplayBackend = Pick<
  Backend,
  "replayStart" | "replayStep" | "replayCommand" | "replayState" | "replaySave" | "replayOpen" | "replayExit"
>;

/** What the controller needs from the chart view: put bars on the chart, or go back to live. */
export interface ReplayFeed {
  /** The revealed bars are the whole chart now (a start, an open file, a resync). */
  show(st: ReplayState): void;
  /** Newly revealed bars, after the last one shown. */
  append(bars: CandleColumns): void;
  /** The replay ended: load the live chart again (candles and live updates). */
  reload(): void;
}

/** The session as the UI shows it; the engine's numbers, never computed here. */
export interface ReplayView {
  instrument: Instrument;
  tf: TimeframeCode;
  start: number;
  /** Index of the last revealed bar. */
  current: number;
  atEnd: boolean;
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
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly backend: ReplayBackend,
    private readonly onChange: () => void,
  ) {}

  /** Connects the chart view; the returned function disconnects it. */
  attach(feed: ReplayFeed): () => void {
    this.feed = feed;
    return () => {
      if (this.feed === feed) this.feed = null;
    };
  }

  /** How an opened file switches the chart to its instrument and timeframe. */
  onSwitch(fn: ((id: InstrumentId, tf: TimeframeCode) => void) | null): void {
    this.switchTo = fn;
  }

  /** The replay shows `(id, tf)`. */
  matches(id: InstrumentId, tf: TimeframeCode): boolean {
    const v = this.view;
    return this.phase === "on" && v !== null && v.tf === tf && v.instrument.id.source === id.source && v.instrument.id.symbol === id.symbol;
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

  /** Reveals the next bar. */
  step(): Promise<void> {
    if (this.phase !== "on" || this.view?.atEnd) return Promise.resolve();
    return this.run(async () => {
      if (this.phase !== "on") return;
      await this.backend.replayStep(1);
      await this.sync();
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
    if (!this.view?.open) return Promise.resolve();
    return this.command(() => (this.view!.open ? { kind: "close", bar: this.view!.current } : null));
  }

  /**
   * New stop and take of the open trade, in force from the next bar; a level that did not change is
   * not sent. It is checked when its turn comes, against the trade and the close then: an edit
   * whose trade closed in the meantime, or whose levels no longer hold, is dropped without a word.
   */
  edit(stop: number, take: number): Promise<void> {
    const entryBar = this.view?.open?.entryBar;
    if (entryBar === undefined) return Promise.resolve();
    return this.command(() => {
      const v = this.view!;
      const t = v.open;
      if (!t || t.entryBar !== entryBar || !validLevels(t.side, v.close, stop, take)) return null;
      if (stop === t.stop && take === t.take) return null;
      const cmd: ReplayCommand = { kind: "edit", bar: v.current };
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

  /** The chart (back from another instrument) shows the replay again: every revealed bar. */
  resync(): Promise<void> {
    return this.run(async () => {
      if (this.phase !== "on") return;
      const st = await this.backend.replayState(0, 0);
      this.cursor = 0;
      this.show(st);
    });
  }

  /**
   * Ends the replay. With `reload` the chart loads the live data again; without, the caller
   * opens another chart itself.
   */
  exit(reload = true): Promise<void> {
    this.pause();
    this.generation++;
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

  private openTrade(side: Side): Promise<void> {
    const v = this.view;
    if (this.phase !== "on" || !v || v.open) return Promise.resolve();
    return this.command(() => {
      // A second click while the first trade was on its way opens nothing.
      if (this.view!.open) return null;
      const { stop, take } = defaultLevels(side, this.view!.close);
      return { kind: "open", bar: this.view!.current, side, stop, take };
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
    const st = await this.backend.replayState(this.cursor, this.closed.length);
    if (this.phase !== "on") return;
    if (st.from !== this.cursor) {
      // Not where the chart is: show everything again.
      const all = await this.backend.replayState(0, 0);
      this.cursor = 0;
      this.show(all);
      return;
    }
    if (st.bars.time.length > 0) this.feed?.append(st.bars);
    this.apply(st);
  }

  private show(st: ReplayState): void {
    this.feed?.show(st);
    this.view = null;
    this.closed = [];
    this.apply(st);
  }

  private apply(st: ReplayState): void {
    const n = st.bars.time.length;
    this.cursor = st.from + n;
    const prev = this.view;
    const trades = [...this.closed.slice(0, st.tradesFrom), ...st.trades];
    const last = trades.at(-1);
    const open = last?.reason === "open" ? last : null;
    this.closed = open ? trades.slice(0, -1) : trades;
    this.view = {
      instrument: st.instrument,
      tf: st.tf,
      start: st.start,
      current: st.current,
      atEnd: st.atEnd,
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

  private set(patch: Partial<Pick<ReplayController, "phase" | "playing" | "speed">>): void {
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
