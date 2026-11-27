import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Backend,
  ComputedIndicator,
  ConnectionState,
  IndicatorResult,
  LiveEvent,
  Marker,
  UpdateProgress,
} from "./types";

/** `compute_indicators` as Rust sends it: JSON has no NaN, so a gap is `null`. */
interface WireResult {
  instance: string;
  result:
    | {
        ok: Omit<ComputedIndicator, "series"> & {
          series: { id: string; data: { values: (number | null)[] } | { markers: Marker[] } }[];
        };
      }
    | { err: string };
}

/** `null` becomes NaN, never 0, so a gap stays a gap. */
function fromWire(r: WireResult): IndicatorResult {
  if ("err" in r.result) return { instance: r.instance, result: r.result };
  const { series, ...rest } = r.result.ok;
  return {
    instance: r.instance,
    result: {
      ok: {
        ...rest,
        series: series.map((s) => ({
          id: s.id,
          data: "values" in s.data
            ? { values: Float64Array.from(s.data.values, (v) => v ?? NaN) }
            : s.data,
        })),
      },
    },
  };
}

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
  listIndicators: () => invoke("list_indicators"),
  // Tauri 2 deserializes a Rust `Vec<u8>` from a JSON array, not from a typed array.
  inspectIndicator: (bytes) => invoke("inspect_indicator", { bytes: Array.from(bytes) }),
  installIndicator: (bytes) => invoke("install_indicator", { bytes: Array.from(bytes) }),
  removeIndicator: (id) => invoke("remove_indicator", { id }),
  getChartIndicators: () => invoke("get_chart_indicators"),
  setChartIndicators: (items) => invoke("set_chart_indicators", { items }),
  async computeIndicators(id, tf, fromTime) {
    const wire = await invoke<WireResult[]>("compute_indicators", {
      source: id.source,
      symbol: id.symbol,
      tf,
      fromTime,
    });
    return wire.map(fromWire);
  },
  checkUpdate: () => invoke("check_update"),
  async installUpdate(onProgress) {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    await invoke<void>("install_update", { onProgress: channel });
  },
};
