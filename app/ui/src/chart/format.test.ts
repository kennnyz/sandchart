import { describe, expect, it } from "vitest";
import { formatPrice, formatTimeLabel } from "./format";

describe("formatPrice", () => {
  it("formats_tiny_tick_prices", () => {
    expect(formatPrice(1234, 8)).toBe("0.00001234");
  });
  it("formats large prices with thin space", () => {
    expect(formatPrice(123456789, 2)).toBe("1 234 567.89");
  });
  it("handles scale 0, zero and negatives", () => {
    expect(formatPrice(1234567, 0)).toBe("1 234 567");
    expect(formatPrice(0, 2)).toBe("0.00");
    expect(formatPrice(-123456, 2)).toBe("-1 234.56");
    expect(formatPrice(-5, 3)).toBe("-0.005");
  });
  it("is exact beyond 2^31 and near 2^53", () => {
    expect(formatPrice(9007199254740991, 2)).toBe("90 071 992 547 409.91");
  });
});

describe("formatTimeLabel", () => {
  const t = (s: string) => Date.parse(s);
  it("time labels switch to date at midnight", () => {
    expect(formatTimeLabel(t("2026-11-27T10:15:00Z"), "15m", t("2026-11-27T10:00:00Z"))).toBe("10:15");
    expect(formatTimeLabel(t("2026-11-28T00:00:00Z"), "1h", t("2026-11-27T23:00:00Z"))).toBe("28 Nov");
  });
  it("shows the year when it changes", () => {
    expect(formatTimeLabel(t("2027-01-01T00:00:00Z"), "1h", t("2026-12-31T23:00:00Z"))).toBe("2027");
    expect(formatTimeLabel(t("2027-01-01T00:00:00Z"), "1d", t("2026-12-31T00:00:00Z"))).toBe("2027");
  });
  it("daily and above show month on change", () => {
    expect(formatTimeLabel(t("2026-12-01T00:00:00Z"), "1d", t("2026-11-30T00:00:00Z"))).toBe("Dec");
    expect(formatTimeLabel(t("2026-11-05T00:00:00Z"), "1d", t("2026-11-04T00:00:00Z"))).toBe("5");
    expect(formatTimeLabel(t("2026-05-01T00:00:00Z"), "1M", t("2026-04-01T00:00:00Z"))).toBe("May");
  });
  it("first label has no previous", () => {
    expect(formatTimeLabel(t("2026-11-27T10:15:00Z"), "15m", null)).toBe("10:15");
  });
});
