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

/** macOS (and iOS): the command modifier is ⌘, and Ctrl+click is a right click. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The platform's command modifier is held on a pointer event: ⌘ on macOS, Ctrl elsewhere. */
export function cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }, mac = isMac): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

/** A macOS Ctrl+click with the main button: the system makes it a right click (`contextmenu`). */
export function macContextClick(e: { ctrlKey: boolean; button: number }, mac = isMac): boolean {
  return mac && e.ctrlKey && e.button === 0;
}

/** Alt + these keys: the ruler (not a stored drawing, so not in the registry) and the magnet. */
export const RULER_CODE = "KeyR";
export const MAGNET_CODE = "KeyM";
/** Alt + this key sets a price alert at the crosshair price (not a drawing, so not in the registry). */
export const ALERT_CODE = "KeyA";

/** Alt+A outside a text field: a price alert at the crosshair price. */
export function alertKey(e: KeyLike): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === ALERT_CODE && !typing(e.target);
}

/** Input types that take no typed text: a checkbox in a popover leaves ⌘Z to the chart. */
const NOT_TEXT = new Set(["checkbox", "radio", "button"]);

/** Focus is in a text field, where keys type instead. */
export function typing(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
  if (el.tagName === "INPUT") return !NOT_TEXT.has(el.type ?? "");
  return el.isContentEditable === true || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
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
