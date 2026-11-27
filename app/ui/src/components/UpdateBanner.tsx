import { CircleArrowUp, TriangleAlert } from "lucide-react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import type { UpdateState, UpdateStore } from "../state/update";
import { useDismiss } from "./useDismiss";

/** Shown as text to select and copy: the app opens no links (no opener plugin). */
const RELEASE_URL = "https://github.com/kennnyz/sandchart/releases/latest";

/** "42%", or nothing while the size is unknown. */
const percent = (p: number | null) => (p === null ? "" : `${Math.round(p * 100)}%`);

/** What the install is doing, or null when it is not running. */
function progressText(s: UpdateState): string | null {
  if (s.phase === "downloading") return t("update.downloading", { percent: percent(s.progress) }).trim();
  if (s.phase === "installing") return t("update.installing");
  if (s.phase === "restarting") return t("update.restarting");
  return null;
}

function ReleaseLink() {
  return (
    <div className="upd-release">
      <span>{t("update.releasePage")}</span>
      <span className="mono selectable" data-testid="release-url">
        {RELEASE_URL}
      </span>
    </div>
  );
}

/**
 * The update chip on the right of the status bar while an update is available and not put
 * off with "Later". It opens a panel with the release notes and Install / Later; where this
 * copy cannot update itself it says why and gives the release page instead.
 */
export function UpdateBanner({ store }: { store: UpdateStore }) {
  useSyncExternalStore(store.subscribe, store.version);
  const s = store.state;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  const info = s.available;
  if (!s.shown || !info) return null;
  const available = t("update.available", { version: info.version });
  const failed = s.phase === "error" && s.failed === "install";
  const progress = progressText(s);
  const later = () => {
    setOpen(false);
    s.later();
  };

  return (
    <div className="upd" ref={ref}>
      <button
        className="upd-chip"
        data-testid="update-banner"
        data-failed={failed}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {failed ? <TriangleAlert size={12} /> : <CircleArrowUp size={12} />}
        <span>{progress ?? available}</span>
      </button>
      {open && (
        <div className="pop upd-panel" role="dialog" aria-label={available} data-testid="update-panel">
          <div className="pop-title">{available}</div>
          {info.notes && <div className="upd-notes selectable">{info.notes}</div>}
          {info.blocker ? (
            <>
              <p className="pop-text">{t(`update.blocked.${info.blocker}`)}</p>
              <ReleaseLink />
              <div className="pop-actions">
                <button className="text-button" onClick={later}>
                  {t("update.later")}
                </button>
              </div>
            </>
          ) : progress !== null ? (
            <>
              <p className="pop-text" data-testid="update-progress">
                {progress}
              </p>
              {s.phase === "downloading" && s.progress !== null && (
                <div className="upd-bar">
                  <span style={{ width: `${s.progress * 100}%` }} />
                </div>
              )}
            </>
          ) : (
            <>
              {failed && (
                <p className="pop-text pop-error" data-testid="update-error">
                  {t("update.failed", { error: s.error ?? "" })}
                </p>
              )}
              <div className="pop-actions">
                <button className="primary-button" data-testid="update-install" onClick={() => void s.install()}>
                  {failed ? t("update.retry") : t("update.install")}
                </button>
                <button className="text-button" onClick={later}>
                  {t("update.later")}
                </button>
              </div>
              {failed && <ReleaseLink />}
            </>
          )}
        </div>
      )}
    </div>
  );
}
