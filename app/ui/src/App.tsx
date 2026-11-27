import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { backend } from "./backend";
import type { ConnectionState, Instrument, InstrumentId, TimeframeCode } from "./backend/types";
import { dark, light } from "./chart/theme";
import { ChartView, Loading } from "./components/ChartView";
import { StatusBar } from "./components/StatusBar";
import { tfLabel } from "./components/TimeframePicker";
import { SymbolSearch, type SearchMode } from "./components/SymbolSearch";
import { TopBar } from "./components/TopBar";
import { Watchlist } from "./components/Watchlist";
import { useLanguage } from "./i18n";
import { sourceName } from "./labels";

type ThemeName = "dark" | "light";
const THEME_KEY = "sandchart.theme";
/** Opened when the watchlist is empty at startup. */
const DEFAULT_SYMBOL = "BTCUSDT";

function storedTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const WATCHLIST_VISIBLE_KEY = "sandchart.watchlist.visible";

/** The watchlist panel is shown unless the user hid it. */
function storedWatchlistVisible(): boolean {
  try {
    return localStorage.getItem(WATCHLIST_VISIBLE_KEY) !== "0";
  } catch {
    return true;
  }
}

const sameId = (a: InstrumentId, b: InstrumentId) => a.source === b.source && a.symbol === b.symbol;

export function App() {
  useLanguage(); // re-render everything when the language changes
  const [themeName, setThemeName] = useState<ThemeName>(storedTheme);
  const [current, setCurrent] = useState<InstrumentId | null>(null);
  const [tf, setTf] = useState<TimeframeCode>("1h");
  const [logScale, setLogScale] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [watchlist, setWatchlistState] = useState<InstrumentId[]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  /** The open search dialog and what ↵ does in it; null when closed. */
  const [searchMode, setSearchMode] = useState<SearchMode | null>(null);
  const [watchlistVisible, setWatchlistVisible] = useState(storedWatchlistVisible);
  /** Waiting for the instrument list to open the default pair (first run). */
  const [waitingDefault, setWaitingDefault] = useState(true);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeName;
  }, [themeName]);

  const showWatchlist = (visible: boolean) => {
    setWatchlistVisible(visible);
    try {
      localStorage.setItem(WATCHLIST_VISIBLE_KEY, visible ? "1" : "0");
    } catch {
      // No storage: the choice lasts for this session only.
    }
  };

  const changeTheme = (name: ThemeName) => {
    setThemeName(name);
    try {
      localStorage.setItem(THEME_KEY, name);
    } catch {
      // No storage: the choice lasts for this session only.
    }
  };

  // Connection: the current state first, then every change.
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | null = null;
    void backend.getConnection().then((s) => alive && setConnection(s));
    void backend
      .onConnection((s) => alive && setConnection(s))
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      });
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  // Startup: the watchlist, and its first pair on the chart. With an empty watchlist the
  // default pair opens; on a first run the instrument list is still empty, so the pick is
  // retried when the background sync reports it is done.
  useEffect(() => {
    let alive = true;
    let stop: (() => void) | null = null;
    const pickDefault = async () => {
      const found = (await backend.searchInstruments(DEFAULT_SYMBOL)).find((i) => i.id.symbol === DEFAULT_SYMBOL);
      if (!alive) return false;
      if (found) setCurrent((c) => c ?? found.id);
      return found !== undefined;
    };
    void (async () => {
      const ids = await backend.getWatchlist();
      if (!alive) return;
      setWatchlistState(ids);
      if (ids[0]) {
        setCurrent((c) => c ?? ids[0]!);
        return;
      }
      // Listen first, then look: a sync that ends in between is still seen.
      const unlisten = await backend.onInstrumentsSynced(() => {
        pickDefault()
          .then(() => alive && setWaitingDefault(false))
          .catch((e: unknown) => {
            console.error("loading the watchlist failed", e);
            if (alive) setWaitingDefault(false);
          });
      });
      if (!alive) return unlisten();
      stop = unlisten;
      // Nothing more to wait for once the list is synced, found or not.
      if ((await pickDefault()) || (await backend.instrumentsReady())) setWaitingDefault(false);
    })()
      .catch((e: unknown) => {
        console.error("loading the watchlist failed", e);
        if (alive) setWaitingDefault(false);
      });
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  const saveWatchlist = useCallback((ids: InstrumentId[]) => {
    setWatchlistState(ids);
    backend
      .setWatchlist(ids)
      .then(() => setSavedVersion((v) => v + 1))
      .catch((e: unknown) => console.error("saving the watchlist failed", e));
  }, []);

  const addToWatchlist = (i: Instrument) => {
    if (!watchlist.some((id) => sameId(id, i.id))) saveWatchlist([...watchlist, i.id]);
  };

  // ⌘K / Ctrl+K opens the search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchMode("open");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const theme = themeName === "dark" ? dark : light;
  return (
    <div className="app">
      <TopBar
        current={current}
        tf={tf}
        onTf={setTf}
        logScale={logScale}
        onLogScale={setLogScale}
        connection={connection}
        theme={themeName}
        onTheme={changeTheme}
        onSearch={() => setSearchMode("open")}
        watchlistHidden={!watchlistVisible}
        onShowWatchlist={() => showWatchlist(true)}
      />
      <div className="main">
        <div className="chart-col">
          {!current && waitingDefault && (
            <Loading symbol={DEFAULT_SYMBOL} tf={tfLabel(tf)} source={sourceName("binance")} />
          )}
          {current && (
            <ChartView
              backend={backend}
              id={current}
              tf={tf}
              theme={theme}
              priceMode={logScale ? "log" : "linear"}
              connection={connection}
            />
          )}
        </div>
        {watchlistVisible && (
        <Watchlist
          backend={backend}
          ids={watchlist}
          savedVersion={savedVersion}
          current={current}
          onOpen={setCurrent}
          onChange={saveWatchlist}
          onAdd={() => setSearchMode("add")}
          onHide={() => showWatchlist(false)}
        />
        )}
      </div>
      <StatusBar source={sourceName(current?.source ?? "binance")} connection={connection} />
      {searchMode && (
        <SymbolSearch
          backend={backend}
          mode={searchMode}
          onOpen={(i) => setCurrent(i.id)}
          onAdd={addToWatchlist}
          onClose={() => setSearchMode(null)}
        />
      )}
    </div>
  );
}
