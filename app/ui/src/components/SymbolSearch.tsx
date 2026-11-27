import { Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Backend, Instrument } from "../backend/types";
import { t } from "../i18n";
import { sourceName } from "../labels";

export interface SymbolSearchProps {
  backend: Backend;
  onOpen: (i: Instrument) => void;
  onAdd: (i: Instrument) => void;
  onClose: () => void;
}

/** The symbol with the part matching `query` emphasised. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toUpperCase();
  const at = q ? text.indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b>{text.slice(at, at + q.length)}</b>
      {text.slice(at + q.length)}
    </>
  );
}

/** Search dialog (⌘K or the symbol button): ↑↓ select, ↵ open, ⇧↵ add to the watchlist. */
export function SymbolSearch({ backend, onOpen, onAdd, onClose }: SymbolSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; items: Instrument[] } | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Enter pressed before the results for the typed text arrived: act when they do.
  const pending = useRef<"open" | "add" | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    let alive = true;
    backend
      .searchInstruments(query)
      .then((items) => {
        if (!alive) return;
        setResults({ query, items });
        setSelected(0);
      })
      .catch((e: unknown) => console.error("search failed", e));
    return () => {
      alive = false;
    };
  }, [backend, query]);

  const current = results?.query === query ? results.items : null;

  const act = (kind: "open" | "add", item: Instrument | undefined) => {
    if (!item) return;
    if (kind === "open") onOpen(item);
    else onAdd(item);
    onClose();
  };

  useEffect(() => {
    if (!current || !pending.current) return;
    const kind = pending.current;
    pending.current = null;
    act(kind, current[0]);
    // Runs once per result set; `act` closes over the latest callbacks.
  }, [current]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = current?.length ?? 0;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) setSelected((s) => (s + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setSelected((s) => (s - 1 + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const kind = e.shiftKey ? "add" : "open";
      if (current) act(kind, current[selected]);
      else pending.current = kind;
    }
  };

  const items = current ?? results?.items ?? [];
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search" data-testid="search" role="dialog" aria-label={t("search.label")}>
        <div className="search-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            className="mono"
            data-testid="search-input"
            value={query}
            placeholder={t("search.placeholder")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="key">{t("search.esc")}</kbd>
        </div>
        <div className="search-results" ref={listRef} role="listbox">
          {items.map((it, i) => (
            <div
              key={`${it.id.source}/${it.id.symbol}`}
              className="search-row"
              data-testid="search-row"
              role="option"
              aria-selected={i === selected}
              onPointerMove={() => setSelected(i)}
              onClick={(e) => act(e.shiftKey ? "add" : "open", it)}
            >
              <span className="sym mono">
                <Highlight text={it.id.symbol} query={query} />
              </span>
              <span className="name">
                {it.base} / {it.quote}
              </span>
              <span className="src">{sourceName(it.id.source)}</span>
              <span className="enter mono">{i === selected ? "↵" : ""}</span>
            </div>
          ))}
          {current && current.length === 0 && <div className="search-none">{t("search.none", { q: query })}</div>}
        </div>
        <div className="search-footer mono">
          <span>{t("search.footer")}</span>
          <span>{t("search.count", { n: items.length })}</span>
        </div>
      </div>
    </div>
  );
}
