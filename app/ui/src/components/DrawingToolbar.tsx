import { Magnet } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { drawingKeyAction, MAGNET_CODE } from "../chart/drawings/keys";
import { TOOLS } from "../chart/drawings/registry";
import { t } from "../i18n";
import { altShortcutLabel } from "../labels";
import type { DrawingStore } from "../state/drawings";

/** "KeyT" -> "T". */
const keyName = (code: string) => code.replace(/^Key/, "");

/** The tools rail left of the chart, built from the tool registry, the magnet switch, and the drawing shortcuts. */
export function DrawingToolbar({ store }: { store: DrawingStore }) {
  useSyncExternalStore(store.subscribe, store.version);
  const s = store.state;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = drawingKeyAction(e, TOOLS);
      if (!action) return;
      if ("tool" in action) s.toggleTool(action.tool);
      else if ("magnet" in action) s.toggleMagnet();
      else if (!s.command(action.command)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  return (
    <nav className="tools" aria-label={t("tools.label")} data-testid="drawing-tools">
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        const name = t(tool.labelKey);
        return (
          <button
            key={tool.id}
            className="tool-button"
            data-testid={`tool-${tool.id}`}
            aria-label={name}
            aria-pressed={s.tool === tool.id}
            title={t("tools.title", { name, shortcut: altShortcutLabel(keyName(tool.code)) })}
            onClick={() => s.toggleTool(tool.id)}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        );
      })}
      <div className="tools-sep" aria-hidden="true" />
      <button
        className="tool-button"
        data-testid="tool-magnet"
        aria-label={t("tools.magnet")}
        aria-pressed={s.magnet}
        title={t("tools.title", { name: t("tools.magnet"), shortcut: altShortcutLabel(keyName(MAGNET_CODE)) })}
        onClick={() => s.toggleMagnet()}
      >
        <Magnet size={18} strokeWidth={1.75} />
      </button>
    </nav>
  );
}
