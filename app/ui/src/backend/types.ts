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

export interface Candles extends CandleColumns {
  instrument: Instrument;
  atHistoryStart: boolean;
  warning: string | null;
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
  | { kind: "backfilled"; candles: CandleColumns }
  | { kind: "disconnected" };

export interface DayChange {
  id: InstrumentId;
  /** Last price in price ticks. */
  last: number;
  /** 24 h change in basis points (1.84 % is 184). */
  changeBp: number;
}

export type ConnectionState = "connected" | "reconnecting" | "offline";

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
  /** Resolves to the function that stops listening. */
  onConnection(cb: (s: ConnectionState) => void): Promise<() => void>;
}
