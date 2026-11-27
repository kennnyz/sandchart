import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Backend, ConnectionState, LiveEvent } from "./types";

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
    const subscription = await invoke<number>("subscribe_live", {
      source: id.source,
      symbol: id.symbol,
      tf,
    });
    const unlisten = await listen<LiveEvent>(`live:${subscription}`, (e) => onEvent(e.payload));
    return () => {
      unlisten();
      void invoke("unsubscribe_live", { id: subscription });
    };
  },
  getWatchlist: () => invoke("get_watchlist"),
  setWatchlist: (ids) => invoke("set_watchlist", { ids }),
  getWatchlistQuotes: () => invoke("get_watchlist_quotes"),
  getConnection: () => invoke("get_connection"),
  onConnection: (cb) =>
    listen<ConnectionState>("connection", (e) => cb(e.payload)),
};
