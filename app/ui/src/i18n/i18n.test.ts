import { describe, expect, it } from "vitest";
import en from "./en.json";
import ru from "./ru.json";
import { detectLanguage, getLanguage, setLanguage, t } from "./index";

describe("i18n", () => {
  it("ru has every en key", () => {
    const enKeys = Object.keys(en).sort();
    const ruKeys = Object.keys(ru).sort();
    expect(enKeys.filter((k) => !ruKeys.includes(k))).toEqual([]);
    // ...and no extra keys.
    expect(ruKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    for (const k of ruKeys) expect((ru as Record<string, string>)[k]).not.toBe("");
  });

  it("uses the same placeholders in both languages", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [k, v] of Object.entries(en)) {
      expect(vars((ru as Record<string, string>)[k]!), k).toEqual(vars(v));
    }
  });

  it("detects Russian from navigator.language, English otherwise", () => {
    expect(detectLanguage("ru")).toBe("ru");
    expect(detectLanguage("ru-RU")).toBe("ru");
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("de-DE")).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
  });

  it("translates and fills variables", () => {
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    expect(t("loading.title", { symbol: "BTCUSDT", tf: "1h" })).toBe("Loading BTCUSDT · 1h");
    setLanguage("ru");
    expect(t("loading.title", { symbol: "BTCUSDT", tf: "1h" })).toBe("Загрузка BTCUSDT · 1h");
    setLanguage("en");
  });

  it("says in Russian that a repainting indicator is redrawn", () => {
    expect(ru["indicators.repaints"]).toBe("Перерисовывается: прошлые значения могут измениться");
  });

  it("returns the key for an unknown string", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });
});
