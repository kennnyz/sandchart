import { createMockBackend } from "./mock";
import { resetSubscriptions, tauriBackend } from "./tauri";
import type { Backend } from "./types";

export * from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

if (inTauri) void resetSubscriptions();

/** The Tauri backend inside the app, a mock in a plain browser (`pnpm dev`). */
export const backend: Backend = inTauri
  ? tauriBackend
  : createMockBackend({ candles: 200_000, latencyMs: 80 });
