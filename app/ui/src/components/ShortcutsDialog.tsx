import { X } from "lucide-react";
import { useRef } from "react";
import { t } from "../i18n";
import { shortcutSections } from "../shortcuts";
import { useDismiss } from "./useDismiss";

/** Every keyboard shortcut, by area; Esc, × or a click outside closes it. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, ref);
  return (
    <div className="scrim">
      <div ref={ref} className="ind-dialog shortcuts" role="dialog" aria-modal="true" aria-label={t("shortcuts.title")} data-testid="shortcuts">
        <div className="ind-dialog-header">
          <span>{t("shortcuts.title")}</span>
          <button className="icon-button" aria-label={t("shortcuts.close")} title={t("shortcuts.close")} onClick={onClose} autoFocus>
            <X size={16} />
          </button>
        </div>
        <div className="ind-dialog-body shortcuts-body">
          {shortcutSections().map((s) => (
            <section key={s.id} className="shortcuts-section" data-testid={`shortcuts-${s.id}`}>
              <div className="ind-section">{s.title}</div>
              {s.rows.map((r) => (
                <div key={r.keys} className="shortcuts-row">
                  <span>{r.label}</span>
                  <kbd className="mono">{r.keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
