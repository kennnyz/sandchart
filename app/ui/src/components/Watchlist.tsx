import { PanelRightClose, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { Backend, DayChange, InstrumentId } from "../backend/types";
import { formatBp, formatPrice } from "../chart/format";
import { t } from "../i18n";

const ROW_HEIGHT = 36;
/** Pointer travel (px) that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD = 4;
const QUOTES_REFRESH_MS = 30_000;

export interface WatchlistProps {
  backend: Backend;
  ids: InstrumentId[];
  /** Bumped after the list was saved, so the quotes are fetched for the new list. */
  savedVersion: number;
  current: InstrumentId | null;
  onOpen: (id: InstrumentId) => void;
  onChange: (ids: InstrumentId[]) => void;
  onAdd: () => void;
  /** Hides the panel; the top bar's watchlist button brings it back. */
  onHide: () => void;
}

const keyOf = (id: InstrumentId) => `${id.source}/${id.symbol}`;

type Drag = { pointerId: number; from: number; to: number; startY: number; moved: boolean };

/** Pairs with their last price and 24 h change; click opens, drag reorders, × removes. */
export function Watchlist({ backend, ids, savedVersion, current, onOpen, onChange, onAdd, onHide }: WatchlistProps) {
  const [quotes, setQuotes] = useState<Map<string, DayChange>>(new Map());
  const [scales, setScales] = useState<Map<string, number>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 24 h quotes: now, after every save, and every 30 s.
  useEffect(() => {
    let alive = true;
    const load = () =>
      backend
        .getWatchlistQuotes()
        .then((qs) => alive && setQuotes(new Map(qs.map((q) => [keyOf(q.id), q]))))
        .catch((e: unknown) => console.error("watchlist quotes failed", e));
    void load();
    const timer = setInterval(load, QUOTES_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [backend, savedVersion]);

  // Quotes come in ticks; the instrument says how many decimals a tick has.
  const missing = ids.filter((id) => !scales.has(keyOf(id)));
  const missingKey = missing.map(keyOf).join(",");
  useEffect(() => {
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(
      missing.map((id) =>
        backend
          .searchInstruments(id.symbol)
          .then((found) => found.find((i) => keyOf(i.id) === keyOf(id))?.priceScale)
          .catch(() => undefined),
      ),
    ).then((found) => {
      if (!alive) return;
      setScales((prev) => {
        const next = new Map(prev);
        missing.forEach((id, i) => {
          const s = found[i];
          if (s !== undefined) next.set(keyOf(id), s);
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [backend, missingKey]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ pointerId: e.pointerId, from: index, to: index, startY: e.clientY, moved: false });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const moved = drag.moved || Math.abs(e.clientY - drag.startY) > DRAG_THRESHOLD;
    const top = listRef.current?.getBoundingClientRect().top ?? 0;
    const scroll = listRef.current?.scrollTop ?? 0;
    const to = Math.max(0, Math.min(ids.length - 1, Math.floor((e.clientY - top + scroll) / ROW_HEIGHT)));
    if (moved !== drag.moved || to !== drag.to) setDrag({ ...drag, moved, to });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>, id: InstrumentId) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    setDrag(null);
    if (!drag.moved) {
      onOpen(id);
    } else if (drag.to !== drag.from) {
      const next = [...ids];
      const [item] = next.splice(drag.from, 1);
      next.splice(drag.to, 0, item!);
      onChange(next);
    }
  };

  // While dragging, show the list in its new order.
  const shown = [...ids];
  if (drag?.moved && drag.to !== drag.from) {
    const [item] = shown.splice(drag.from, 1);
    shown.splice(drag.to, 0, item!);
  }

  return (
    <aside className="watchlist" data-testid="watchlist">
      <div className="wl-header">
        <span>{t("watchlist.title")}</span>
        <div className="wl-actions">
          <button className="icon-button" data-testid="watchlist-add" title={t("watchlist.add")} onClick={onAdd}>
            <Plus size={16} />
          </button>
          <button className="icon-button" data-testid="watchlist-hide" title={t("watchlist.hide")} onClick={onHide}>
            <PanelRightClose size={16} />
          </button>
        </div>
      </div>
      <div className="wl-columns">
        <span className="wl-sym">{t("watchlist.col.symbol")}</span>
        <span className="wl-last">{t("watchlist.col.last")}</span>
        <span className="wl-chg">{t("watchlist.col.change")}</span>
      </div>
      <div className="wl-list" ref={listRef}>
        {ids.length === 0 && (
          <div className="wl-empty" data-testid="watchlist-empty">
            <div className="title">{t("watchlist.empty.title")}</div>
            <div className="body">{t("watchlist.empty.body")}</div>
            <button className="primary-button" onClick={onAdd}>
              {t("watchlist.empty.button")}
            </button>
          </div>
        )}
        {shown.map((id) => {
          const key = keyOf(id);
          const q = quotes.get(key);
          const scale = scales.get(key);
          const index = ids.findIndex((x) => keyOf(x) === key);
          const dragging = drag?.moved === true && drag.from === index;
          return (
            <div
              key={key}
              className="wl-row mono"
              data-testid="watchlist-row"
              data-symbol={id.symbol}
              data-dragging={dragging}
              aria-current={current !== null && keyOf(current) === key}
              onPointerDown={(e) => onPointerDown(e, index)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => onPointerUp(e, id)}
              onPointerCancel={() => setDrag(null)}
            >
              <span className="wl-sym">{id.symbol}</span>
              <span className="wl-last">{q && scale !== undefined ? formatPrice(q.last, scale) : "—"}</span>
              <span className={`wl-chg ${q && q.changeBp < 0 ? "down" : q && q.changeBp > 0 ? "up" : ""}`}>
                {q ? formatBp(q.changeBp) : ""}
              </span>
              <button
                className="wl-remove"
                data-testid="watchlist-remove"
                title={t("watchlist.remove", { symbol: id.symbol })}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={() => onChange(ids.filter((x) => keyOf(x) !== key))}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="wl-footer">{t("watchlist.hint")}</div>
    </aside>
  );
}
