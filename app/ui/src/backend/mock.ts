import {
  type Backend,
  type CandleColumns,
  type Candles,
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
}

/** Deterministic pseudo-random value in [0, 1) for candle number `n`. */
function noise(n: number, salt: number): number {
  const x = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function priceAt(n: number): number {
  // Slow wave plus noise, in ticks (2 decimals): roughly 100.00 +- 20.00.
  return Math.round(10_000 + 2_000 * Math.sin(n / 200) + 300 * (noise(n, 1) - 0.5));
}

function column(): CandleColumns {
  return { time: [], open: [], high: [], low: [], close: [], volume: [] };
}

export function createMockBackend(opts: MockOptions): Backend {
  const delay = () =>
    opts.latencyMs ? new Promise<void>((r) => setTimeout(r, opts.latencyMs)) : Promise.resolve();
  let watchlist: InstrumentId[] = SYMBOLS.slice(0, 2).map((i) => i.id);

  return {
    async searchInstruments(q) {
      await delay();
      const needle = q.trim().toUpperCase();
      return SYMBOLS.filter((i) => i.id.symbol.includes(needle));
    },

    async getCandles(id, tf, before) {
      await delay();
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
        const open = priceAt(i);
        const close = priceAt(i + 1);
        out.time.push(timeOf(i));
        out.open.push(open);
        out.close.push(close);
        out.high.push(Math.max(open, close) + Math.round(noise(i, 2) * 40));
        out.low.push(Math.min(open, close) - Math.round(noise(i, 3) * 40));
        out.volume.push(Math.round(1_000 + noise(i, 4) * 9_000));
      }
      const page: Candles = {
        instrument,
        ...out,
        atHistoryStart: start <= first,
        warning: null,
      };
      return page;
    },

    async subscribeLive() {
      await delay();
      return () => {};
    },

    async getWatchlist() {
      await delay();
      return [...watchlist];
    },

    async setWatchlist(ids) {
      await delay();
      watchlist = [...ids];
    },

    async getWatchlistQuotes() {
      await delay();
      return watchlist.map((id, i) => ({ id, last: priceAt(opts.candles) + i, changeBp: 184 - 300 * i }));
    },

    async onConnection() {
      return () => {};
    },
  };
}
