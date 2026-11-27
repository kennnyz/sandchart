import { createMockBackend } from "./mock";
import { tauriBackend } from "./tauri";
import type { Backend } from "./types";

export * from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The Tauri backend inside the app, a mock in a plain browser (`pnpm dev`). */
export const backend: Backend = inTauri
  ? tauriBackend
  : createMockBackend({ candles: 200_000, latencyMs: 80 });
