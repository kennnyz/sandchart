import { describe, expect, it } from "vitest";
import { drawingKeyAction, type KeyLike } from "./keys";
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

  it("ignores keys typed into a field", () => {
    for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
      expect(drawingKeyAction(key("Backspace", { target }), TOOLS)).toBeNull();
      expect(drawingKeyAction(key("KeyT", { altKey: true, target }), TOOLS)).toBeNull();
    }
    expect(drawingKeyAction(key("Backspace", { target: { tagName: "BUTTON" } }), TOOLS)).toEqual({ command: "delete" });
  });
});
