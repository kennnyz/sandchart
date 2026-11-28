import {
  type Alert,
  type Backend,
  type CandleColumns,
  type Candles,
  type ConnectionState,
  type Drawing,
  type DrawingBody,
  type DrawingInput,
  type Instrument,
  type IndicatorInfo,
  type IndicatorInstance,
  type IndicatorMeta,
  type IndicatorResult,
  type InstrumentId,
  type LiveEvent,
  type ParamValue,
  type PositionBody,
  type PositionOutcome,
  type ReplayCommand,
  type ReplayState,
  type SeriesData,
  type SeriesSpec,
  type Problem,
  type TimeframeCode,
  type UpdateInfo,
} from "./types";
import { type MockUpdate, mockFires, mockLevelOf, mockValidateAlert } from "./mockAlerts";
import {
  MOCK_MAX_REPLAY_CANDLES,
  type MockCandle,
  mockAggregate,
  mockAtRealTime,
  mockBucketStart,
  mockBuildsFrom,
  mockCloseTime,
  mockHigher,
  mockReadReplay,
  mockRevealed,
  mockSimulate,
  mockSplit,
  mockViewError,
  mockWriteReplay,
} from "./mockReplay";

const PAGE = 1000;
/** Bars of context before a replay's start, as `REPLAY_CONTEXT` in the engine. */
const REPLAY_CONTEXT = 500;
/** Most candles of context a re-base to a lower timeframe keeps, as `REBASE_CONTEXT` in the engine. */
const REBASE_CONTEXT = 5_000;
const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const STEP_MS: Record<TimeframeCode, number> = {
  "1m": MINUTE,
  "3m": 3 * MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "1h": 60 * MINUTE,
  "2h": 120 * MINUTE,
  "4h": 240 * MINUTE,
  "6h": 360 * MINUTE,
  "8h": 480 * MINUTE,
  "12h": 720 * MINUTE,
  "1d": 1440 * MINUTE,
  "3d": 4320 * MINUTE,
  "1w": 10_080 * MINUTE,
  "1M": 43_200 * MINUTE, // the mock treats a month as 30 days
};

// Fixed "now" so mock data is reproducible.
const MOCK_END = Date.UTC(2026, 10, 27);

const SYMBOLS: Instrument[] = [
  ["BTC", "USDT"],
  ["ETH", "USDT"],
  ["SOL", "USDT"],
  ["BNB", "USDT"],
  ["XRP", "USDT"],
  ["DOGE", "USDT"],
  ["ADA", "USDT"],
  ["ETH", "BTC"],
].map(([base, quote]) => ({
  id: { source: "mock", symbol: `${base}${quote}` },
  base: base!,
  quote: quote!,
  priceScale: 2,
  qtyScale: 5,
}));

export interface MockOptions {
  /** How many candles exist in total per instrument and timeframe. */
  candles: number;
  /** Artificial delay of every call. */
  latencyMs?: number;
  /** Candles before this time (ms) do not exist. */
  historyStartAt?: number;
  /** Centre of the generated prices in ticks (default 10 000, i.e. 100.00). */
  basePrice?: number;
  /** Decimal places of a price tick for every instrument (default 2). */
  priceScale?: number;
  /** One instrument whose candles and live stream answer with a different delay. */
  slow?: { symbol: string; latencyMs: number };
  /** Set on every candle page, as the engine does when the provider fails. */
  warning?: Problem;
  /** What `getConnection` reports (default "connected"). */
  connection?: ConnectionState;
  /** The instrument list is empty until this many ms after creation, as on a first run. */
  instrumentsAfterMs?: number;
  /** Initial watchlist symbols (default: the first five instruments). */
  watchlist?: string[];
  /** Built-in indicators (`sma`, `bollinger`, ...) that start on the chart, as `mock-<name>`. */
  indicators?: string[];
  /** Every indicator compute answers `{ err: "mock: out of fuel" }`. */
  indicatorError?: boolean;
  /** Every `setChartIndicators` rejects with "mock: cannot save". */
  indicatorSaveError?: boolean;
  /** Every `saveDrawing` and `deleteDrawing` rejects with "mock: cannot save the drawing". */
  drawingSaveError?: boolean;
  /** `listIndicators` reports the installed module `test.broken` as failed to load, and a service error. */
  indicatorProblems?: boolean;
  /** The first this many `listIndicators` calls reject with "mock: engine starting". */
  indicatorLoadFailures?: number;
  /** What `checkUpdate` finds; none when absent. */
  update?: UpdateInfo;
  /** `check`: every `checkUpdate` rejects; `install`: every download fails halfway. */
  updateError?: "check" | "install";
  /** Keeps the watchlist across page loads (the browser mock uses localStorage). */
  watchlistStore?: { load(): InstrumentId[] | null; save(ids: InstrumentId[]): void };
  /** Keeps the drawings across page loads (the browser mock uses localStorage). */
  drawingStore?: { load(): Drawing[] | null; save(all: Drawing[]): void };
  /** Keeps the alerts across page loads (the browser mock uses localStorage). */
  alertStore?: { load(): Alert[] | null; save(all: Alert[]): void };
}

// The store's alert caps (MAX_ACTIVE_ALERTS, MAX_ALERT_PAIRS, MAX_ALERTS).
const MAX_ACTIVE_ALERTS = 100;
const MAX_ALERT_PAIRS = 30;
const MAX_ALERTS = 500;

// ---- Indicators -------------------------------------------------------------------
// TEST-ONLY CODE. The real indicators are WebAssembly modules run by the Rust engine;
// this is a small TS copy of the built-ins so the browser mock and the e2e tests have
// something to draw. It follows the SDK's seeding: EMA and RMA start from the SMA of the
// first `period` values, stdev is the population one, RSI is Wilder's.

const BAR_CAP = 100_000; // the engine's MAX_INDICATOR_BARS

const nanArray = (n: number) => new Float64Array(n).fill(NaN);

export function mockSma(src: ArrayLike<number>, period: number): Float64Array {
  const out = nanArray(src.length);
  for (let i = period - 1; i < src.length; i++) {
    let sum = 0;
    for (let j = i + 1 - period; j <= i; j++) sum += src[j]!;
    out[i] = sum / period;
  }
  return out;
}

function recursive(src: ArrayLike<number>, period: number, alpha: number): Float64Array {
  const out = nanArray(src.length);
  let prev = NaN;
  let run = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i]!;
    if (Number.isNaN(x)) {
      run = 0;
      prev = NaN;
      continue;
    }
    run++;
    if (run < period) continue;
    if (run === period) {
      let sum = 0;
      for (let j = i + 1 - period; j <= i; j++) sum += src[j]!;
      prev = sum / period;
    } else {
      prev += alpha * (x - prev);
    }
    out[i] = prev;
  }
  return out;
}

const mockEma = (src: ArrayLike<number>, n: number) => recursive(src, n, 2 / (n + 1));
const mockRma = (src: ArrayLike<number>, n: number) => recursive(src, n, 1 / n);

function mockStdev(src: ArrayLike<number>, period: number): Float64Array {
  const out = nanArray(src.length);
  const mean = mockSma(src, period);
  for (let i = period - 1; i < src.length; i++) {
    let sum = 0;
    for (let j = i + 1 - period; j <= i; j++) sum += (src[j]! - mean[i]!) ** 2;
    out[i] = Math.sqrt(sum / period);
  }
  return out;
}

interface MockBars {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
}

const SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4"];

function pickSource(bars: MockBars, name: string): number[] {
  const { open, high, low, close } = bars;
  const f: Record<string, (i: number) => number> = {
    open: (i) => open[i]!,
    high: (i) => high[i]!,
    low: (i) => low[i]!,
    close: (i) => close[i]!,
    hl2: (i) => (high[i]! + low[i]!) / 2,
    hlc3: (i) => (high[i]! + low[i]! + close[i]!) / 3,
    ohlc4: (i) => (open[i]! + high[i]! + low[i]! + close[i]!) / 4,
  };
  return bars.time.map((_, i) => (f[name] ?? f.close!)(i));
}

type P = Map<string, ParamValue>;
const num = (p: P, id: string): number => {
  const v = p.get(id)!;
  return "int" in v ? v.int : "float" in v ? v.float : NaN;
};
const choice = (p: P, id: string): string => {
  const v = p.get(id)!;
  return "choice" in v ? v.choice : "close";
};

const intSpec = (id: string, label: string, min: number, max: number, d: number) => ({
  id,
  label,
  kind: { int: [min, max] as [number, number] },
  default: { int: d },
});
const sourceSpec = {
  id: "source",
  label: "Source",
  kind: { choice: SOURCES },
  default: { choice: "close" },
};
const line = (id: string, label: string, pane: "price" | "own", color: number): SeriesSpec => ({
  id,
  label,
  kind: "line",
  pane,
  color,
});
const meta = (
  id: string,
  name: string,
  description: string,
  params: IndicatorMeta["params"],
  series: SeriesSpec[],
): IndicatorMeta => ({ id: `builtin.${id}`, name, version: "0.2.0", description, params, series });

type Compute = (p: P, bars: MockBars) => Record<string, Float64Array>;

const MOCK_BUILTINS: { meta: IndicatorMeta; compute: Compute }[] = [
  {
    meta: meta("sma", "SMA", "Simple moving average", [intSpec("period", "Period", 1, 1000, 20), sourceSpec], [
      line("sma", "SMA", "price", 0),
    ]),
    compute: (p, b) => ({ sma: mockSma(pickSource(b, choice(p, "source")), num(p, "period")) }),
  },
  {
    meta: meta("ema", "EMA", "Exponential moving average", [intSpec("period", "Period", 1, 1000, 20), sourceSpec], [
      line("ema", "EMA", "price", 1),
    ]),
    compute: (p, b) => ({ ema: mockEma(pickSource(b, choice(p, "source")), num(p, "period")) }),
  },
  {
    meta: meta(
      "bollinger",
      "Bollinger Bands",
      "Moving average with bands at a number of standard deviations",
      [
        intSpec("period", "Period", 2, 1000, 20),
        { id: "mult", label: "Deviations", kind: { float: [0.1, 10] }, default: { float: 2 } },
        sourceSpec,
      ],
      [
        line("basis", "Basis", "price", 2),
        line("upper", "Upper", "price", 3),
        line("lower", "Lower", "price", 3),
        { id: "fill", label: "Fill", kind: { band: ["upper", "lower"] }, pane: "price", color: 3 },
      ],
    ),
    compute(p, b) {
      const src = pickSource(b, choice(p, "source"));
      const basis = mockSma(src, num(p, "period"));
      const dev = mockStdev(src, num(p, "period"));
      const mult = num(p, "mult");
      return {
        basis,
        upper: basis.map((m, i) => m + mult * dev[i]!),
        lower: basis.map((m, i) => m - mult * dev[i]!),
        fill: new Float64Array(0),
      };
    },
  },
  {
    meta: meta(
      "rsi",
      "RSI",
      "Relative strength index, Wilder smoothing",
      [intSpec("period", "Period", 2, 1000, 14), sourceSpec],
      [line("rsi", "RSI", "own", 4)],
    ),
    compute(p, b) {
      const src = pickSource(b, choice(p, "source"));
      const gain = nanArray(src.length);
      const loss = nanArray(src.length);
      for (let i = 1; i < src.length; i++) {
        const d = src[i]! - src[i - 1]!;
        gain[i] = Math.max(d, 0);
        loss[i] = Math.max(-d, 0);
      }
      const g = mockRma(gain, num(p, "period"));
      const l = mockRma(loss, num(p, "period"));
      return { rsi: g.map((gv, i) => (l[i] === 0 ? (gv === 0 ? 50 : 100) : 100 - 100 / (1 + gv / l[i]!))) };
    },
  },
  {
    meta: meta(
      "macd",
      "MACD",
      "Moving average convergence divergence",
      [
        intSpec("fast", "Fast period", 1, 500, 12),
        intSpec("slow", "Slow period", 2, 1000, 26),
        intSpec("signal", "Signal period", 1, 500, 9),
        sourceSpec,
      ],
      [
        line("macd", "MACD", "own", 5),
        line("signal", "Signal", "own", 6),
        { id: "hist", label: "Histogram", kind: "histogram", pane: "own", color: 7 },
      ],
    ),
    compute(p, b) {
      if (num(p, "fast") >= num(p, "slow")) throw new Error("fast must be less than slow");
      const src = pickSource(b, choice(p, "source"));
      const f = mockEma(src, num(p, "fast"));
      const s = mockEma(src, num(p, "slow"));
      const macd = f.map((fv, i) => fv - s[i]!);
      const signal = mockEma(macd, num(p, "signal"));
      return { macd, signal, hist: macd.map((m, i) => m - signal[i]!) };
    },
  },
];

const MOCK_ECHO: IndicatorInfo = {
  meta: {
    id: "test.echo",
    name: "Echo",
    version: "1.0.0",
    description: "Test module: the close price",
    params: [],
    series: [line("echo", "Echo", "own", 1)],
  },
  builtin: false,
  repaints: true,
};

/** Saved params against a module's specs: unknown dropped, missing and invalid get the default. */
function resolveParams(m: IndicatorMeta, saved: [string, ParamValue][]): P {
  const out: P = new Map();
  for (const spec of m.params) {
    const v = saved.find(([id]) => id === spec.id)?.[1];
    const k = spec.kind;
    const valid =
      v !== undefined &&
      (typeof k === "string"
        ? "boolean" in v
        : "int" in k
          ? "int" in v && Number.isInteger(v.int) && v.int >= k.int[0] && v.int <= k.int[1]
          : "float" in k
            ? "float" in v && v.float >= k.float[0] && v.float <= k.float[1]
            : "choice" in v && k.choice.includes(v.choice));
    out.set(spec.id, valid ? v : spec.default);
  }
  return out;
}

// ---- Drawings ----------------------------------------------------------------------
// The rules of `sandchart_core::drawing::validate`, so the mock rejects what Rust rejects.

const MAX_DRAWINGS = 2000; // the store's MAX_DRAWINGS_PER_INSTRUMENT

function checkInt(what: string, v: number): string | null {
  return Number.isSafeInteger(v) ? null : `${what} ${v} is outside ±(2^53 - 1)`;
}

function checkPair(a: { t: number; p: number }, b: { t: number; p: number }): string | null {
  return (
    checkInt("point a time", a.t) ??
    checkInt("point a price", a.p) ??
    checkInt("point b time", b.t) ??
    checkInt("point b price", b.p) ??
    (a.t === b.t && a.p === b.p ? "the two points of a drawing must differ" : null)
  );
}

export function mockValidatePosition(p: PositionBody): string | null {
  const bad =
    checkInt("position entry time", p.entry.t) ??
    checkInt("position entry price", p.entry.p) ??
    checkInt("position stop", p.stop) ??
    checkInt("position take", p.take) ??
    checkInt("position end time", p.endT);
  if (bad) return bad;
  if (p.side === "long" && !(p.stop < p.entry.p && p.entry.p < p.take)) return "a long position needs stop < entry < take";
  if (p.side === "short" && !(p.take < p.entry.p && p.entry.p < p.stop)) return "a short position needs take < entry < stop";
  if (p.endT <= p.entry.t) return "a position must end after its entry";
  return null;
}

/** The error message Rust would give, or null when the drawing is valid. */
export function mockValidateDrawing(d: DrawingInput): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(d.id)) {
    return "a drawing id must be 1 to 64 characters from A-Z, a-z, 0-9, _ and -";
  }
  const { color, width } = d.style;
  if (!Number.isInteger(color) || color < 0 || color > 7) return `colour slot ${color} is not in 0..=7`;
  if (!Number.isInteger(width) || width < 1 || width > 4) return `line width ${width} is not in 1..=4`;
  const z = checkInt("z", d.z);
  if (z) return z;
  const b = d.body;
  switch (b.kind) {
    case "trend":
    case "rect":
      return checkPair(b.a, b.b);
    case "hline":
      return checkInt("price", b.p);
    case "fib": {
      const bad = checkPair(b.a, b.b);
      if (bad) return bad;
      if (b.levels.length < 1 || b.levels.length > 16) {
        return `a Fibonacci drawing needs 1 to 16 levels, not ${b.levels.length}`;
      }
      const l = b.levels.find((x) => !(Number.isFinite(x) && Math.abs(x) <= 5));
      // Rust prints infinity as "inf".
      const shown = l === Infinity ? "inf" : l === -Infinity ? "-inf" : String(l);
      return l === undefined ? null : `Fibonacci level ${shown} is not a number in -5..=5`;
    }
    case "position":
      return mockValidatePosition(b);
    case "brush":
      if (b.points.length < 2 || b.points.length > 500) {
        return `a brush stroke needs 2 to 500 points, not ${b.points.length}`;
      }
      for (const a of b.points) {
        const bad = checkInt("brush point time", a.t) ?? checkInt("brush point price", a.p);
        if (bad) return bad;
      }
      return null;
    case "note": {
      const bytes = new TextEncoder().encode(b.text).length;
      return (
        checkInt("note time", b.t) ??
        (bytes < 1 || bytes > 2000 ? `a note needs 1 to 2000 bytes of text, not ${bytes}` : null)
      );
    }
  }
}

/** `v` ticks at `from` decimals expressed at `to`, rounded half away from zero (`rescale_ticks`); null past i64. */
function rescaleTicks(v: number, from: number, to: number): number | null {
  const big = BigInt(v);
  let q: bigint;
  if (to >= from) {
    q = big * 10n ** BigInt(to - from);
  } else {
    const d = 10n ** BigInt(from - to);
    q = big / d;
    const r = big % d;
    if ((r < 0n ? -r : r) * 2n >= d) q += big < 0n ? -1n : 1n;
  }
  return q >= -(2n ** 63n) && q < 2n ** 63n ? Number(q) : null;
}

/** `d` with its prices at scale `to`, validated (`at_scale` in the engine); the error is Rust's. */
function mockAtScale<D extends DrawingInput>(d: D, to: number): D | string {
  const from = d.priceScale;
  if (from === to) return mockValidateDrawing(d) ?? d;
  let fits = true;
  const px = (v: number) => {
    const r = rescaleTicks(v, from, to);
    if (r === null) fits = false;
    return r ?? 0;
  };
  const at = (a: { t: number; p: number }) => ({ t: a.t, p: px(a.p) });
  const b = d.body;
  const body: DrawingBody =
    b.kind === "trend" || b.kind === "rect" || b.kind === "fib"
      ? { ...b, a: at(b.a), b: at(b.b) }
      : b.kind === "hline"
        ? { ...b, p: px(b.p) }
        : b.kind === "position"
          ? { ...b, entry: at(b.entry), stop: px(b.stop), take: px(b.take) }
          : b.kind === "brush"
            ? { ...b, points: b.points.map(at) }
            : b;
  if (!fits) return `at price scale ${to}: its prices do not fit the new tick size`;
  const r = { ...d, priceScale: to, body };
  const bad = mockValidateDrawing(r);
  return bad ? `at price scale ${to}: ${bad}` : r;
}

// TEST-ONLY CODE. The real outcome is `sandchart_core::position::resolve` in Rust; this copy
// lets the browser mock answer, and mock.test.ts checks it against the same fixture as Rust
// (crates/core/tests/fixtures/positions.json).
/**
 * Bars (ascending) after the one containing `entry.t`, up to the one opening at `endT`; the
 * first hit decides, and no bar after it is read (`resolve_iter`).
 */
export function mockResolve(p: PositionBody, bars: Iterable<{ time: number; high: number; low: number }>): PositionOutcome {
  for (const { time: t, high, low } of bars) {
    if (t <= p.entry.t) continue;
    if (t > p.endT) break;
    const long = p.side === "long";
    const hitStop = long ? low <= p.stop : high >= p.stop;
    const hitTake = long ? high >= p.take : low <= p.take;
    if (hitStop) return { status: "stop", exitTime: t, ambiguous: hitTake, r: -1 };
    if (hitTake) return { status: "take", exitTime: t, ambiguous: false, r: (p.take - p.entry.p) / (p.entry.p - p.stop) };
  }
  return { status: "open", exitTime: null, ambiguous: false, r: 0 };
}

/** Deterministic pseudo-random value in [0, 1) for candle number `n`. */
function noise(n: number, salt: number): number {
  const x = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function priceAt(n: number, base: number): number {
  // Slow wave plus noise, in ticks: base +- 20 %.
  return Math.round(base + 0.2 * base * Math.sin(n / 200) + 0.03 * base * (noise(n, 1) - 0.5));
}

function column(): CandleColumns {
  return { time: [], open: [], high: [], low: [], close: [], volume: [] };
}

/** The mock plus a way for tests to push live events into its open subscriptions. */
export interface MockBackend extends Backend {
  /**
   * To every open subscription, except those of an instrument being replayed. A candle also
   * feeds the alerts of each subscribed pair, as the engine does on its live streams.
   */
  emitLive(e: LiveEvent): void;
  /** The text of the last `replaySave`, or null. */
  replayFile(): string | null;
}

/** A replay session over base candles: the mock's (made as they are revealed) or a file's (ADR 0008). */
interface MockSession {
  instrument: Instrument;
  /** The step resolution, the timeframe of `candles`. */
  base: TimeframeCode;
  /** Base candles made so far, at least up to `current`. */
  candles: MockCandle[];
  /** How many base candles the session has in all. */
  total: number;
  /** Makes candle `k`; null when they are all in `candles` (a file, a re-base). */
  make: ((k: number) => MockCandle) | null;
  /** The cut when the replay began. */
  start: number;
  /** Index of the last revealed base candle. */
  current: number;
  commands: ReplayCommand[];
  /** Started from the mock's candles: at the newest one it catches up with real time. */
  live: boolean;
  /** The cut where it caught up and its backtest ended (a file's too); null before. */
  caughtUpAt: number | null;
}

export function createMockBackend(opts: MockOptions): MockBackend {
  const base = opts.basePrice ?? 10_000;
  const wick = base * 0.004;
  const sleep = (ms: number | undefined) =>
    ms ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
  const delay = () => sleep(opts.latencyMs);
  const delayFor = (symbol: string) =>
    sleep(opts.slow?.symbol === symbol ? opts.slow.latencyMs : opts.latencyMs);
  const initial = opts.watchlist
    ? SYMBOLS.filter((i) => opts.watchlist!.includes(i.id.symbol)).map((i) => i.id)
    : SYMBOLS.slice(0, 5).map((i) => i.id);
  let watchlist: InstrumentId[] = opts.watchlistStore?.load() ?? initial;
  const live = new Map<(e: LiveEvent) => void, InstrumentId>();
  let session: MockSession | null = null;
  let savedReplay: string | null = null;
  const synced = new Set<() => void>();
  let ready = !opts.instrumentsAfterMs;
  if (!ready) {
    setTimeout(() => {
      ready = true;
      for (const cb of synced) cb();
    }, opts.instrumentsAfterMs);
  }

  let echoInstalled = false;
  let brokenInstalled = opts.indicatorProblems ?? false;
  let loadFailures = opts.indicatorLoadFailures ?? 0;
  /** The last check found the update, as Rust keeps it for one install attempt. */
  let updateChecked = false;
  let chartIndicators: IndicatorInstance[] = (opts.indicators ?? []).map((name) => ({
    instance: `mock-${name}`,
    moduleId: `builtin.${name}`,
    params: [],
    colors: {},
    hidden: false,
  }));
  const drawings = new Map<string, Drawing>((opts.drawingStore?.load() ?? []).map((d) => [d.id, d]));
  const keepDrawings = () => opts.drawingStore?.save([...drawings.values()]);
  /** `save_drawings`: every one checked and rescaled first, then all stored or none, the cap held for the result. */
  const storeDrawings = (list: DrawingInput[]): Drawing[] => {
    if (list.length > MAX_DRAWINGS) throw problem(`at most ${MAX_DRAWINGS} drawings per request, not ${list.length}`);
    const now = Date.now();
    const out = list.map((d): Drawing => {
      // The Tauri command's DTO has no default for these: it refuses a call without them.
      for (const field of ["locked", "hidden"] as const) {
        if (d[field] === undefined) throw problem(`missing field \`${field}\``);
        if (typeof d[field] !== "boolean") throw problem(`invalid type for field \`${field}\`: expected a boolean`);
      }
      const instrument = SYMBOLS.find((i) => i.id.source === d.instrument.source && i.id.symbol === d.instrument.symbol);
      if (!instrument) throw problem(`unknown instrument ${d.instrument.source}/${d.instrument.symbol}`);
      if (opts.drawingSaveError) throw problem("mock: cannot save the drawing");
      const scaled = mockAtScale(structuredClone(d), opts.priceScale ?? instrument.priceScale);
      if (typeof scaled === "string") throw problem(scaled);
      return { ...scaled, updatedAt: now };
    });
    const next = new Map(drawings);
    for (const d of out) next.set(d.id, d);
    for (const key of new Set(out.map((d) => pairKey(d.instrument)))) {
      let n = 0;
      for (const o of next.values()) if (pairKey(o.instrument) === key) n++;
      if (n > MAX_DRAWINGS) throw problem(`an instrument can hold at most ${MAX_DRAWINGS} drawings; delete some first`);
    }
    for (const d of out) drawings.set(d.id, d);
    keepDrawings();
    // Alerts that can no longer follow their drawing go in the same step, as in `save_drawings`.
    const byId = new Map(out.map((d) => [d.id, d]));
    const gone = [...alerts.values()].filter((a) => {
      const d = a.kind.kind === "drawing" ? byId.get(a.kind.drawingId) : undefined;
      return d !== undefined && (!mockLevelOf(d.body) || pairKey(a.instrument) !== pairKey(d.instrument));
    });
    for (const a of gone) alerts.delete(a.id);
    if (gone.length > 0) keepAlerts();
    return out.map((d) => structuredClone(d));
  };
  /** `delete_drawings`: every id checked first; their alerts go in the same step. */
  const removeDrawings = (ids: string[]): void => {
    if (ids.length > MAX_DRAWINGS) throw problem(`at most ${MAX_DRAWINGS} drawings per request, not ${ids.length}`);
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw problem("a drawing id must be 1 to 64 characters from A-Z, a-z, 0-9, _ and -");
    }
    if (opts.drawingSaveError) throw problem("mock: cannot save the drawing");
    const set = new Set(ids);
    let changed = false;
    for (const id of set) changed = drawings.delete(id) || changed;
    if (changed) keepDrawings();
    const gone = [...alerts.values()].filter((a) => a.kind.kind === "drawing" && set.has(a.kind.drawingId));
    for (const a of gone) alerts.delete(a.id);
    if (gone.length > 0) keepAlerts();
  };
  const alerts = new Map<string, Alert>((opts.alertStore?.load() ?? []).map((a) => [a.id, a]));
  /** When each active alert was armed here: an update from before cannot fire it. */
  const armedAt = new Map<string, number>([...alerts.values()].filter((a) => a.active).map((a) => [a.id, Date.now()]));
  /** The last update of each pair with an active alert. */
  const lastUpdate = new Map<string, MockUpdate>();
  const firedListeners = new Set<(a: Alert) => void>();
  const changedListeners = new Set<() => void>();
  const pairKey = (id: InstrumentId) => `${id.source}/${id.symbol}`;
  const keepAlerts = () => {
    opts.alertStore?.save([...alerts.values()]);
    const armedPairs = new Set([...alerts.values()].filter((a) => a.active).map((a) => pairKey(a.instrument)));
    for (const k of lastUpdate.keys()) if (!armedPairs.has(k)) lastUpdate.delete(k);
    for (const cb of changedListeners) cb();
  };

  /** Arms `a` after the store's checks, as `upsert_alert` and `set_alert` in Rust. */
  function arm(a: Alert): Alert {
    const bad = mockValidateAlert(a);
    if (bad) throw problem(bad);
    if (!SYMBOLS.some((i) => pairKey(i.id) === pairKey(a.instrument))) {
      throw problem(`unknown instrument ${a.instrument.source}/${a.instrument.symbol}`);
    }
    if (a.kind.kind === "drawing") {
      const d = drawings.get(a.kind.drawingId);
      if (!d) throw problem(`drawing ${a.kind.drawingId} does not exist`);
      if (pairKey(d.instrument) !== pairKey(a.instrument)) throw problem(`drawing ${a.kind.drawingId} is on another pair`);
      if (!mockLevelOf(d.body)) throw problem("an alert can follow only a horizontal or a trend line");
    }
    const others = [...alerts.values()].filter((o) => o.id !== a.id);
    if (others.length >= MAX_ALERTS) throw problem(`at most ${MAX_ALERTS} alerts can be kept; delete some fired ones first`);
    const active = others.filter((o) => o.active);
    if (active.length >= MAX_ACTIVE_ALERTS) {
      throw problem(`at most ${MAX_ACTIVE_ALERTS} alerts can be active at once; delete one or wait for one to fire`);
    }
    if (new Set([...active.map((o) => pairKey(o.instrument)), pairKey(a.instrument)]).size > MAX_ALERT_PAIRS) {
      throw problem(
        `at most ${MAX_ALERT_PAIRS} pairs can have active alerts, each needs a live stream; delete the alerts of another pair first`,
      );
    }
    alerts.set(a.id, a);
    armedAt.set(a.id, Date.now());
    keepAlerts();
    return structuredClone(a);
  }

  /** Checks the active alerts of `id` against a live candle, as the engine's stream task does. */
  function evaluateAlerts(id: InstrumentId, c: { time: number; high: number; low: number; close: number }) {
    const key = pairKey(id);
    const armed = [...alerts.values()].filter((a) => a.active && pairKey(a.instrument) === key);
    if (armed.length === 0) return;
    const cur: MockUpdate = { t: Date.now(), openTime: c.time, high: c.high, low: c.low, close: c.close };
    const prev = lastUpdate.get(key);
    lastUpdate.set(key, cur);
    if (!prev) return;
    const fired: Alert[] = [];
    for (const a of armed) {
      if (prev.t < (armedAt.get(a.id) ?? 0)) continue;
      const body = a.kind.kind === "price" ? null : drawings.get(a.kind.drawingId)?.body;
      const level = a.kind.kind === "price" ? { kind: "flat" as const, p: a.kind.price } : body ? mockLevelOf(body) : null;
      const price = level ? mockFires(a.direction, level, prev, cur, true) : null;
      if (price === null) continue;
      const f: Alert = { ...a, active: false, triggeredAt: cur.t, triggeredPrice: price };
      alerts.set(a.id, f);
      fired.push(f);
    }
    if (fired.length === 0) return;
    keepAlerts();
    for (const f of fired) for (const cb of firedListeners) cb(structuredClone(f));
  }
  const problem = (message: string) => ({ code: "other", message });
  const infos = (): IndicatorInfo[] => [
    ...MOCK_BUILTINS.map((b) => ({ meta: b.meta, builtin: true, repaints: false })),
    ...(echoInstalled ? [MOCK_ECHO] : []),
  ];

  function timeline(tf: TimeframeCode) {
    const step = STEP_MS[tf];
    const lastTime = Math.floor(MOCK_END / step) * step;
    // Series index i has time lastTime - (opts.candles - 1 - i) * step.
    const timeOf = (i: number) => lastTime - (opts.candles - 1 - i) * step;
    let first = 0;
    if (opts.historyStartAt !== undefined) {
      while (first < opts.candles && timeOf(first) < opts.historyStartAt) first++;
    }
    return { step, timeOf, first };
  }

  /** Candle number `i` in ticks. */
  function candleAt(i: number, time: number) {
    const open = priceAt(i, base);
    const close = priceAt(i + 1, base);
    return {
      time,
      open,
      high: Math.max(open, close) + Math.round(noise(i, 2) * wick),
      low: Math.min(open, close) - Math.round(noise(i, 3) * wick),
      close,
      volume: Math.round(1_000 + noise(i, 4) * 9_000),
    };
  }

  function appendCandles(out: CandleColumns, timeOf: (i: number) => number, start: number, end: number) {
    for (let i = start; i < end; i++) {
      const c = candleAt(i, timeOf(i));
      out.time.push(c.time);
      out.open.push(c.open);
      out.high.push(c.high);
      out.low.push(c.low);
      out.close.push(c.close);
      out.volume.push(c.volume);
    }
  }

  /** Candles `start..end`, made one at a time as they are read, like the engine's cursor. */
  function* candleRange(timeOf: (i: number) => number, start: number, end: number) {
    for (let i = start; i < end; i++) yield candleAt(i, timeOf(i));
  }

  /** The newest candles (at most BAR_CAP) in price units, like the engine's compute window. */
  function priceBars(symbol: string, tf: TimeframeCode): MockBars {
    const instrument = SYMBOLS.find((i) => i.id.symbol === symbol);
    if (!instrument) throw new Error(`unknown instrument ${symbol}`);
    const { timeOf, first } = timeline(tf);
    const candles = [...candleRange(timeOf, Math.max(first, opts.candles - BAR_CAP), opts.candles)];
    return toPriceBars(candles, opts.priceScale ?? instrument.priceScale);
  }

  function toPriceBars(candles: MockCandle[], scale: number): MockBars {
    const k = 10 ** scale;
    return {
      time: candles.map((c) => c.time),
      open: candles.map((c) => c.open / k),
      high: candles.map((c) => c.high / k),
      low: candles.map((c) => c.low / k),
      close: candles.map((c) => c.close / k),
    };
  }

  /** The open replay's revealed bars of `tf` while it holds `id` back, as `replay_bars` in the engine. */
  function replayBars(id: InstrumentId, tf: TimeframeCode): { scale: number; candles: MockCandle[] } | null {
    const s = session;
    if (!s || caughtUpLive(s) || s.instrument.id.source !== id.source || s.instrument.id.symbol !== id.symbol) return null;
    const bad = mockViewError(s.base, tf);
    if (bad) throw problem(bad);
    reveal(s);
    const shown = s.candles.slice(0, s.current + 1);
    return { scale: s.instrument.priceScale, candles: tf === s.base ? shown : mockAggregate(shown, s.base, tf) };
  }

  function openSession(): MockSession {
    if (!session) throw problem("no replay is open");
    return session;
  }

  /** Makes the candles up to the current one (`all`: every one). */
  function reveal(s: MockSession, all = false): MockCandle[] {
    const n = all ? s.total : s.current + 1;
    while (s.make && s.candles.length < n) s.candles.push(s.make(s.candles.length));
    return s.candles;
  }

  /** The cut: the close time of the last revealed base candle. */
  function cutOf(s: MockSession): number {
    reveal(s);
    return mockCloseTime(s.base, s.candles[s.current]!.time);
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const caughtUp = (what: string) => problem(`the replay has caught up with real time, so its backtest is finished: it takes no ${what}`);
  /** Caught up in this session: the pair's live data is no longer held back. */
  const caughtUpLive = (s: MockSession) => s.live && s.caughtUpAt !== null;
  /** At the newest candle of a live session: the backtest ends at this cut. */
  const catchUp = (s: MockSession) => {
    if (s.live && s.caughtUpAt === null && s.current + 1 >= s.total) s.caughtUpAt = cutOf(s);
  };

  function simulateOrThrow(s: MockSession, commands: ReplayCommand[]) {
    try {
      return mockSimulate(s.base, reveal(s), s.start, cutOf(s), commands);
    } catch (e) {
      throw problem(message(e));
    }
  }

  function replayStateOf(s: MockSession, tf: TimeframeCode, cursor: number, tradesFrom: number): ReplayState {
    const bad = mockViewError(s.base, tf);
    if (bad) throw problem(bad);
    const sim = simulateOrThrow(s, s.commands);
    const { trades, stats } = s.caughtUpAt === null ? sim : mockAtRealTime(sim);
    const closed = trades.length - (trades.at(-1)?.reason === "open" ? 1 : 0);
    const tfrom = Math.min(tradesFrom, closed);
    const cut = cutOf(s);
    const shown = s.candles.slice(0, s.current + 1);
    const all = tf === s.base ? shown : mockAggregate(shown, s.base, tf);
    const first = s.candles.find((c) => mockCloseTime(s.base, c.time) === s.start)!.time;
    const key = tf === s.base ? first : mockBucketStart(tf, first);
    const last = all.at(-1);
    const from = Math.min(cursor, all.length);
    const bars = column();
    for (const c of all.slice(from)) {
      bars.time.push(c.time);
      bars.open.push(c.open);
      bars.high.push(c.high);
      bars.low.push(c.low);
      bars.close.push(c.close);
      bars.volume.push(c.volume);
    }
    return {
      instrument: { ...s.instrument },
      base: s.base,
      tf,
      start: Math.max(0, all.filter((b) => b.time <= key).length - 1),
      current: Math.max(0, all.length - 1),
      cut,
      // A started session that reached its newest candle has caught up.
      atEnd: s.current + 1 >= s.total,
      caughtUp: caughtUpLive(s),
      caughtUpAt: s.caughtUpAt,
      partial: tf !== s.base && last !== undefined && mockCloseTime(tf, last.time) > cut,
      newerError: null,
      from,
      bars,
      tradesFrom: tfrom,
      trades: trades.slice(tfrom),
      stats,
    };
  }

  /** `replay_set_base` from the engine; the lower candles are the current ones split (`mockSplit`). */
  function rebase(s: MockSession, base: TimeframeCode) {
    const old = s.base;
    const src = reveal(s, true);
    const cut = cutOf(s);
    let candles: MockCandle[];
    if (mockBuildsFrom(old, base)) {
      const len = mockCloseTime(base, 0);
      const end = mockCloseTime(old, src.at(-1)!.time);
      const first = s.start - len;
      const need = Math.floor((end - first) / len);
      if (need > MOCK_MAX_REPLAY_CANDLES) {
        const most = Math.floor((MOCK_MAX_REPLAY_CANDLES * len) / DAY_MS);
        const span = Math.ceil((end - first) / DAY_MS);
        throw problem(
          `a replay holds at most ${MOCK_MAX_REPLAY_CANDLES} candles: at ${base} that is ${most} days from its start to ${s.live && s.caughtUpAt === null ? "now" : "its last candle"}, and this one spans ${span} days; replay at a higher step or start later`,
        );
      }
      const context = Math.min(Math.max(0, Math.floor((first - src[0]!.time) / len)), REBASE_CONTEXT, MOCK_MAX_REPLAY_CANDLES - need);
      const from = first - context * len;
      candles = src.flatMap((c) => mockSplit(c, old, base)).filter((c) => c.time >= from && mockCloseTime(base, c.time) <= end);
    } else if (mockBuildsFrom(base, old)) {
      const at = mockBucketStart(base, cut);
      if (at !== cut) throw problem(`the replay is at ${cut}, inside a ${base} candle; step to ${mockCloseTime(base, at)} first, where it closes`);
      candles = mockHigher(src, old, base);
    } else {
      throw problem(`a replay of ${old} candles cannot step ${base} candles: their boundaries do not line up`);
    }
    const closes = candles.map((c) => mockCloseTime(base, c.time));
    const start = closes.find((t) => t >= s.start) ?? s.start;
    const shown = closes.filter((t) => t <= cut).length;
    const newCut = shown > 0 ? closes[shown - 1]! : cut;
    try {
      mockSimulate(base, candles, start, newCut, s.commands);
    } catch (e) {
      throw problem(`the replay cannot step ${base} candles: ${message(e)}`);
    }
    Object.assign(s, { base, candles, total: candles.length, make: null, start, current: shown - 1 });
    // A finished backtest stays finished, at the cut on the new candles.
    if (s.caughtUpAt !== null) s.caughtUpAt = newCut;
    else catchUp(s);
  }

  function computeInstance(inst: IndicatorInstance, bars: MockBars, fromTime: number): IndicatorResult {
    if (opts.indicatorError) return { instance: inst.instance, result: { err: "mock: out of fuel" } };
    const found = infos().find((i) => i.meta.id === inst.moduleId);
    if (!found) return { instance: inst.instance, result: { err: `no indicator ${inst.moduleId}` } };
    const cut = bars.time.findIndex((t) => t >= fromTime);
    const from = cut < 0 ? bars.time.length : cut;
    try {
      const params = resolveParams(found.meta, inst.params);
      const all =
        inst.moduleId === "test.echo"
          ? { echo: Float64Array.from(bars.close) }
          : MOCK_BUILTINS.find((b) => b.meta.id === inst.moduleId)!.compute(params, bars);
      const series = found.meta.series.map((spec) => {
        const v = all[spec.id]!;
        const data: SeriesData = { values: v.length === 0 ? v : v.slice(from) };
        return { id: spec.id, data };
      });
      return {
        instance: inst.instance,
        result: {
          ok: { firstTime: bars.time[from] ?? 0, lastTime: from < bars.time.length ? bars.time.at(-1)! : 0, series, log: "" },
        },
      };
    } catch (e) {
      return { instance: inst.instance, result: { err: e instanceof Error ? e.message : String(e) } };
    }
  }

  return {
    async searchInstruments(q) {
      await delay();
      if (!ready) return [];
      const needle = q.trim().toUpperCase();
      return SYMBOLS.filter((i) => i.id.symbol.includes(needle));
    },

    async getCandles(id, tf, before) {
      await delayFor(id.symbol);
      const instrument = SYMBOLS.find((i) => i.id.symbol === id.symbol);
      if (!instrument) throw new Error(`unknown instrument ${id.source}/${id.symbol}`);
      const { step, timeOf, first } = timeline(tf);
      // Exclusive end index: candles strictly before `before`.
      let end = opts.candles;
      if (before !== undefined) {
        end = Math.min(end, Math.max(0, Math.ceil((before - timeOf(0)) / step)));
      }
      const start = Math.max(first, end - PAGE);

      const out = column();
      appendCandles(out, timeOf, start, end);
      const page: Candles = {
        instrument: { ...instrument, priceScale: opts.priceScale ?? instrument.priceScale },
        ...out,
        atHistoryStart: start <= first,
        warning: opts.warning ?? null,
      };
      return page;
    },

    async subscribeLive(id, _tf, onEvent) {
      await delayFor(id.symbol);
      live.set(onEvent, id);
      return () => {
        live.delete(onEvent);
      };
    },

    emitLive(e) {
      const evaluated = new Set<string>();
      for (const [cb, sub] of [...live]) {
        // Held back while replayed, until the replay has caught up.
        const paused = session !== null && !caughtUpLive(session) && session.instrument.id.source === sub.source && session.instrument.id.symbol === sub.symbol;
        if (paused) continue;
        if (e.kind === "candle" && !evaluated.has(pairKey(sub))) {
          evaluated.add(pairKey(sub));
          evaluateAlerts(sub, e);
        }
        cb(e);
      }
    },

    replayFile: () => savedReplay,

    async replayStart(id, base, startTime) {
      await delayFor(id.symbol);
      const instrument = SYMBOLS.find((i) => i.id.source === id.source && i.id.symbol === id.symbol);
      if (!instrument) throw problem(`unknown instrument ${id.source}/${id.symbol}`);
      const { step, timeOf, first } = timeline(base);
      const i = (startTime - timeOf(0)) / step;
      if (!Number.isInteger(i) || i < first || i >= opts.candles) throw problem(`no cached ${base} bar opens at ${startTime}`);
      const ctx = Math.max(first, i - REPLAY_CONTEXT);
      const make = (k: number) => candleAt(ctx + k, timeOf(ctx + k));
      const s: MockSession = {
        instrument: { ...instrument, priceScale: opts.priceScale ?? instrument.priceScale },
        base,
        candles: [],
        total: Math.min(opts.candles - ctx, MOCK_MAX_REPLAY_CANDLES),
        make,
        start: mockCloseTime(base, startTime),
        current: i - ctx,
        commands: [],
        live: true,
        caughtUpAt: null,
      };
      catchUp(s);
      session = s;
      return replayStateOf(s, base, 0, 0);
    },

    async replayStep(n) {
      await delay();
      const s = openSession();
      if (s.caughtUpAt !== null) throw caughtUp("steps");
      s.current = Math.min(s.current + n, s.total - 1);
      catchUp(s);
      return cutOf(s);
    },

    async replaySetBase(base) {
      await delay();
      const s = openSession();
      if (base !== s.base) rebase(s, base);
      return replayStateOf(s, base, 0, 0);
    },

    async replayCommand(command) {
      await delay();
      const s = openSession();
      if (s.caughtUpAt !== null) throw caughtUp("commands");
      const cut = cutOf(s);
      if (command.time !== cut) throw problem(`a command is given at the cut ${cut}, not at ${command.time}`);
      const next = [...s.commands, structuredClone(command)];
      simulateOrThrow(s, next);
      s.commands = next;
    },

    async replayState(tf, cursor, tradesFrom) {
      await delay();
      return replayStateOf(openSession(), tf, cursor, tradesFrom);
    },

    async replaySave() {
      await delay();
      const s = openSession();
      savedReplay = await mockWriteReplay({
        instrument: s.instrument,
        base: s.base,
        candles: reveal(s).slice(0, s.current + 1),
        start: s.start,
        cut: cutOf(s),
        commands: s.commands,
        caughtUpAt: s.caughtUpAt,
      });
      return `${s.instrument.id.symbol}-${s.base}.replay`;
    },

    async replayOpen(bytes) {
      await delay();
      let f;
      try {
        f = await mockReadReplay(bytes);
      } catch (e) {
        throw problem(e instanceof Error ? e.message : String(e));
      }
      // The file simulated, so its cut is the close time of one of its candles.
      const s: MockSession = {
        instrument: f.instrument,
        base: f.base,
        candles: f.candles,
        total: f.candles.length,
        make: null,
        start: f.start,
        current: mockRevealed(f.base, f.candles, f.cut).length - 1,
        commands: f.commands,
        live: false,
        caughtUpAt: f.caughtUpAt,
      };
      session = s;
      return replayStateOf(s, f.base, 0, 0);
    },

    async replayExit() {
      await delay();
      session = null;
    },

    async getWatchlist() {
      await delay();
      return [...watchlist];
    },

    async setWatchlist(ids) {
      await delay();
      watchlist = [...ids];
      opts.watchlistStore?.save(watchlist);
    },

    async getWatchlistQuotes() {
      await delay();
      // Per instrument, so the numbers follow a row when the list is reordered.
      return watchlist.map((id) => {
        const i = SYMBOLS.findIndex((s) => s.id.symbol === id.symbol);
        return { id, last: priceAt(opts.candles, base) + 37 * i, changeBp: [184, -116, 412, 0, -27][i % 5]! };
      });
    },

    async getConnection() {
      return opts.connection ?? "connected";
    },

    async onConnection() {
      return () => {};
    },

    async instrumentsReady() {
      return ready;
    },

    async onInstrumentsSynced(cb) {
      synced.add(cb);
      return () => {
        synced.delete(cb);
      };
    },

    async listIndicators() {
      await delay();
      if (loadFailures > 0) {
        loadFailures--;
        throw { code: "other", message: "mock: engine starting" };
      }
      return {
        indicators: infos(),
        failed: brokenInstalled ? [{ id: "test.broken", builtin: false, error: "mock: not an indicator component" }] : [],
        error: opts.indicatorProblems ? "mock: cannot read the installed indicators" : null,
      };
    },

    async inspectIndicator() {
      await delay();
      return { meta: MOCK_ECHO.meta, replaces: echoInstalled ? MOCK_ECHO.meta.version : null };
    },

    async installIndicator() {
      await delay();
      echoInstalled = true;
      return MOCK_ECHO;
    },

    async removeIndicator(id) {
      await delay();
      if (id === "test.broken" && brokenInstalled) {
        brokenInstalled = false;
        return;
      }
      if (id !== MOCK_ECHO.meta.id || !echoInstalled) {
        throw new Error(`${id} is not an installed indicator; built-in indicators cannot be removed`);
      }
      echoInstalled = false;
      chartIndicators = chartIndicators.filter((i) => i.moduleId !== id);
    },

    async getChartIndicators() {
      await delay();
      return chartIndicators.map((i) => ({ ...i }));
    },

    async setChartIndicators(items) {
      await delay();
      if (opts.indicatorSaveError) throw { code: "other", message: "mock: cannot save" };
      chartIndicators = items.map((i) => ({ ...i }));
    },

    async checkUpdate() {
      await delay();
      if (opts.updateError === "check") throw { code: "other", message: "mock: could not reach the update server" };
      updateChecked = opts.update !== undefined;
      return opts.update ? { ...opts.update } : null;
    },

    // A 4 MB download in ten steps over 2 s; resolving stands for the restart (macOS, Linux).
    async installUpdate(onProgress) {
      await delay();
      // As in Rust: an attempt takes the checked update, so the next one needs a new check.
      if (!updateChecked) throw { code: "other", message: "check for updates first" };
      updateChecked = false;
      const total = 4_000_000;
      onProgress({ kind: "started", total });
      for (let i = 1; i <= 10; i++) {
        await sleep(200);
        if (opts.updateError === "install" && i === 6) throw { code: "other", message: "mock: connection reset" };
        onProgress({ kind: "chunk", downloaded: (total / 10) * i });
      }
      onProgress({ kind: "installing" });
      await sleep(300);
    },

    async getDrawings(id) {
      await delay();
      const instrument = SYMBOLS.find((i) => i.id.source === id.source && i.id.symbol === id.symbol);
      const scale = opts.priceScale ?? instrument?.priceScale ?? 2;
      return [...drawings.values()]
        .filter((d) => d.instrument.source === id.source && d.instrument.symbol === id.symbol)
        .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .flatMap((d) => {
          // A drawing that does not fit the current scale is left out and stays stored, as in Rust.
          const r = mockAtScale(structuredClone(d), scale);
          return typeof r === "string" ? [] : [r];
        });
    },

    async saveDrawing(d) {
      await delay();
      return storeDrawings([d])[0]!;
    },

    async deleteDrawing(id) {
      await delay();
      removeDrawings([id]);
    },

    async saveDrawings(list) {
      await delay();
      return storeDrawings(list);
    },

    async deleteDrawings(ids) {
      await delay();
      removeDrawings(ids);
    },

    async getAlerts() {
      await delay();
      return [...alerts.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((a) => structuredClone(a));
    },

    async setAlert(input) {
      await delay();
      const { id, instrument, priceScale, kind, direction } = input;
      return arm({ id, instrument, priceScale, kind, direction, active: true, createdAt: Date.now(), triggeredAt: null, triggeredPrice: null });
    },

    async rearmAlert(id) {
      await delay();
      const a = alerts.get(id);
      if (!a) throw problem(`no alert "${id}"`);
      return arm({ ...a, active: true, triggeredAt: null, triggeredPrice: null });
    },

    async deleteAlert(id) {
      await delay();
      if (alerts.delete(id)) {
        armedAt.delete(id);
        keepAlerts();
      }
    },

    async onAlertFired(cb) {
      firedListeners.add(cb);
      return () => {
        firedListeners.delete(cb);
      };
    },

    async onAlertsChanged(cb) {
      changedListeners.add(cb);
      return () => {
        changedListeners.delete(cb);
      };
    },

    async setLanguage() {},

    async getPositionOutcomes(id, tf, positions) {
      await delayFor(id.symbol);
      for (const p of positions) {
        const bad = mockValidatePosition(p.position);
        if (bad) throw problem(`position ${p.id}: ${bad}`);
      }
      const replayed = replayBars(id, tf);
      if (replayed) {
        // Only the revealed bars count in a replay.
        return positions.map(({ id: drawingId, position }) => ({
          id: drawingId,
          outcome: mockResolve(position, replayed.candles.filter((c) => c.time > position.entry.t)),
        }));
      }
      const { step, timeOf, first } = timeline(tf);
      return positions.map(({ id: drawingId, position }) => {
        // Bars with entry.t < time <= endT within the generated series, read up to the one that decides.
        const start = Math.max(first, Math.floor((position.entry.t - timeOf(0)) / step) + 1);
        const end = Math.min(opts.candles, Math.floor((position.endT - timeOf(0)) / step) + 1);
        return { id: drawingId, outcome: mockResolve(position, candleRange(timeOf, start, end)) };
      });
    },

    async computeIndicators(id, tf, fromTime) {
      await delayFor(id.symbol);
      // As in the engine, a chart the replay cannot show is refused before anything else.
      const replayed = replayBars(id, tf);
      const visible = chartIndicators.filter((i) => !i.hidden);
      if (visible.length === 0) return [];
      const bars = replayed ? toPriceBars(replayed.candles.slice(-BAR_CAP), replayed.scale) : priceBars(id.symbol, tf);
      return visible.map((i) => computeInstance(i, bars, fromTime));
    },
  };
}
