import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { version } from "../../package.json";
import { t } from "../i18n";
import type { UpdateState, UpdateStore } from "../state/update";
import { useDismiss } from "./useDismiss";

/** The answer of the last manual check, or what is going on now. */
function statusText(s: UpdateState): string {
  if (s.phase === "checking") return t("update.checking");
  if (s.phase === "upToDate") return t("update.upToDate");
  if (s.phase === "error" && s.failed === "check") return t("update.failed", { error: s.error ?? "" });
  if (s.available) return t("update.available", { version: s.available.version });
  return "";
}

/**
 * The version in the status bar, as a button: it opens the manual check, the "check
 * automatically" switch and the hosts the check talks to.
 */
export function VersionPopover({ store }: { store: UpdateStore }) {
  useSyncExternalStore(store.subscribe, store.version);
  const s = store.state;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  const checkFailed = s.phase === "error" && s.failed === "check";
  const busy = s.phase === "checking" || s.phase === "downloading" || s.phase === "installing" || s.phase === "restarting";
  return (
    <div className="ver" ref={ref}>
      <button
        className="ver-button"
        data-testid="version-button"
        title={t("update.version.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        v{version}
      </button>
      {open && (
        <div className="pop ver-pop" role="dialog" aria-label={t("update.version.title")} data-testid="version-popover">
          <div className="pop-title">
            Sandchart <span className="mono">{version}</span>
          </div>
          <div className="ver-check">
            <button className="text-button bordered" data-testid="update-check" disabled={busy} onClick={() => void s.checkNow()}>
              {checkFailed ? t("update.retry") : t("update.check")}
            </button>
            <span className={checkFailed ? "pop-text pop-error" : "pop-text"} data-testid="update-status">
              {statusText(s)}
            </span>
          </div>
          <button
            className="log-switch ver-auto"
            role="switch"
            aria-checked={s.auto}
            data-testid="update-auto"
            onClick={() => s.setAuto(!s.auto)}
          >
            {t("update.auto")}
            <span className="switch" />
          </button>
          <p className="ver-hosts">{t("update.hosts")}</p>
        </div>
      )}
    </div>
  );
}
