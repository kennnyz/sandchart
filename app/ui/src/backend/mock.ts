import {
  type Backend,
  type CandleColumns,
  type Candles,
  type ConnectionState,
  type Instrument,
  type InstrumentId,
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
  warning?: string;
  /** What `getConnection` reports (default "connected"). */
  connection?: ConnectionState;
  /** Initial watchlist symbols (default: the first five instruments). */
  watchlist?: string[];
  /** Keeps the watchlist across page loads (the browser mock uses localStorage). */
  watchlistStore?: { load(): InstrumentId[] | null; save(ids: InstrumentId[]): void };
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

export function createMockBackend(opts: MockOptions): Backend {
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

  return {
    async searchInstruments(q) {
      await delay();
      const needle = q.trim().toUpperCase();
      return SYMBOLS.filter((i) => i.id.symbol.includes(needle));
    },

    async getCandles(id, tf, before) {
      await delayFor(id.symbol);
      const instrument = SYMBOLS.find((i) => i.id.symbol === id.symbol);
      if (!instrument) throw new Error(`unknown instrument ${id.source}/${id.symbol}`);
      const step = STEP_MS[tf];
      const lastTime = Math.floor(MOCK_END / step) * step;
      // Series index i has time lastTime - (opts.candles - 1 - i) * step.
      const timeOf = (i: number) => lastTime - (opts.candles - 1 - i) * step;
      let first = 0;
      if (opts.historyStartAt !== undefined) {
        while (first < opts.candles && timeOf(first) < opts.historyStartAt) first++;
      }
      // Exclusive end index: candles strictly before `before`.
      let end = opts.candles;
      if (before !== undefined) {
        end = Math.min(end, Math.max(0, Math.ceil((before - timeOf(0)) / step)));
      }
      const start = Math.max(first, end - PAGE);

      const out = column();
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
      const page: Candles = {
        instrument: { ...instrument, priceScale: opts.priceScale ?? instrument.priceScale },
        ...out,
        atHistoryStart: start <= first,
        warning: opts.warning ?? null,
      };
      return page;
    },

    async subscribeLive(id) {
      await delayFor(id.symbol);
      return () => {};
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
  };
}
