import { Eye, EyeOff, Magnet, Ruler } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { drawingKeyAction, MAGNET_CODE, RULER_CODE } from "../chart/drawings/keys";
import { TOOLS } from "../chart/drawings/registry";
import { t } from "../i18n";
import { altShortcutLabel } from "../labels";
import type { DrawingStore } from "../state/drawings";
import { Menu } from "./Menu";

/** "KeyT" -> "T". */
const keyName = (code: string) => code.replace(/^Key/, "");

/** The tools rail left of the chart, built from the tool registry, the magnet switch, hide all, and the drawing shortcuts. */
export function DrawingToolbar({ store }: { store: DrawingStore }) {
  useSyncExternalStore(store.subscribe, store.version);
  const s = store.state;
  const eye = useRef<HTMLButtonElement>(null);
  /** Where the visibility menu opens (window px), or null while it is closed. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const pick = (run: () => void) => () => {
    setMenu(null);
    run();
  };

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
        data-testid="tool-ruler"
        aria-label={t("tools.ruler")}
        title={t("tools.title", { name: t("tools.ruler"), shortcut: altShortcutLabel(keyName(RULER_CODE)) })}
        onClick={() => s.command("ruler")}
      >
        <Ruler size={18} strokeWidth={1.75} />
      </button>
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
      <button
        ref={eye}
        className="tool-button tools-bottom"
        data-testid="tool-hide-all"
        aria-label={t("tools.visibility")}
        aria-pressed={s.hidden}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={t("tools.visibility")}
        onClick={() => {
          const r = eye.current?.getBoundingClientRect();
          setMenu(menu || !r ? null : { x: r.right, y: r.top });
        }}
      >
        {s.hidden ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
        {s.hiddenCount > 0 && (
          <span className="tool-badge mono" data-testid="drawings-hidden-badge" aria-label={t("tools.hiddenBadge", { n: s.hiddenCount })}>
            {s.hiddenCount}
          </span>
        )}
      </button>
      {menu && (
        <Menu
          fixed
          items={[
            {
              id: "toggle",
              label: t(s.hidden ? "tools.showAll" : "tools.hideAll"),
              icon: s.hidden ? Eye : EyeOff,
              onSelect: pick(() => s.toggleHidden()),
            },
            {
              id: "show-hidden",
              label: t("tools.showHidden", { n: s.hiddenCount }),
              icon: Eye,
              disabled: s.hiddenCount === 0,
              onSelect: pick(() => s.showHidden()),
            },
          ]}
          label={t("tools.visibility")}
          testId="visibility-menu"
          x={menu.x}
          y={menu.y}
          width={window.innerWidth}
          height={window.innerHeight}
          onClose={closeMenu}
        />
      )}
    </nav>
  );
}
