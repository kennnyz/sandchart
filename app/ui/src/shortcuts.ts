import { ALERT_CODE, isMac, MAGNET_CODE, RULER_CODE, typing, type KeyLike } from "./chart/drawings/keys";
import { TOOLS } from "./chart/drawings/registry";
import { t } from "./i18n";
import { altShortcutLabel, deleteKeyLabel, enterKeyLabel, shortcutLabel } from "./labels";
import { REPLAY_KEYS } from "./state/replay";

export interface ShortcutRow {
  keys: string;
  label: string;
}

export interface ShortcutSection {
  id: string;
  title: string;
  rows: ShortcutRow[];
}

/** "KeyT" -> "T". */
const letter = (code: string) => code.replace(/^Key/, "");
const cmd = isMac ? "⌘" : "Ctrl";

/**
 * Every keyboard shortcut of the app, in the UI language, built from the places that define
 * them (the tool registry, the drawing, alert and replay keys), so the list cannot fall behind.
 */
export function shortcutSections(): ShortcutSection[] {
  return [
    {
      id: "general",
      title: t("shortcuts.general"),
      rows: [
        { keys: shortcutLabel("K"), label: t("shortcuts.search") },
        { keys: "?", label: t("shortcuts.help") },
      ],
    },
    {
      id: "tools",
      title: t("shortcuts.tools"),
      rows: [
        ...TOOLS.map((tool) => ({ keys: altShortcutLabel(letter(tool.code)), label: t(tool.labelKey) })),
        { keys: altShortcutLabel(letter(RULER_CODE)), label: t("tools.ruler") },
        { keys: altShortcutLabel(letter(MAGNET_CODE)), label: t("tools.magnet") },
      ],
    },
    {
      id: "drawings",
      title: t("shortcuts.drawings"),
      rows: [
        { keys: shortcutLabel("Z"), label: t("shortcuts.undo") },
        { keys: isMac ? "⇧⌘Z" : "Ctrl Shift Z", label: t("shortcuts.redo") },
        { keys: deleteKeyLabel(), label: t("shortcuts.delete") },
        { keys: enterKeyLabel(), label: t("shortcuts.edit") },
        { keys: "Esc", label: t("shortcuts.cancel") },
        { keys: cmd, label: t("shortcuts.snap") },
        { keys: "⇧", label: t("shortcuts.horizontal") },
      ],
    },
    {
      id: "replay",
      title: t("shortcuts.replay"),
      rows: [
        { keys: REPLAY_KEYS.step, label: t("replay.step") },
        { keys: REPLAY_KEYS.play, label: `${t("replay.play")} / ${t("replay.pause")}` },
        { keys: REPLAY_KEYS.buy, label: t("replay.buy") },
        { keys: REPLAY_KEYS.sell, label: t("replay.sell") },
        { keys: REPLAY_KEYS.close, label: t("replay.closeTrade") },
      ],
    },
    {
      id: "alerts",
      title: t("shortcuts.alerts"),
      rows: [{ keys: altShortcutLabel(letter(ALERT_CODE)), label: t("shortcuts.priceAlert") }],
    },
  ];
}

/** "?" (Shift and the / key, by the physical key) outside a text field opens the list. */
export function helpKey(e: KeyLike): boolean {
  return e.code === "Slash" && e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !typing(e.target);
}
