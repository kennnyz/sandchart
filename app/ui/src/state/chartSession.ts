import type {
  Backend,
  Candles,
  Instrument,
  InstrumentId,
  LiveCandle,
  LiveEvent,
  TimeframeCode,
} from "../backend/types";

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
}

/** Seconds before each retry after consecutive failures; the last one repeats. */
export const RETRY_DELAYS_S = [5, 10, 20, 40, 60];

type RetryKind = "latest" | "older";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryKind: RetryKind | null = null;
  private failures = 0;
  private state: SessionState = {
    id: null,
    tf: "1h",
    status: "idle",
    instrument: null,
    problem: null,
    version: 0,
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
    this.set({ id, tf, status: "loading", instrument: null, problem: null, version: this.state.version + 1 });
    await this.loadLatest(gen);
  }

  /** Loads the page before the first candle; `Chart.onNeedOlder` calls it. */
  async loadOlder(): Promise<void> {
    const gen = this.gen;
    const { id, tf } = this.state;
    const first = this.chart.candle(0);
    if (!id || !first || this.olderInFlight) return;
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
      if (older.warning) this.set({ problem: { message: older.warning, retryAt: null } });
      else this.recovered("older");
      this.bump();
    } catch (e) {
      if (gen === this.gen) this.fail("older", message(e));
    } finally {
      if (gen === this.gen) this.olderInFlight = false;
    }
  }

  /** Runs the pending retry now (e.g. when the connection comes back). */
  async retryNow(): Promise<void> {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const kind = this.retryKind;
    this.retryKind = null;
    if (this.state.problem) this.set({ problem: { ...this.state.problem, retryAt: null } });
    if (kind === "latest") {
      await this.loadLatest(this.gen);
    } else if (kind === "older") {
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
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryKind = null;
    this.failures = 0;
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
      this.fail("latest", message(e));
      return;
    }
    if (gen !== this.gen) return;
    if (this.chart.count === 0) this.chart.setData(page);
    else this.merge(page);
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
    try {
      const stop = await this.backend.subscribeLive(id, tf, (e) => {
        if (gen === this.gen) this.onLive(e);
      });
      if (gen !== this.gen) stop();
      else this.stopLive = stop;
    } catch (e) {
      if (gen !== this.gen) return;
      this.liveGen = 0;
      this.fail("latest", message(e));
    }
  }

  private onLive(e: LiveEvent): void {
    if (e.kind === "candle") {
      this.chart.updateLast(e);
    } else if (e.kind === "backfilled") {
      const b = e.candles;
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

  private fail(kind: RetryKind, text: string): void {
    const delay = RETRY_DELAYS_S[Math.min(this.failures, RETRY_DELAYS_S.length - 1)]! * 1000;
    this.failures++;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryKind = kind;
    this.retryTimer = setTimeout(() => void this.retryNow(), delay);
    this.set({ problem: { message: text, retryAt: Date.now() + delay } });
  }

  /** A request of `kind` succeeded: clears the problem unless another kind is pending. */
  private recovered(kind: RetryKind): void {
    if (this.retryKind !== null && this.retryKind !== kind) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryKind = null;
    this.failures = 0;
    if (this.state.problem) this.set({ problem: null });
  }

  private bump(): void {
    this.set({ version: this.state.version + 1 });
  }

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
