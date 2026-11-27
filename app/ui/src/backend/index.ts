import { createMockBackend } from "./mock";
import { resetSubscriptions, tauriBackend } from "./tauri";
import type { Backend } from "./types";

export * from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

if (inTauri) void resetSubscriptions();

/**
 * The mock used in a plain browser (`pnpm dev`, e2e). Query parameters tune it for
 * tests: `mockHistoryStart` (ms) and `mockLatency` (ms). Calls are counted in
 * `window.__sandchartMock`. None of this exists inside Tauri.
 */
function browserMock(): Backend {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
  const mock = createMockBackend({
    candles: 200_000,
    latencyMs: num("mockLatency") ?? 80,
    historyStartAt: num("mockHistoryStart"),
  });
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
