import { describe, expect, it } from "vitest";
import type { ProblemCode } from "./backend/types";
import { setLanguage } from "./i18n";
import { bannerText } from "./labels";

const CODES: ProblemCode[] = ["network", "rate_limited", "blocked", "unsafe_ticks", "other"];

describe("bannerText", () => {
  it("names the actual problem", () => {
    setLanguage("en");
    expect(bannerText("network", "Binance", "14:00")).toBe(
      "Can't reach Binance. Showing cached candles up to 14:00 UTC.",
    );
    expect(bannerText("network", "Binance", null)).toBe(
      "Can't reach Binance. No cached candles for this chart yet.",
    );
    expect(bannerText("rate_limited", "Binance", "14:00")).toMatch(/^Binance is limiting requests/);
    expect(bannerText("blocked", "Binance", "14:00")).toMatch(/^Binance is not available in your region/);
  });

  it("has a distinct text for every code in both languages", () => {
    for (const lang of ["en", "ru"] as const) {
      setLanguage(lang);
      const texts = CODES.map((c) => bannerText(c, "Binance", null));
      expect(new Set(texts).size, lang).toBe(CODES.length);
      for (const s of texts) expect(s, lang).not.toMatch(/banner\./);
    }
    setLanguage("en");
  });
});
