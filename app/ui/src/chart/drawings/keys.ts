import type { DrawingCommand } from "./layer";
import type { ToolId } from "./registry";

/** The parts of a KeyboardEvent the shortcuts read. */
export interface KeyLike {
  code: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

export type DrawingKeyAction = { tool: ToolId } | { command: DrawingCommand } | { magnet: true };

/** Alt + these keys: the ruler (not a stored drawing, so not in the registry) and the magnet. */
export const RULER_CODE = "KeyR";
export const MAGNET_CODE = "KeyM";

/** Focus is in a text field, where keys type instead. */
function typing(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  return el.isContentEditable === true || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * What a key press does to drawings: Alt + a tool's key picks the tool, Alt+R arms the
 * ruler, Alt+M toggles the magnet, ⌘Z / Ctrl+Z
 * undoes, with Shift redoes, Delete / Backspace removes the selection, Enter edits its
 * text, Esc cancels.
 * Keys are matched by `code` (the physical key): on macOS Alt changes the typed character.
 */
export function drawingKeyAction(e: KeyLike, tools: readonly { id: ToolId; code: string }[]): DrawingKeyAction | null {
  if (typing(e.target)) return null;
  const cmd = e.metaKey || e.ctrlKey;
  if (cmd && !e.altKey && e.code === "KeyZ") return { command: e.shiftKey ? "redo" : "undo" };
  if (cmd) return null;
  if (e.altKey) {
    if (e.code === RULER_CODE) return { command: "ruler" };
    if (e.code === MAGNET_CODE) return { magnet: true };
    const tool = tools.find((t) => t.code === e.code);
    return tool ? { tool: tool.id } : null;
  }
  if (e.code === "Delete" || e.code === "Backspace") return { command: "delete" };
  if (e.code === "Escape") return { command: "cancel" };
  if (e.code === "Enter" || e.code === "NumpadEnter") return { command: "edit" };
  return null;
}
