import { Bell, BellRing, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { levelAt, levelOf } from "../alertLevel";
import type { Alert, InstrumentId } from "../backend/types";
import { formatPrice, formatUtcClock } from "../chart/format";
import { t } from "../i18n";
import type { AlertStore } from "../state/alerts";
import type { DrawingStore } from "../state/drawings";

/**
 * What an alert watches, for a label: the price; for a line alert the line's price now when
 * `drawings` has the line (the pair on the chart), else "Line".
 */
export function alertLevel(a: Alert, drawings?: DrawingStore, now = Date.now()): string {
  if (a.kind.kind === "price") return formatPrice(a.kind.price, a.priceScale);
  const d = drawings?.state.line(a.kind.drawingId);
  const level = d ? levelOf(d.body) : null;
  const p = level ? levelAt(level, now) : null;
  return p === null ? t("alerts.line") : formatPrice(p, d!.priceScale);
}

interface RowProps {
  a: Alert;
  unseen: boolean;
  selected: boolean;
  store: AlertStore;
  drawings?: DrawingStore;
  /** A replay holds its pair back: the engine does not check this alert until it ends or catches up. */
  paused: boolean;
  onOpen(id: InstrumentId): void;
}

function Row({ a, unseen, selected, store, drawings, paused, onOpen }: RowProps) {
  const s = store.state;
  const ref = useRef<HTMLDivElement>(null);
  // Picked on the chart: bring it into view in the list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const state = a.active
    ? t(paused ? "alerts.state.paused" : "alerts.state.active")
    : t("alerts.state.fired", {
        time: a.triggeredAt === null ? "" : formatUtcClock(a.triggeredAt, Date.now()),
        price: a.triggeredPrice === null ? "" : formatPrice(a.triggeredPrice, a.priceScale),
      });
  return (
    <div
      ref={ref}
      className="al-row"
      data-testid="alert-row"
      data-symbol={a.instrument.symbol}
      data-state={a.active ? "active" : "fired"}
      data-paused={paused && a.active}
      data-unseen={unseen}
      data-selected={selected}
      aria-selected={selected}
      onClick={() => {
        s.seen(a.id);
        s.select(a.id);
        onOpen(a.instrument);
      }}
    >
      <span className="al-icon">{a.active ? <Bell size={13} /> : <BellRing size={13} />}</span>
      <span className="al-main">
        <span className="al-line">
          <span className="al-sym mono">{a.instrument.symbol}</span>
          <span className="al-dir">{t(`alerts.dir.${a.direction}`)}</span>
          <span className="al-level mono" data-testid="alert-level">
            {alertLevel(a, drawings)}
          </span>
        </span>
        <span className="al-state mono">{state}</span>
      </span>
      <span className="al-actions">
        {!a.active && (
          <button
            className="icon-button"
            data-testid="alert-rearm"
            title={t("alerts.rearm")}
            aria-label={t("alerts.rearm")}
            onClick={(e) => {
              e.stopPropagation();
              void s.rearm(a.id);
            }}
          >
            <RotateCcw size={13} />
          </button>
        )}
        <button
          className="icon-button"
          data-testid="alert-delete"
          title={t("alerts.delete")}
          aria-label={t("alerts.delete")}
          onClick={(e) => {
            e.stopPropagation();
            void s.remove(a.id);
          }}
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}

const noSubscribe = () => () => {};
const noVersion = () => 0;

/** The alerts under the watchlist, newest first: pair, direction, level, state; arm again, delete. */
export interface AlertsPanelProps {
  store: AlertStore;
  drawings?: DrawingStore;
  /** The pair a replay holds back (its alerts are paused), or null. */
  replaying?: InstrumentId | null;
  onOpen(id: InstrumentId): void;
}

export function AlertsPanel({ store, drawings, replaying = null, onOpen }: AlertsPanelProps) {
  useSyncExternalStore(store.subscribe, store.version);
  // A line moved on the chart moves its alert's level here.
  useSyncExternalStore(drawings?.subscribe ?? noSubscribe, drawings?.version ?? noVersion);
  const s = store.state;
  const active = s.list.filter((a) => a.active).length;
  return (
    <section className="alerts" data-testid="alerts-panel" aria-label={t("alerts.title")}>
      <div className="al-header">
        <span>{t("alerts.title")}</span>
        <span className="al-count">{t("alerts.activeCount", { n: active })}</span>
      </div>
      <div className="al-list">
        {s.list.length === 0 && (
          <div className="al-empty" data-testid="alerts-empty">
            {t("alerts.empty")}
          </div>
        )}
        {[...s.list].reverse().map((a) => (
          <Row
            key={a.id}
            a={a}
            unseen={s.unseen.has(a.id)}
            selected={s.selected === a.id}
            store={store}
            drawings={drawings}
            paused={replaying !== null && replaying.source === a.instrument.source && replaying.symbol === a.instrument.symbol}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

/** The toast of the last alert that fired; closing it counts as seen. */
export function AlertToast({ store }: { store: AlertStore }) {
  useSyncExternalStore(store.subscribe, store.version);
  const s = store.state;
  const a = s.toast;
  if (!a) return null;
  const level = a.kind.kind === "price" ? formatPrice(a.kind.price, a.priceScale) : t("alerts.toastLine");
  const price = a.triggeredPrice === null ? "" : formatPrice(a.triggeredPrice, a.priceScale);
  return (
    <div className="alert-toast" data-testid="alert-toast" role="status">
      <BellRing size={15} />
      <span className="text">{t("alerts.toast", { symbol: a.instrument.symbol, level, price })}</span>
      <button
        className="icon-button"
        aria-label={t("alerts.toastClose")}
        title={t("alerts.toastClose")}
        onClick={() => {
          s.seen(a.id);
          s.dismissToast();
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
