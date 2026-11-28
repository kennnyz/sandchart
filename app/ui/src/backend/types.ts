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

// Indicators (dto.rs). Param values are externally tagged, as `{ int: 20 }`.
export type ParamValue = { int: number } | { float: number } | { boolean: boolean } | { choice: string };
export type ParamKind = { int: [number, number] } | { float: [number, number] } | "boolean" | { choice: string[] };
export interface ParamSpec {
  id: string;
  label: string;
  kind: ParamKind;
  default: ParamValue;
}
export type SeriesKind = "line" | "histogram" | "markers" | { band: [string, string] };
export interface SeriesSpec {
  id: string;
  label: string;
  kind: SeriesKind;
  pane: "price" | "own";
  /** Palette slot, 0..=7. */
  color: number;
}
export interface IndicatorMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  params: ParamSpec[];
  series: SeriesSpec[];
}
export interface IndicatorInfo {
  meta: IndicatorMeta;
  builtin: boolean;
  /** The module changed earlier values when later bars arrived. */
  repaints: boolean;
}
/** A built-in or installed module that could not be loaded; its chart instances stay stored. */
export interface FailedIndicator {
  id: string;
  builtin: boolean;
  error: string;
}
export interface IndicatorList {
  indicators: IndicatorInfo[];
  failed: FailedIndicator[];
  /** Why the indicator service could not do its work (runtime did not start, list unreadable). */
  error: string | null;
}
/** A checked module file that is not installed yet. */
export interface Inspection {
  meta: IndicatorMeta;
  /** The installed version of the same id, which an install would replace. */
  replaces: string | null;
}
/** One indicator on the chart. `instance` ids are made by the UI. */
export interface IndicatorInstance {
  instance: string;
  moduleId: string;
  params: [string, ParamValue][];
  /** Palette slot per series id. */
  colors: Record<string, number>;
  hidden: boolean;
}
export interface Marker {
  /** Index into the computed bars (`firstTime` is bar 0). */
  index: number;
  shape: "up" | "down" | "dot";
  text: string | null;
}
/** `values` has one entry per bar; NaN is a gap. A band series carries empty values. */
export type SeriesData = { values: Float64Array } | { markers: Marker[] };
export interface ComputedIndicator {
  /** Open time of the first and last bar kept. */
  firstTime: number;
  lastTime: number;
  series: { id: string; data: SeriesData }[];
  log: string;
}
export interface IndicatorResult {
  instance: string;
  result: { ok: ComputedIndicator } | { err: string };
}

// Drawings (dto.rs, sandchart_core::drawing). Prices are ticks at `priceScale`; times are ms.
/** A point anchored by time and price, never by bar index. */
export interface Anchor {
  t: number;
  p: number;
}
export interface DrawingStyle {
  /** Palette slot, 0..=7. */
  color: number;
  /** Line width in px, 1..=4. */
  width: number;
  dash: boolean;
}
export type Side = "long" | "short";
/** Long: stop < entry.p < take. Short: take < entry.p < stop. `endT` is after `entry.t`. */
export interface PositionBody {
  side: Side;
  entry: Anchor;
  stop: number;
  take: number;
  endT: number;
}
export type DrawingBody =
  | { kind: "trend"; a: Anchor; b: Anchor; extendLeft: boolean; extendRight: boolean }
  | { kind: "hline"; p: number }
  | { kind: "rect"; a: Anchor; b: Anchor; extendRight: boolean }
  /** `levels`: 1..=16 ratios of the a-b range, each in -5..=5. */
  | { kind: "fib"; a: Anchor; b: Anchor; levels: number[] }
  | ({ kind: "position" } & PositionBody)
  /** 2..=500 points. */
  | { kind: "brush"; points: Anchor[] }
  /** 1..=2000 bytes of UTF-8 text. */
  | { kind: "note"; t: number; text: string };
export type DrawingKind = DrawingBody["kind"];
/** A drawing to save. `id` is made by the UI: 1 to 64 characters from A-Z, a-z, 0-9, _ and -. */
export interface DrawingInput {
  id: string;
  instrument: InstrumentId;
  /**
   * The scale the prices are ticks at: the one the drawing was loaded or made at. The
   * engine rescales to the instrument's current scale, and rejects a drawing that no longer fits.
   */
  priceScale: number;
  body: DrawingBody;
  style: DrawingStyle;
  locked: boolean;
  /** Paint order, lowest first. */
  z: number;
}
/** A stored drawing, at the instrument's price scale; the engine sets `updatedAt` on save. */
export interface Drawing extends DrawingInput {
  updatedAt: number;
}
/** A bar that touched both stop and take counts as a stop and is `ambiguous`. */
export interface PositionOutcome {
  status: "open" | "take" | "stop";
  /** Open time of the bar that closed the position. */
  exitTime: number | null;
  ambiguous: boolean;
  /** Reward over risk on a take, -1 on a stop, 0 while open. */
  r: number;
}

// Replay (dto.rs, sandchart_core::replay). `bar` indexes the session's candles: context
// before `start`, then the revealed bars up to `current`.
/** Open fills at the close of `bar`; an edit is in force from the next bar; close fills at the close of `bar`. */
export type ReplayCommand =
  | { kind: "open"; bar: number; side: Side; stop: number; take: number }
  | { kind: "edit"; bar: number; stop?: number; take?: number }
  | { kind: "close"; bar: number };
export type ExitReason = "take" | "stop" | "manual" | "open";
/** One trade. An open trade has no exit; its `r` is marked to the close of the current bar. */
export interface ReplayTrade {
  side: Side;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  /** The stop at entry; R is measured against it. */
  initialStop: number;
  /** The levels in force at the exit (or now, while open). */
  stop: number;
  take: number;
  exitBar: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  reason: ExitReason;
  /** The exit bar touched both stop and take; it counts as a stop. */
  ambiguous: boolean;
  /** (exit - entry) / (entry - initialStop), for longs and shorts alike. */
  r: number;
}
/** Over closed trades only, in R. Wins have R > 0, losses R < 0. */
export interface ReplayStats {
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  totalR: number;
  averageR: number;
  expectancy: number;
  /** Null without losses. */
  profitFactor: number | null;
  /** Deepest fall of the running R total below its peak, as a positive number. */
  maxDrawdownR: number;
  longestLosingStreak: number;
}
/** The session as the engine shows it: bars from index `from` to `current`, never a later one. */
export interface ReplayState {
  instrument: Instrument;
  tf: TimeframeCode;
  /** Index of the first replayed bar. */
  start: number;
  /** Index of the last revealed bar. */
  current: number;
  /** No bar is left to reveal. */
  atEnd: boolean;
  /** Index of `bars.time[0]`. */
  from: number;
  bars: CandleColumns;
  commands: ReplayCommand[];
  trades: ReplayTrade[];
  stats: ReplayStats;
}

// Updates (dto.rs).
/** Why this copy cannot update itself; the UI links to the release page instead. */
export type InstallBlocker = "not_appimage" | "translocated";
/** A version newer than the running one. */
export interface UpdateInfo {
  version: string;
  /** Release notes, plain text; empty when there are none. */
  notes: string;
  /** Publish date, RFC 3339. */
  date: string | null;
  blocker: InstallBlocker | null;
}
/** Messages of an install; `downloaded` is cumulative bytes. An error can still follow `installing`. */
export type UpdateProgress =
  | { kind: "started"; total: number | null }
  | { kind: "chunk"; downloaded: number }
  | { kind: "installing" };

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
  listIndicators(): Promise<IndicatorList>;
  /** Checks a module file without installing it. */
  inspectIndicator(bytes: Uint8Array): Promise<Inspection>;
  installIndicator(bytes: Uint8Array): Promise<IndicatorInfo>;
  /** Uninstalls a module and removes its chart instances; built-ins cannot be removed. */
  removeIndicator(id: string): Promise<void>;
  getChartIndicators(): Promise<IndicatorInstance[]>;
  setChartIndicators(items: IndicatorInstance[]): Promise<void>;
  /** Every visible chart indicator over all cached bars, cut to bars with `time >= fromTime`. */
  computeIndicators(id: InstrumentId, tf: TimeframeCode, fromTime: number): Promise<IndicatorResult[]>;
  /** The instrument's drawings in paint order (z, then id), in its current price scale. */
  getDrawings(id: InstrumentId): Promise<Drawing[]>;
  /** Validates and stores a drawing (insert or replace by id); resolves to it as stored. */
  saveDrawing(d: DrawingInput): Promise<Drawing>;
  /** Removes a drawing; an unknown id is not an error. */
  deleteDrawing(id: string): Promise<void>;
  /** Outcome of each position over the cached candles of `tf`, in the order given. */
  getPositionOutcomes(
    id: InstrumentId,
    tf: TimeframeCode,
    positions: { id: string; position: PositionBody }[],
  ): Promise<{ id: string; outcome: PositionOutcome }[]>;
  /**
   * Starts a replay (replacing any open one) at the cached bar opening at `startTime`, with
   * up to 500 bars of context before it. Live events of the instrument pause until `replayExit`.
   * Resolves to the state with every revealed bar.
   */
  replayStart(id: InstrumentId, tf: TimeframeCode, startTime: number): Promise<ReplayState>;
  /** Reveals up to `n` more bars; resolves to the index of the current bar. */
  replayStep(n: number): Promise<number>;
  /** Appends a command; rejects one that breaks a rule (bar order, unrevealed bar, levels, one trade at a time). */
  replayCommand(command: ReplayCommand): Promise<void>;
  /** The session with the revealed bars from index `cursor` on (pass how many bars the chart has). */
  replayState(cursor: number): Promise<ReplayState>;
  /** Saves the session as a `.replay` file; resolves to where, or null when the user cancelled. */
  replaySave(): Promise<string | null>;
  /** Checks a `.replay` file and opens it as the session; resolves to the state with every revealed bar. */
  replayOpen(bytes: Uint8Array): Promise<ReplayState>;
  replayExit(): Promise<void>;
  /** A newer version than this one, or null. Also remembers it for `installUpdate`. */
  checkUpdate(): Promise<UpdateInfo | null>;
  /**
   * Downloads, verifies and installs the update of the last check, then restarts the app. A
   * failed attempt keeps nothing: the next one needs a new `checkUpdate`. On Windows it never
   * resolves (the installer ends the process).
   */
  installUpdate(onProgress: (p: UpdateProgress) => void): Promise<void>;
}
