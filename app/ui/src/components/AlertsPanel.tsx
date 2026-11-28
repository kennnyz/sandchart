import { Bell, BellRing, RotateCcw, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { Alert, InstrumentId } from "../backend/types";
import { formatPrice, formatUtcClock } from "../chart/format";
import { t } from "../i18n";
import type { AlertStore } from "../state/alerts";

/** What an alert watches, for a label: the price, or "Line" for a line alert. */
export function alertLevel(a: Alert): string {
  return a.kind.kind === "price" ? formatPrice(a.kind.price, a.priceScale) : t("alerts.line");
}

function Row({ a, unseen, store, onOpen }: { a: Alert; unseen: boolean; store: AlertStore; onOpen(id: InstrumentId): void }) {
  const s = store.state;
  const state = a.active
    ? t("alerts.state.active")
    : t("alerts.state.fired", {
        time: a.triggeredAt === null ? "" : formatUtcClock(a.triggeredAt, Date.now()),
        price: a.triggeredPrice === null ? "" : formatPrice(a.triggeredPrice, a.priceScale),
      });
  return (
    <div
      className="al-row"
      data-testid="alert-row"
      data-symbol={a.instrument.symbol}
      data-state={a.active ? "active" : "fired"}
      data-unseen={unseen}
      onClick={() => {
        s.seen(a.id);
        onOpen(a.instrument);
      }}
    >
      <span className="al-icon">{a.active ? <Bell size={13} /> : <BellRing size={13} />}</span>
      <span className="al-main">
        <span className="al-line">
          <span className="al-sym mono">{a.instrument.symbol}</span>
          <span className="al-dir">{t(`alerts.dir.${a.direction}`)}</span>
          <span className="al-level mono">{alertLevel(a)}</span>
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

/** The alerts under the watchlist, newest first: pair, direction, level, state; arm again, delete. */
export function AlertsPanel({ store, onOpen }: { store: AlertStore; onOpen(id: InstrumentId): void }) {
  useSyncExternalStore(store.subscribe, store.version);
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
          <Row key={a.id} a={a} unseen={s.unseen.has(a.id)} store={store} onOpen={onOpen} />
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
