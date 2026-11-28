import { enableChartDebug } from "../chart/debug";
import { createMockBackend } from "./mock";
import { resetSubscriptions, tauriBackend } from "./tauri";
import type { Alert, Backend, ConnectionState, Drawing, InstrumentId, LiveEvent, Problem, ProblemCode, UpdateInfo } from "./types";

const MOCK_WATCHLIST_KEY = "sandchart.mock.watchlist";
const MOCK_DRAWINGS_KEY = "sandchart.mock.drawings";
const MOCK_ALERTS_KEY = "sandchart.mock.alerts";

/** A value kept in localStorage as JSON; without storage it lasts for this page load. */
function localStore<T>(key: string): { load(): T | null; save(v: T): void } {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    },
    save(v) {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // No storage: the value lasts for this page load.
      }
    },
  };
}

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
 * fails), `mockDrawingSaveError=1` (saving or deleting a drawing fails), `mockIndicatorLoadFailures` (that many indicator list calls fail first) and
 * `mockIndicatorProblems=1` (a module that failed to load and a service error), `mockUpdate` (the version
 * `checkUpdate` finds; `0.3.0` when only the next two are set), `mockUpdateError=check|install` (every check
 * fails, or every download fails halfway), `mockUpdateBlocker=translocated|not_appimage` (the update cannot be
 * installed here) and `mockUpdateDelay` (ms until the first automatic check). The watchlist, the drawings and the alerts
 * are kept in localStorage (`sandchart.mock.drawings`, `sandchart.mock.alerts`), so a reload sees the same ones. Calls
 * are counted in `window.__sandchartMock` (whose `replayFile()` returns the text of the last replay save and
 * `emitLive(event)` pushes a live event into the open subscriptions, which also feeds the alerts), and the chart
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
  const updateError = q.get("mockUpdateError");
  const blocker = q.get("mockUpdateBlocker");
  const update: UpdateInfo | undefined =
    q.has("mockUpdate") || updateError === "install" || blocker !== null
      ? {
          version: q.get("mockUpdate") || "0.3.0",
          notes: "Faster chart redraws.\nIndicator settings keep their colours.\nFixes the watchlist order after a restart.",
          date: "2026-11-28T10:00:00Z",
          blocker: blocker === "translocated" || blocker === "not_appimage" ? blocker : null,
        }
      : undefined;
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
    drawingSaveError: q.get("mockDrawingSaveError") === "1",
    indicatorLoadFailures: num("mockIndicatorLoadFailures"),
    indicatorProblems: q.get("mockIndicatorProblems") === "1",
    update,
    updateError: updateError === "check" || updateError === "install" ? updateError : undefined,
    watchlist: list === null ? undefined : list.split(",").filter(Boolean),
    watchlistStore: localStore<InstrumentId[]>(MOCK_WATCHLIST_KEY),
    drawingStore: localStore<Drawing[]>(MOCK_DRAWINGS_KEY),
    alertStore: localStore<Alert[]>(MOCK_ALERTS_KEY),
  });
  enableChartDebug();
  const stats = {
    getCandles: 0,
    checkUpdate: 0,
    replayFile: () => mock.replayFile(),
    emitLive: (e: LiveEvent) => mock.emitLive(e),
  };
  (window as unknown as { __sandchartMock: typeof stats }).__sandchartMock = stats;
  return {
    ...mock,
    getCandles(...args) {
      stats.getCandles++;
      return mock.getCandles(...args);
    },
    checkUpdate() {
      stats.checkUpdate++;
      return mock.checkUpdate();
    },
  };
}

/** When the first automatic update check runs; the mock's `mockUpdateDelay`, else the default. */
export const firstUpdateCheckMs: number | undefined = inTauri
  ? undefined
  : (() => {
      const v = new URLSearchParams(window.location.search).get("mockUpdateDelay");
      return v === null ? undefined : Number(v);
    })();

/** The Tauri backend inside the app, a mock in a plain browser. */
export const backend: Backend = inTauri ? tauriBackend : browserMock();
