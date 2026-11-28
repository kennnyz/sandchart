import { describe, expect, it } from "vitest";
import { formatBp, formatChange, formatCrosshairTime, formatPrice, formatTimeLabel, formatUtcClock, formatValue, parseUtcDateTime } from "./format";

describe("formatPrice", () => {
  it("formats_tiny_tick_prices", () => {
    expect(formatPrice(1234, 8)).toBe("0.00001234");
  });
  it("formats large prices with thin space", () => {
    expect(formatPrice(123456789, 2)).toBe("1\u2009234\u2009567.89");
  });
  it("handles scale 0, zero and negatives", () => {
    expect(formatPrice(1234567, 0)).toBe("1\u2009234\u2009567");
    expect(formatPrice(0, 2)).toBe("0.00");
    expect(formatPrice(-123456, 2)).toBe("-1\u2009234.56");
    expect(formatPrice(-5, 3)).toBe("-0.005");
  });
  it("is exact beyond 2^31 and near 2^53", () => {
    expect(formatPrice(9007199254740991, 2)).toBe("90\u2009071\u2009992\u2009547\u2009409.91");
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

describe("formatCrosshairTime", () => {
  it("shows date and UTC time below a day, only the date from 1d up", () => {
    const t = Date.UTC(2026, 10, 27, 14, 5);
    expect(formatCrosshairTime(t, "1h")).toBe("27 Nov 2026 14:05");
    expect(formatCrosshairTime(t, "1d")).toBe("27 Nov 2026");
  });
});

describe("formatChange", () => {
  const M = "\u2212";
  it("keeps the sign of the change on the percentage", () => {
    expect(formatChange(150, 10_000, 2)).toEqual({ abs: "+1.50", pct: "+1.50%", dir: 1 });
    expect(formatChange(-150, 10_000, 2)).toEqual({ abs: `${M}1.50`, pct: `${M}1.50%`, dir: -1 });
  });
  it("a change too small for the percentage still shows its sign", () => {
    expect(formatChange(1, 10_000_000, 2)).toEqual({ abs: "+0.01", pct: "+0.00%", dir: 1 });
    expect(formatChange(-1, 10_000_000, 2)).toEqual({ abs: `${M}0.01`, pct: `${M}0.00%`, dir: -1 });
  });
  it("no change has no sign", () => {
    expect(formatChange(0, 10_000, 2)).toEqual({ abs: "0.00", pct: "0.00%", dir: 0 });
  });
  it("formats basis points as a signed percentage", () => {
    expect(formatBp(184)).toBe("+1.84%");
    expect(formatBp(-116)).toBe(`${M}1.16%`);
    expect(formatBp(0)).toBe("0.00%");
  });
});

describe("formatUtcClock", () => {
  const t = (s: string) => Date.parse(s);
  it("shows HH:MM on the same UTC day, with the date otherwise", () => {
    expect(formatUtcClock(t("2026-11-27T09:05:00Z"), t("2026-11-27T18:00:00Z"))).toBe("09:05");
    expect(formatUtcClock(t("2026-11-25T23:59:00Z"), t("2026-11-27T18:00:00Z"))).toBe("25 Nov 23:59");
  });
});

describe("formatValue", () => {
  it("groups the integer part and uses a real minus", () => {
    expect(formatValue(12345.678, 2)).toBe("12 345.68");
    expect(formatValue(-0.5, 2)).toBe("−0.50");
    expect(formatValue(-0.001, 2)).toBe("0.00");
    expect(formatValue(54.1, 0)).toBe("54");
  });
});

describe("parseUtcDateTime", () => {
  it("reads a UTC date with an optional time, the same in every language", () => {
    expect(parseUtcDateTime("2026-11-20")).toBe(Date.UTC(2026, 10, 20));
    expect(parseUtcDateTime(" 2026-11-20 13:45 ")).toBe(Date.UTC(2026, 10, 20, 13, 45));
    expect(parseUtcDateTime("2026-11-20T09:05")).toBe(Date.UTC(2026, 10, 20, 9, 5));
    expect(parseUtcDateTime("2024-02-29 00:00")).toBe(Date.UTC(2024, 1, 29));
  });

  it("refuses what is not a real date or time", () => {
    for (const bad of ["", "20.11.2026", "2026-11-31", "2025-02-29", "2026-13-01", "2026-11-20 24:00", "2026-11-20 12:60", "2026-11-20 7:00", "2026-11-20x"]) {
      expect(parseUtcDateTime(bad), bad).toBeNull();
    }
  });
});
