import { describe, expect, it } from "vitest";
import { TOOLS } from "./chart/drawings/registry";
import { helpKey, shortcutSections } from "./shortcuts";

const key = (code: string, extra: Partial<Parameters<typeof helpKey>[0]> = {}) => ({
  code,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  target: null,
  ...extra,
});

describe("the shortcut list", () => {
  it("lists every tool, the replay, alert and undo keys, each translated", () => {
    const sections = shortcutSections();
    expect(sections.map((s) => s.id)).toEqual(["general", "tools", "drawings", "replay", "alerts"]);
    const tools = sections.find((s) => s.id === "tools")!;
    expect(tools.rows.length).toBe(TOOLS.length + 2);
    const all = sections.flatMap((s) => s.rows);
    expect(all.map((r) => r.keys)).toEqual(expect.arrayContaining(["→", "Space", "⇧B", "⇧S", "⇧C", "?"]));
    for (const r of all) {
      expect(r.keys).not.toBe("");
      // A missing translation comes back as its key ("shortcuts.undo").
      expect(r.label).not.toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
    }
    // No two rows share keys.
    const keys = all.map((r) => r.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("opens with ? outside a text field only", () => {
    expect(helpKey(key("Slash", { shiftKey: true }))).toBe(true);
    expect(helpKey(key("Slash"))).toBe(false);
    expect(helpKey(key("Slash", { shiftKey: true, metaKey: true }))).toBe(false);
    expect(helpKey(key("Slash", { shiftKey: true, target: { tagName: "INPUT", type: "text" } }))).toBe(false);
  });
});
