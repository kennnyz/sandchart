import { describe, expect, it } from "vitest";
import { ALERT_CODE, alertKey, cmdHeld, drawingKeyAction, MAGNET_CODE, macContextClick, RULER_CODE, type KeyLike } from "./keys";
import { TOOLS } from "./registry";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  target: null,
  ...mods,
});

describe("drawingKeyAction", () => {
  it("picks tools with Alt and the physical key", () => {
    // On macOS ⌥T types "†": only the code says which key it was.
    expect(drawingKeyAction(key("KeyT", { altKey: true }), TOOLS)).toEqual({ tool: "trend" });
    expect(drawingKeyAction(key("KeyH", { altKey: true }), TOOLS)).toEqual({ tool: "hline" });
    expect(drawingKeyAction(key("KeyT"), TOOLS)).toBeNull();
    expect(drawingKeyAction(key("KeyT", { altKey: true, metaKey: true }), TOOLS)).toBeNull();
    expect(drawingKeyAction(key("KeyQ", { altKey: true }), TOOLS)).toBeNull();
  });

  it("picks the new tools, arms the ruler and toggles the magnet", () => {
    expect(drawingKeyAction(key("KeyB", { altKey: true }), TOOLS)).toEqual({ tool: "rect" });
    expect(drawingKeyAction(key("KeyF", { altKey: true }), TOOLS)).toEqual({ tool: "fib" });
    expect(drawingKeyAction(key("KeyP", { altKey: true }), TOOLS)).toEqual({ tool: "brush" });
    expect(drawingKeyAction(key("KeyR", { altKey: true }), TOOLS)).toEqual({ command: "ruler" });
    expect(drawingKeyAction(key("KeyM", { altKey: true }), TOOLS)).toEqual({ magnet: true });
    expect(drawingKeyAction(key("KeyM"), TOOLS)).toBeNull();
    expect(drawingKeyAction(key("KeyR", { altKey: true, target: { tagName: "INPUT" } }), TOOLS)).toBeNull();
    // No tool takes the ruler's or the magnet's key.
    expect(TOOLS.map((t) => t.code)).not.toContain(RULER_CODE);
    expect(TOOLS.map((t) => t.code)).not.toContain(MAGNET_CODE);
  });

  it("leaves Alt+A to the price alert", () => {
    expect(TOOLS.map((t) => t.code)).not.toContain(ALERT_CODE);
    expect(drawingKeyAction(key("KeyA", { altKey: true }), TOOLS)).toBeNull();
    expect(alertKey(key("KeyA", { altKey: true }))).toBe(true);
    expect(alertKey(key("KeyA"))).toBe(false);
    expect(alertKey(key("KeyA", { altKey: true, metaKey: true }))).toBe(false);
    expect(alertKey(key("KeyA", { altKey: true, target: { tagName: "TEXTAREA" } }))).toBe(false);
  });

  it("undoes and redoes with ⌘Z / ⇧⌘Z or Ctrl", () => {
    expect(drawingKeyAction(key("KeyZ", { metaKey: true }), TOOLS)).toEqual({ command: "undo" });
    expect(drawingKeyAction(key("KeyZ", { ctrlKey: true }), TOOLS)).toEqual({ command: "undo" });
    expect(drawingKeyAction(key("KeyZ", { metaKey: true, shiftKey: true }), TOOLS)).toEqual({ command: "redo" });
    expect(drawingKeyAction(key("KeyZ"), TOOLS)).toBeNull();
    expect(drawingKeyAction(key("KeyZ", { metaKey: true, altKey: true }), TOOLS)).toBeNull();
  });

  it("deletes with Delete or Backspace and cancels with Esc", () => {
    expect(drawingKeyAction(key("Delete"), TOOLS)).toEqual({ command: "delete" });
    expect(drawingKeyAction(key("Backspace"), TOOLS)).toEqual({ command: "delete" });
    expect(drawingKeyAction(key("Backspace", { metaKey: true }), TOOLS)).toBeNull();
    expect(drawingKeyAction(key("Escape"), TOOLS)).toEqual({ command: "cancel" });
  });

  it("picks the long, the short and the note, and edits a note's text with Enter", () => {
    expect(drawingKeyAction(key("KeyL", { altKey: true }), TOOLS)).toEqual({ tool: "long" });
    expect(drawingKeyAction(key("KeyS", { altKey: true }), TOOLS)).toEqual({ tool: "short" });
    expect(drawingKeyAction(key("KeyN", { altKey: true }), TOOLS)).toEqual({ tool: "note" });
    expect(drawingKeyAction(key("Enter"), TOOLS)).toEqual({ command: "edit" });
    expect(drawingKeyAction(key("NumpadEnter"), TOOLS)).toEqual({ command: "edit" });
    expect(drawingKeyAction(key("Enter", { metaKey: true }), TOOLS)).toBeNull();
    expect(drawingKeyAction(key("Enter", { target: { tagName: "TEXTAREA" } }), TOOLS)).toBeNull();
  });

  it("ignores keys typed into a field", () => {
    for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(drawingKeyAction(key("Backspace", { target }), TOOLS)).toBeNull();
      expect(drawingKeyAction(key("KeyT", { altKey: true, target }), TOOLS)).toBeNull();
    }
    expect(drawingKeyAction(key("Backspace", { target: { tagName: "BUTTON" } }), TOOLS)).toEqual({ command: "delete" });
    // A checkbox takes no text: ⌘Z still undoes.
    const box = { tagName: "INPUT", type: "checkbox" };
    expect(drawingKeyAction(key("KeyZ", { metaKey: true, target: box }), TOOLS)).toEqual({ command: "undo" });
    expect(drawingKeyAction(key("KeyZ", { metaKey: true, target: { tagName: "INPUT", type: "text" } }), TOOLS)).toBeNull();
  });
});

describe("cmdHeld", () => {
  it("is ⌘ on macOS and Ctrl elsewhere", () => {
    // On macOS Ctrl+click is a right click, so Ctrl must not count as ⌘ there.
    expect(cmdHeld({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(cmdHeld({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(cmdHeld({ metaKey: false, ctrlKey: true }, false)).toBe(true);
    expect(cmdHeld({ metaKey: true, ctrlKey: false }, false)).toBe(false);
  });

  it("treats a macOS Ctrl+click with the main button as a right click", () => {
    expect(macContextClick({ ctrlKey: true, button: 0 }, true)).toBe(true);
    expect(macContextClick({ ctrlKey: false, button: 0 }, true)).toBe(false);
    expect(macContextClick({ ctrlKey: true, button: 0 }, false)).toBe(false);
  });
});
