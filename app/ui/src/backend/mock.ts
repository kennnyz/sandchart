import {
  type Backend,
  type CandleColumns,
  type Candles,
  type ConnectionState,
  type Instrument,
  type IndicatorInfo,
  type IndicatorInstance,
  type IndicatorMeta,
  type IndicatorResult,
  type InstrumentId,
  type LiveEvent,
  type ParamValue,
  type SeriesData,
  type SeriesSpec,
  type Problem,
  type TimeframeCode,
} from "./types";

const PAGE = 1000;
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
  /** Keeps the watchlist across page loads (the browser mock uses localStorage). */
  watchlistStore?: { load(): InstrumentId[] | null; save(ids: InstrumentId[]): void };
}

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
  emitLive(e: LiveEvent): void;
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
  const live = new Set<(e: LiveEvent) => void>();
  const synced = new Set<() => void>();
  let ready = !opts.instrumentsAfterMs;
  if (!ready) {
    setTimeout(() => {
      ready = true;
      for (const cb of synced) cb();
    }, opts.instrumentsAfterMs);
  }

  let echoInstalled = false;
  let chartIndicators: IndicatorInstance[] = (opts.indicators ?? []).map((name) => ({
    instance: `mock-${name}`,
    moduleId: `builtin.${name}`,
    params: [],
    colors: {},
    hidden: false,
  }));
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

  function appendCandles(out: CandleColumns, timeOf: (i: number) => number, start: number, end: number) {
    for (let i = start; i < end; i++) {
      const open = priceAt(i, base);
      const close = priceAt(i + 1, base);
      out.time.push(timeOf(i));
      out.open.push(open);
      out.close.push(close);
      out.high.push(Math.max(open, close) + Math.round(noise(i, 2) * wick));
      out.low.push(Math.min(open, close) - Math.round(noise(i, 3) * wick));
      out.volume.push(Math.round(1_000 + noise(i, 4) * 9_000));
    }
  }

  /** The newest candles (at most BAR_CAP) in price units, like the engine's compute window. */
  function priceBars(symbol: string, tf: TimeframeCode): MockBars {
    const instrument = SYMBOLS.find((i) => i.id.symbol === symbol);
    if (!instrument) throw new Error(`unknown instrument ${symbol}`);
    const { timeOf, first } = timeline(tf);
    const raw = column();
    appendCandles(raw, timeOf, Math.max(first, opts.candles - BAR_CAP), opts.candles);
    const k = 10 ** (opts.priceScale ?? instrument.priceScale);
    const px = (a: number[]) => a.map((v) => v / k);
    return { time: raw.time, open: px(raw.open), high: px(raw.high), low: px(raw.low), close: px(raw.close) };
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
      live.add(onEvent);
      return () => {
        live.delete(onEvent);
      };
    },

    emitLive(e) {
      for (const cb of live) cb(e);
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
      return infos();
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
      chartIndicators = items.map((i) => ({ ...i }));
    },

    async computeIndicators(id, tf, fromTime) {
      await delayFor(id.symbol);
      const visible = chartIndicators.filter((i) => !i.hidden);
      if (visible.length === 0) return [];
      const bars = priceBars(id.symbol, tf);
      return visible.map((i) => computeInstance(i, bars, fromTime));
    },
  };
}
