import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { backend } from "./backend";
import type { ConnectionState, Instrument, InstrumentId, TimeframeCode } from "./backend/types";
import { dark, light } from "./chart/theme";
import { ChartView } from "./components/ChartView";
import { StatusBar } from "./components/StatusBar";
import { SymbolSearch } from "./components/SymbolSearch";
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

const sameId = (a: InstrumentId, b: InstrumentId) => a.source === b.source && a.symbol === b.symbol;

export function App() {
  useLanguage(); // re-render everything when the language changes
  const [themeName, setThemeName] = useState<ThemeName>(storedTheme);
  const [current, setCurrent] = useState<InstrumentId | null>(null);
  const [tf, setTf] = useState<TimeframeCode>("1h");
  const [logScale, setLogScale] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connected");
  const [watchlist, setWatchlistState] = useState<InstrumentId[]>([]);
  const [savedVersion, setSavedVersion] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeName;
  }, [themeName]);

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

  // Startup: the watchlist, and its first pair on the chart.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ids = await backend.getWatchlist();
      if (!alive) return;
      setWatchlistState(ids);
      const first = ids[0] ?? (await backend.searchInstruments(DEFAULT_SYMBOL)).find((i) => i.id.symbol === DEFAULT_SYMBOL)?.id;
      if (alive && first) setCurrent((c) => c ?? first);
    })().catch((e: unknown) => console.error("loading the watchlist failed", e));
    return () => {
      alive = false;
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
        setSearchOpen(true);
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
        onSearch={() => setSearchOpen(true)}
      />
      <div className="main">
        <div className="chart-col">
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
        <Watchlist
          backend={backend}
          ids={watchlist}
          savedVersion={savedVersion}
          current={current}
          onOpen={setCurrent}
          onChange={saveWatchlist}
          onAdd={() => setSearchOpen(true)}
        />
      </div>
      <StatusBar source={sourceName(current?.source ?? "binance")} connection={connection} />
      {searchOpen && (
        <SymbolSearch
          backend={backend}
          onOpen={(i) => setCurrent(i.id)}
          onAdd={addToWatchlist}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
