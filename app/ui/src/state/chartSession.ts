import {
  toProblem,
  type Backend,
  type CandleColumns,
  type Candles,
  type Instrument,
  type InstrumentId,
  type LiveCandle,
  type LiveEvent,
  type Problem,
  type ProblemCode,
  type ReplayState,
  type TimeframeCode,
} from "../backend/types";

/** Source of imported CSV files: cache only, nothing live. */
const CSV_SOURCE = "csv";

/** What the session needs from the chart (`Chart` implements it). */
export interface SessionChart {
  setData(c: Candles): void;
  prependData(c: Candles): void;
  updateLast(c: LiveCandle): void;
  clear(): void;
  releaseOlder(): void;
  candle(index: number): LiveCandle | null;
  readonly count: number;
}

export type SessionStatus = "idle" | "loading" | "ready" | "failed";

/** A failed request to the provider; `retryAt` (ms) is when the next attempt runs. */
export interface SessionProblem {
  code: ProblemCode;
  message: string;
  retryAt: number | null;
}

export interface SessionState {
  id: InstrumentId | null;
  tf: TimeframeCode;
  /** `failed`: the first page could not be loaded at all (nothing to draw). */
  status: SessionStatus;
  /** Instrument of the page on the chart; null until the current chart's page arrives. */
  instrument: Instrument | null;
  problem: SessionProblem | null;
  /** Bumped on every change of the candles, so the legend re-reads them. */
  version: number;
  /** The chart shows a replay's revealed bars: no older pages, and live updates only once it caught up. */
  replay: boolean;
}

/** Seconds before each retry after consecutive failures; the last one repeats. */
export const RETRY_DELAYS_S = [5, 10, 20, 40, 60];

type RetryKind = "latest" | "older";

/** Pending trouble of one kind of request; each kind has its own timer and backoff. */
interface Pending {
  problem: Problem;
  /** Next attempt (ms), null while an attempt runs or when nothing is scheduled. */
  retryAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Consecutive failures, for the backoff. */
  failures: number;
}

/**
 * Loads one chart (instrument + timeframe) into a `SessionChart`: the newest page, older
 * pages on demand and live bars. Every `open` starts a new generation; results and live
 * events of an older generation are dropped. Failed requests are retried with a backoff.
 */
export class ChartSession {
  private gen = 0;
  private stopLive: (() => void) | null = null;
  /** Generation that has, or is acquiring, the live stream. */
  private liveGen = 0;
  private olderInFlight = false;
  /** The chart has a hole the newest page must replace, not merge into. */
  private replaceOnLoad = false;
  private readonly pending = new Map<RetryKind, Pending>();
  private state: SessionState = {
    id: null,
    tf: "1h",
    status: "idle",
    instrument: null,
    problem: null,
    version: 0,
    replay: false,
  };

  constructor(
    private readonly backend: Backend,
    private readonly chart: SessionChart,
    private readonly onChange: (s: SessionState) => void,
  ) {}

  get current(): SessionState {
    return this.state;
  }

  /** Shows `id` at `tf`: clears the chart at once, then loads the newest page and goes live. */
  async open(id: InstrumentId, tf: TimeframeCode): Promise<void> {
    const gen = this.reset();
    this.chart.clear();
    this.set({ id, tf, status: "loading", instrument: null, problem: null, version: this.state.version + 1, replay: false });
    await this.loadLatest(gen);
  }

  /**
   * Shows a replay's revealed bars as the whole chart, in place of the live chart: the live
   * stream and every retry stop, and no older page is asked for (`open` goes back to live).
   */
  showReplay(st: ReplayState): void {
    this.reset();
    this.chart.setData({ instrument: st.instrument, ...st.bars, atHistoryStart: false, warning: null });
    this.set({
      id: st.instrument.id,
      tf: st.tf,
      status: "ready",
      instrument: st.instrument,
      problem: null,
      version: this.state.version + 1,
      replay: true,
    });
  }

  /**
   * The replay on the chart caught up (ADR 0008): the pair's live candles update the chart again,
   * as on the live chart. They are for display only; the backtest ended at the cut. Stops with
   * the next `showReplay`, `open` or `close`.
   */
  async followReplay(): Promise<void> {
    const { id, tf, replay } = this.state;
    const gen = this.gen;
    if (!replay || !id || id.source === CSV_SOURCE || this.liveGen === gen) return;
    this.liveGen = gen;
    try {
      const stop = await this.backend.subscribeLive(id, tf, (e) => {
        if (gen !== this.gen) return;
        const candles: LiveCandle[] =
          e.kind === "candle"
            ? [e]
            : e.kind === "backfilled"
              ? e.candles.time.map((time, i) => ({
                  time,
                  open: e.candles.open[i]!,
                  high: e.candles.high[i]!,
                  low: e.candles.low[i]!,
                  close: e.candles.close[i]!,
                  volume: e.candles.volume[i]!,
                  closed: true,
                }))
              : [];
        if (candles.length === 0) return;
        for (const c of candles) this.chart.updateLast(c);
        this.bump();
      });
      if (gen !== this.gen) stop();
      else this.stopLive = stop;
    } catch (e) {
      if (gen !== this.gen) return;
      this.liveGen = 0;
      this.fail("latest", toProblem(e));
    }
  }

  /** Appends newly revealed replay bars. */
  appendReplay(bars: CandleColumns): void {
    if (!this.state.replay) return;
    for (let i = 0; i < bars.time.length; i++) {
      this.chart.updateLast({
        time: bars.time[i]!,
        open: bars.open[i]!,
        high: bars.high[i]!,
        low: bars.low[i]!,
        close: bars.close[i]!,
        volume: bars.volume[i]!,
        closed: true,
      });
    }
    this.bump();
  }

  /** Loads the page before the first candle; `Chart.onNeedOlder` calls it. */
  async loadOlder(): Promise<void> {
    const gen = this.gen;
    const { id, tf } = this.state;
    const first = this.chart.candle(0);
    // A replay has only its context before the start: nothing older to load.
    if (!id || !first || this.olderInFlight || this.state.replay) return;
    this.olderInFlight = true;
    try {
      const older = await this.backend.getCandles(id, tf, first.time);
      if (gen !== this.gen) return;
      // An empty page with a warning is a failure, not the start of history.
      if (older.warning && older.time.length === 0) {
        this.fail("older", older.warning);
        return;
      }
      this.chart.prependData(older);
      if (older.warning) this.warn("older", older.warning);
      else this.recovered("older");
      this.bump();
    } catch (e) {
      if (gen === this.gen) this.fail("older", toProblem(e));
    } finally {
      if (gen === this.gen) this.olderInFlight = false;
    }
  }

  /** Runs every scheduled retry now (e.g. when the connection comes back). */
  async retryNow(): Promise<void> {
    const due = [...this.pending].filter(([, p]) => p.timer !== null).map(([k]) => k);
    await Promise.all(due.map((k) => this.retry(k)));
  }

  private async retry(kind: RetryKind): Promise<void> {
    const p = this.pending.get(kind);
    if (!p || p.timer === null) return;
    clearTimeout(p.timer);
    p.timer = null;
    p.retryAt = null;
    this.publishProblem();
    if (kind === "latest") {
      await this.loadLatest(this.gen);
    } else {
      // The chart asks again (synchronously) if it still needs older candles.
      this.chart.releaseOlder();
      if (!this.olderInFlight) this.recovered("older");
    }
  }

  /** Stops the live stream and every pending retry; later results are dropped. */
  close(): void {
    this.reset();
  }

  private reset(): number {
    this.gen++;
    this.stopLive?.();
    this.stopLive = null;
    this.liveGen = 0;
    this.olderInFlight = false;
    this.replaceOnLoad = false;
    for (const p of this.pending.values()) if (p.timer !== null) clearTimeout(p.timer);
    this.pending.clear();
    return this.gen;
  }

  private async loadLatest(gen: number): Promise<void> {
    const { id, tf } = this.state;
    if (!id) return;
    let page: Candles;
    try {
      page = await this.backend.getCandles(id, tf);
    } catch (e) {
      if (gen !== this.gen) return;
      if (this.chart.count === 0) this.set({ status: "failed" });
      this.fail("latest", toProblem(e));
      return;
    }
    if (gen !== this.gen) return;
    if (this.chart.count === 0 || this.replaceOnLoad) this.chart.setData(page);
    else this.merge(page);
    this.replaceOnLoad = false;
    this.set({ status: "ready", instrument: page.instrument });
    this.bump();
    if (page.warning) this.fail("latest", page.warning);
    else this.recovered("latest");
    if (this.liveGen !== gen) await this.subscribe(gen);
  }

  /** Applies a newer page to a chart that already has candles, without resetting the view. */
  private merge(page: Candles): void {
    const n = page.time.length;
    const last = this.chart.candle(this.chart.count - 1);
    if (n === 0 || !last) return;
    if (page.time[0]! > last.time) {
      // The gap is wider than a page: start over from the newest page.
      this.chart.setData(page);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (page.time[i]! < last.time) continue;
      this.chart.updateLast({
        time: page.time[i]!,
        open: page.open[i]!,
        high: page.high[i]!,
        low: page.low[i]!,
        close: page.close[i]!,
        volume: page.volume[i]!,
        closed: i < n - 1,
      });
    }
  }

  private async subscribe(gen: number): Promise<void> {
    const { id, tf } = this.state;
    if (!id) return;
    this.liveGen = gen;
    if (id.source === CSV_SOURCE) return; // a file does not change
    try {
      const stop = await this.backend.subscribeLive(id, tf, (e) => {
        if (gen === this.gen) this.onLive(e);
      });
      if (gen !== this.gen) stop();
      else this.stopLive = stop;
    } catch (e) {
      if (gen !== this.gen) return;
      this.liveGen = 0;
      this.fail("latest", toProblem(e));
    }
  }

  private onLive(e: LiveEvent): void {
    if (e.kind === "candle") {
      this.chart.updateLast(e);
    } else if (e.kind === "backfilled") {
      const b = e.candles;
      const instrument = this.state.instrument;
      if (e.reset && instrument) {
        // The engine replaced the cached series: start over from it.
        this.chart.setData({ instrument, ...b, atHistoryStart: false, warning: null });
        this.bump();
        return;
      }
      const last = this.chart.candle(this.chart.count - 1);
      if (last && b.time.length > 0 && b.time[0]! < last.time) {
        // Live bars went past a gap that this backfill fills, and the chart drops bars older
        // than its last one: reload the newest page, the cache is complete by now.
        this.replaceOnLoad = true;
        void this.loadLatest(this.gen);
        return;
      }
      for (let i = 0; i < b.time.length; i++) {
        this.chart.updateLast({
          time: b.time[i]!,
          open: b.open[i]!,
          high: b.high[i]!,
          low: b.low[i]!,
          close: b.close[i]!,
          volume: b.volume[i]!,
          closed: true,
        });
      }
    } else {
      // "disconnected": the connection state reports it; the engine backfills later.
      return;
    }
    this.bump();
  }

  /**
   * A request of `kind` failed: schedules its retry with that kind's backoff, but never
   * sooner than the exchange's `Retry-After`.
   */
  private fail(kind: RetryKind, problem: Problem): void {
    const p = this.pending.get(kind) ?? { problem, retryAt: null, timer: null, failures: 0 };
    const backoff = RETRY_DELAYS_S[Math.min(p.failures, RETRY_DELAYS_S.length - 1)]! * 1000;
    const delay = Math.max(backoff, (problem.retryAfterS ?? 0) * 1000);
    if (p.timer !== null) clearTimeout(p.timer);
    p.failures++;
    p.problem = problem;
    p.retryAt = Date.now() + delay;
    p.timer = setTimeout(() => void this.retry(kind), delay);
    this.pending.set(kind, p);
    this.publishProblem();
  }

  /** A request of `kind` succeeded with a warning: shown, but nothing to retry for it. */
  private warn(kind: RetryKind, problem: Problem): void {
    const p = this.pending.get(kind);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.set(kind, { problem, retryAt: null, timer: null, failures: 0 });
    this.publishProblem();
  }

  /** A request of `kind` succeeded: clears that kind only. */
  private recovered(kind: RetryKind): void {
    const p = this.pending.get(kind);
    if (!p) return;
    if (p.timer !== null) clearTimeout(p.timer);
    this.pending.delete(kind);
    this.publishProblem();
  }

  /** The banner state: shown while any kind is pending; the countdown is the soonest retry. */
  private publishProblem(): void {
    const all = [...this.pending.values()];
    if (all.length === 0) {
      if (this.state.problem) this.set({ problem: null });
      return;
    }
    const times = all.map((p) => p.retryAt).filter((t): t is number => t !== null);
    const { code, message } = (this.pending.get("latest") ?? all[0]!).problem;
    this.set({ problem: { code, message, retryAt: times.length ? Math.min(...times) : null } });
  }

  private bump(): void {
    this.set({ version: this.state.version + 1 });
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
