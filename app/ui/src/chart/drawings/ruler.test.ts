import { beforeAll, describe, expect, it } from "vitest";
import { setLanguage } from "../../i18n";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import { formatDuration, measure } from "./ruler";

const H = 3_600_000;
const M = 60_000;
// Hourly bars with a 3 h gap after bar 4 (as a market that closes); 10 px a bar.
const times = new Float64Array([0, H, 2 * H, 3 * H, 4 * H, 8 * H, 9 * H, 10 * H]);
const c = new Coords(times, 8, { barWidth: 10, rightIndex: 7 }, new PriceScale(0, 100_000, 1000, "linear"), 1000, 1000, H, 2);

beforeAll(() => setLanguage("en"));

describe("formatDuration", () => {
  it("shows the two largest units", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45 * M)).toBe("45m");
    expect(formatDuration(H)).toBe("1h");
    expect(formatDuration(2 * H + 15 * M)).toBe("2h 15m");
    expect(formatDuration(76 * H)).toBe("3d 4h");
    expect(formatDuration(3 * 24 * H + 20 * M)).toBe("3d");
    expect(formatDuration(400 * 24 * H)).toBe("400d");
  });

  it("rounds to whole minutes and signs a span back in time", () => {
    expect(formatDuration(89_999)).toBe("1m");
    expect(formatDuration(-26 * H)).toBe("−1d 2h");
  });
});

describe("measure", () => {
  it("gives the price change, its percentage, the bars and the time between the bars", () => {
    const m = measure({ t: H, p: 50_000 }, { t: 6 * H + 0.3 * H, p: 52_500 }, c);
    // 6:18 is in the gap after bar 4 (4:00) and rounds to bar 5 (8:00): 4 bars, 7 h after bar 1.
    expect(m).toEqual({ abs: "+25.00", pct: "+5.00%", dir: 1, bars: 4, duration: "7h" });
  });

  it("is negative from right to left and down", () => {
    const m = measure({ t: 3 * H, p: 40_000 }, { t: 0, p: 30_000 }, c);
    expect(m).toEqual({ abs: "−100.00", pct: "−25.00%", dir: -1, bars: -3, duration: "−3h" });
  });

  it("rounds a point inside a bar to that bar", () => {
    const m = measure({ t: 0.4 * H, p: 100 }, { t: 2.6 * H, p: 100 }, c);
    expect(m).toMatchObject({ abs: "0.00", dir: 0, bars: 3, duration: "3h" });
  });
});
