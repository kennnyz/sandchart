import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Backend, ConnectionState, LiveEvent } from "./types";

let reset: Promise<void> | null = null;

/**
 * Drops live streams a previous page load left behind. Runs once; every later call
 * returns the same promise, and `subscribeLive` waits for it so a new stream is never
 * dropped by a late reset.
 */
export function resetSubscriptions(): Promise<void> {
  reset ??= invoke<void>("unsubscribe_all").catch((e: unknown) => console.error("unsubscribe_all failed", e));
  return reset;
}

// Command arguments are camelCase here; Tauri maps them to the snake_case Rust names.
export const tauriBackend: Backend = {
  searchInstruments: (query) => invoke("search_instruments", { query }),
  getCandles: (id, tf, before) =>
    invoke("get_candles", {
      source: id.source,
      symbol: id.symbol,
      tf,
      before: before ?? null,
    }),
  async subscribeLive(id, tf, onEvent) {
    await resetSubscriptions();
    // The channel exists before the call, so no event can arrive before it is listening.
    const channel = new Channel<LiveEvent>();
    channel.onmessage = onEvent;
    const subscription = await invoke<number>("subscribe_live", {
      source: id.source,
      symbol: id.symbol,
      tf,
      onEvent: channel,
    });
    return () => {
      channel.onmessage = () => {};
      void invoke("unsubscribe_live", { id: subscription });
    };
  },
  getWatchlist: () => invoke("get_watchlist"),
  setWatchlist: (ids) => invoke("set_watchlist", { ids }),
  getWatchlistQuotes: () => invoke("get_watchlist_quotes"),
  getConnection: () => invoke("get_connection"),
  onConnection: (cb) =>
    listen<ConnectionState>("connection", (e) => cb(e.payload)),
  instrumentsReady: () => invoke("get_instruments_ready"),
  onInstrumentsSynced: (cb) => listen("instruments-synced", () => cb()),
};
