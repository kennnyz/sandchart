// Wire types shared with the Rust side (src-tauri/src/dto.rs). Tick values are
// integers that fit in a JS number (Rust rejects anything beyond 2^53 - 1).

export interface InstrumentId {
  source: string;
  symbol: string;
}

export interface Instrument {
  id: InstrumentId;
  base: string;
  quote: string;
  /** Decimal places of one price tick. */
  priceScale: number;
  /** Decimal places of one quantity tick. */
  qtyScale: number;
}

export const TIMEFRAME_CODES = [
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M",
] as const;
export type TimeframeCode = (typeof TIMEFRAME_CODES)[number];

/** Candles as parallel arrays, oldest first. `time` is ms since the Unix epoch (UTC). */
export interface CandleColumns {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

/** What kind of trouble a command hit (`ProblemCode` in dto.rs). */
export type ProblemCode = "network" | "rate_limited" | "blocked" | "unsafe_ticks" | "other";

/** The error of every command and the warning of a candle page (`ProblemDto`). */
export interface Problem {
  code: ProblemCode;
  /** The raw error text. */
  message: string;
  /** Seconds the exchange asked us to wait (`Retry-After`). */
  retryAfterS?: number;
}

const PROBLEM_CODES: readonly string[] = ["network", "rate_limited", "blocked", "unsafe_ticks", "other"];

/** A rejected command as a `Problem`; anything else (a JS error) is `other`. */
export function toProblem(e: unknown): Problem {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    const p = e as Problem;
    if (PROBLEM_CODES.includes(p.code)) return p;
  }
  return { code: "other", message: e instanceof Error ? e.message : String(e) };
}

export interface Candles extends CandleColumns {
  instrument: Instrument;
  atHistoryStart: boolean;
  /** Set when the provider failed and cached candles were served instead. */
  warning: Problem | null;
}

export interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** True once the bar is final. */
  closed: boolean;
}

export type LiveEvent =
  | ({ kind: "candle" } & LiveCandle)
  /** `reset`: the cached series was replaced, so these candles replace the chart. */
  | { kind: "backfilled"; candles: CandleColumns; reset: boolean }
  | { kind: "disconnected" };

export interface DayChange {
  id: InstrumentId;
  /** Last price in price ticks. */
  last: number;
  /** 24 h change in basis points (1.84 % is 184). */
  changeBp: number;
}

/** `connecting`: nothing has answered yet since the app started. */
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export interface Backend {
  searchInstruments(q: string): Promise<Instrument[]>;
  /** Up to 1000 candles ending before `before` (newest when omitted), ascending. */
  getCandles(id: InstrumentId, tf: TimeframeCode, before?: number): Promise<Candles>;
  /** Resolves to the function that stops the subscription. */
  subscribeLive(
    id: InstrumentId,
    tf: TimeframeCode,
    onEvent: (e: LiveEvent) => void,
  ): Promise<() => void>;
  getWatchlist(): Promise<InstrumentId[]>;
  setWatchlist(ids: InstrumentId[]): Promise<void>;
  getWatchlistQuotes(): Promise<DayChange[]>;
  /** The current state; `onConnection` only reports changes after it. */
  getConnection(): Promise<ConnectionState>;
  /** Resolves to the function that stops listening. */
  onConnection(cb: (s: ConnectionState) => void): Promise<() => void>;
  /** True once the instrument list was synced; ask after `onInstrumentsSynced` is set up. */
  instrumentsReady(): Promise<boolean>;
  /** Called when the instrument list was synced. Resolves to the function that stops listening. */
  onInstrumentsSynced(cb: () => void): Promise<() => void>;
}
