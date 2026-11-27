import { ChevronDown, Moon, PanelRightOpen, Sun } from "lucide-react";
import type { ConnectionState, InstrumentId, TimeframeCode } from "../backend/types";
import { getLanguage, setLanguage, t } from "../i18n";
import { shortcutLabel, sourceName } from "../labels";
import { TimeframePicker } from "./TimeframePicker";

export interface TopBarProps {
  current: InstrumentId | null;
  tf: TimeframeCode;
  onTf: (tf: TimeframeCode) => void;
  logScale: boolean;
  onLogScale: (on: boolean) => void;
  connection: ConnectionState;
  theme: "dark" | "light";
  onTheme: (t: "dark" | "light") => void;
  onSearch: () => void;
  /** When the watchlist is hidden, a button here brings it back. */
  watchlistHidden: boolean;
  onShowWatchlist: () => void;
}

/** The brand mark from assets/brand (viewBox 0 0 342 350), filled with `fg`. */
function LogoMark() {
  return (
    <svg viewBox="0 0 342 350" aria-hidden="true">
      <polygon points="140,0 342,0 289,140 87,140" />
      <polygon points="87,140 254,210 131,210" />
      <polygon points="53,210 254,210 201,350 0,350" />
    </svg>
  );
}

export function TopBar(p: TopBarProps) {
  const lang = getLanguage();
  return (
    <header className="topbar">
      <div className="brand">
        <LogoMark />
        <span className="wordmark">{t("app.name")}</span>
      </div>
      <div className="divider" />
      <button
        className="symbol-button"
        data-testid="symbol-button"
        title={t("topbar.symbol.title", { shortcut: shortcutLabel("K") })}
        onClick={p.onSearch}
      >
        <span className="symbol mono">{p.current?.symbol ?? ""}</span>
        <span className="source">{p.current ? sourceName(p.current.source) : ""}</span>
        <ChevronDown size={14} />
      </button>
      <TimeframePicker value={p.tf} onChange={p.onTf} />
      <div className="divider" />
      <button
        className="log-switch"
        role="switch"
        aria-checked={p.logScale}
        title={t("topbar.log.title")}
        onClick={() => p.onLogScale(!p.logScale)}
      >
        {t("topbar.log")}
        <span className="switch" />
      </button>
      <div className="spacer" />
      <div className="connection" data-testid="connection">
        <span className="dot" data-state={p.connection} />
        {t(`conn.${p.connection}`)}
      </div>
      <button
        className="text-button mono"
        data-testid="lang-button"
        title={t("topbar.lang.title")}
        onClick={() => setLanguage(lang === "en" ? "ru" : "en")}
      >
        {lang.toUpperCase()}
      </button>
      <button
        className="icon-button"
        data-testid="theme-button"
        title={p.theme === "dark" ? t("topbar.theme.toLight") : t("topbar.theme.toDark")}
        onClick={() => p.onTheme(p.theme === "dark" ? "light" : "dark")}
      >
        {p.theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
      </button>
      {p.watchlistHidden && (
        <button
          className="icon-button"
          data-testid="watchlist-show"
          title={t("watchlist.show")}
          onClick={p.onShowWatchlist}
        >
          <PanelRightOpen size={16} />
        </button>
      )}
    </header>
  );
}
