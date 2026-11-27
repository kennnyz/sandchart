import { enableChartDebug } from "../chart/debug";
import { createMockBackend } from "./mock";
import { resetSubscriptions, tauriBackend } from "./tauri";
import type { Backend, ConnectionState, InstrumentId, Problem, ProblemCode } from "./types";

const MOCK_WATCHLIST_KEY = "sandchart.mock.watchlist";

export * from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

if (inTauri) void resetSubscriptions();

/**
 * The mock used in a plain browser (`pnpm dev`, e2e). Query parameters tune it for
 * tests: `mockHistoryStart` (ms), `mockLatency` (ms), `mockPrice` (ticks),
 * `mockPriceScale`, `mockSlow` + `mockSlowLatency` (one slow symbol), `mockWarning`
 * (every page carries a provider warning; the value is its code, `network` when not
 * one, with `mockRetryAfter` seconds), `mockConnection` (initial state), `mockSyncDelay`
 * (ms until the instrument list exists, as on a first run) and `mockWatchlist`
 * (comma-separated symbols; empty for none), `mockIndicators` (comma-separated built-ins,
 * e.g. `sma,bollinger,rsi,macd`, put on the chart at start) and `mockIndicatorError=1`
 * (every indicator compute fails), `mockIndicatorSaveError=1` (saving the chart indicators
 * fails) and `mockIndicatorLoadFailures` (that many indicator list calls fail first). The watchlist is kept in
 * localStorage so a reload sees the same list. Calls are counted in `window.__sandchartMock`, and the chart
 * reports draw times and axis layout into `window.__sandchartDebug` (see
 * chart/debug.ts). None of this exists inside Tauri.
 */
function browserMock(): Backend {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
  const slow = q.get("mockSlow");
  const connection = q.get("mockConnection");
  const list = q.get("mockWatchlist");
  const warningCode = q.get("mockWarning") as ProblemCode | null;
  const warning: Problem | undefined =
    warningCode === null
      ? undefined
      : {
          code: ["rate_limited", "blocked", "unsafe_ticks", "other"].includes(warningCode) ? warningCode : "network",
          message: "mock: provider unreachable",
          retryAfterS: num("mockRetryAfter"),
        };
  const mock = createMockBackend({
    candles: 200_000,
    latencyMs: num("mockLatency") ?? 80,
    historyStartAt: num("mockHistoryStart"),
    basePrice: num("mockPrice"),
    priceScale: num("mockPriceScale"),
    slow: slow ? { symbol: slow, latencyMs: num("mockSlowLatency") ?? 1_000 } : undefined,
    warning,
    connection: ["connecting", "reconnecting", "offline"].includes(connection ?? "")
      ? (connection as ConnectionState)
      : undefined,
    instrumentsAfterMs: num("mockSyncDelay"),
    indicators: (q.get("mockIndicators") ?? "").split(",").filter(Boolean),
    indicatorError: q.get("mockIndicatorError") === "1",
    indicatorSaveError: q.get("mockIndicatorSaveError") === "1",
    indicatorLoadFailures: num("mockIndicatorLoadFailures"),
    watchlist: list === null ? undefined : list.split(",").filter(Boolean),
    watchlistStore: {
      load() {
        try {
          const raw = localStorage.getItem(MOCK_WATCHLIST_KEY);
          return raw ? (JSON.parse(raw) as InstrumentId[]) : null;
        } catch {
          return null;
        }
      },
      save(ids) {
        try {
          localStorage.setItem(MOCK_WATCHLIST_KEY, JSON.stringify(ids));
        } catch {
          // No storage: the list lasts for this page load.
        }
      },
    },
  });
  enableChartDebug();
  const stats = { getCandles: 0 };
  (window as unknown as { __sandchartMock: typeof stats }).__sandchartMock = stats;
  return {
    ...mock,
    getCandles(...args) {
      stats.getCandles++;
      return mock.getCandles(...args);
    },
  };
}

/** The Tauri backend inside the app, a mock in a plain browser. */
export const backend: Backend = inTauri ? tauriBackend : browserMock();
