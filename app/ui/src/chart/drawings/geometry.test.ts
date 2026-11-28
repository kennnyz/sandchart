import { describe, expect, it } from "vitest";
import { PriceScale } from "../scale";
import {
  Coords,
  MAX_TICKS,
  addSteps,
  stepsBetween,
  clipLine,
  distToLine,
  distToRect,
  distToSegment,
  douglasPeucker,
  simplifyToLimit,
  indexToTime,
  insideRect,
  timeToIndex,
} from "./geometry";

const H = 3_600_000;
/** Hourly bars at 0, 1h, 2h and, after a gap, 5h. */
const times = new Float64Array([0, H, 2 * H, 5 * H, 0, 0]);
const COUNT = 4;

describe("timeToIndex / indexToTime", () => {
  it("lands on the bar for its open time", () => {
    expect(timeToIndex(times, COUNT, H, 0)).toBe(0);
    expect(timeToIndex(times, COUNT, H, 2 * H)).toBe(2);
    expect(timeToIndex(times, COUNT, H, 5 * H)).toBe(3);
  });

  it("is fractional inside a bar, also across a gap", () => {
    expect(timeToIndex(times, COUNT, H, H / 2)).toBeCloseTo(0.5);
    // 2h..5h is one bar step on the chart.
    expect(timeToIndex(times, COUNT, H, 3.5 * H)).toBeCloseTo(2.5);
  });

  it("extrapolates by the timeframe step outside the loaded bars", () => {
    expect(timeToIndex(times, COUNT, H, -3 * H)).toBe(-3);
    expect(timeToIndex(times, COUNT, H, 7 * H)).toBe(5);
    expect(indexToTime(times, COUNT, H, -2)).toBe(-2 * H);
    expect(indexToTime(times, COUNT, H, 4.5)).toBe(6.5 * H);
  });

  it("round-trips", () => {
    for (const t of [-5 * H, 0, 0.25 * H, 2 * H, 4 * H, 5 * H, 9.75 * H]) {
      expect(indexToTime(times, COUNT, H, timeToIndex(times, COUNT, H, t))).toBeCloseTo(t, 3);
    }
  });

  it("works with one bar and gives NaN without bars", () => {
    expect(timeToIndex(times, 1, H, 2 * H)).toBe(2);
    expect(indexToTime(times, 1, H, -1)).toBe(-H);
    expect(timeToIndex(times, 0, H, 0)).toBeNaN();
    expect(indexToTime(times, 0, H, 0)).toBeNaN();
  });
});

describe("calendar months (1M)", () => {
  const utc = (y: number, m: number, d = 1, h = 0) => Date.UTC(y, m - 1, d, h);
  // Monthly bars open on the 1st: November 2025 to February 2026.
  const months = new Float64Array([utc(2025, 11), utc(2025, 12), utc(2026, 1), utc(2026, 2)]);

  it("adds whole and partial months of the right length", () => {
    expect(addSteps(utc(2026, 2), 1, "month")).toBe(utc(2026, 3));
    expect(addSteps(utc(2026, 2), 20, "month")).toBe(utc(2027, 10));
    expect(addSteps(utc(2026, 1), -2, "month")).toBe(utc(2025, 11));
    // Half of February 2026 (28 days) is 14 days; half of March is 15.5 days.
    expect(addSteps(utc(2026, 2), 0.5, "month")).toBe(utc(2026, 2, 15));
    expect(addSteps(utc(2026, 2), 1.5, "month")).toBe(utc(2026, 3, 16, 12));
    // The 31st into a 30-day month stays in that month.
    expect(addSteps(utc(2026, 1, 31), 1, "month")).toBe(utc(2026, 2, 28));
    expect(addSteps(utc(2026, 1, 31), 3, "month")).toBe(utc(2026, 4, 30));
    // A fixed step stays fixed.
    expect(addSteps(0, 2.5, 7 * 24 * H)).toBe(2.5 * 7 * 24 * H);
  });

  it("counts months between two times, the inverse of addSteps", () => {
    expect(stepsBetween(utc(2026, 2), utc(2027, 10), "month")).toBe(20);
    expect(stepsBetween(utc(2026, 2), utc(2026, 3, 16, 12), "month")).toBeCloseTo(1.5, 9);
    expect(stepsBetween(utc(2026, 2), utc(2025, 12, 16, 12), "month")).toBeCloseTo(-1.5, 9);
    for (const n of [-13.25, -1, 0, 0.3, 11.9, 40]) {
      expect(stepsBetween(utc(2026, 2), addSteps(utc(2026, 2), n, "month"), "month")).toBeCloseTo(n, 6);
    }
  });

  it("extrapolates by calendar months outside the loaded bars", () => {
    expect(indexToTime(months, 4, "month", 4)).toBe(utc(2026, 3));
    expect(indexToTime(months, 4, "month", 9)).toBe(utc(2026, 8));
    expect(indexToTime(months, 4, "month", -1)).toBe(utc(2025, 10));
    expect(timeToIndex(months, 4, "month", utc(2026, 8))).toBe(9);
    expect(timeToIndex(months, 4, "month", utc(2025, 10))).toBe(-1);
    expect(timeToIndex(months, 4, "month", utc(2026, 3, 16, 12))).toBeCloseTo(4.5, 9);
  });
});

describe("Coords", () => {
  const view = { barWidth: 10, rightIndex: 3 };
  const lin = new Coords(times, COUNT, view, new PriceScale(1000, 2000, 500, "linear"), 400, 500, H);

  it("maps time to x and back", () => {
    // The last bar sits at the right edge.
    expect(lin.x(5 * H)).toBe(400);
    expect(lin.x(2 * H)).toBe(390);
    expect(lin.t(390)).toBe(2 * H);
    expect(lin.t(395)).toBe(3.5 * H);
    expect(lin.t(420)).toBe(7 * H);
    expect(Number.isInteger(lin.t(391.3))).toBe(true);
  });

  it("maps ticks to y and back, rounding to whole ticks", () => {
    expect(lin.y(2000)).toBe(0);
    expect(lin.y(1500)).toBe(250);
    expect(lin.p(250)).toBe(1500);
    expect(lin.p(250.2)).toBe(1500);
  });

  it("uses the log scale", () => {
    const log = new Coords(times, COUNT, view, new PriceScale(100, 10_000, 400, "log"), 400, 400, H);
    expect(log.y(1000)).toBeCloseTo(200);
    expect(log.p(200)).toBe(1000);
    // Never below one tick on a log scale.
    expect(log.p(10_000)).toBeGreaterThanOrEqual(1);
  });

  it("gives fractional bar indices, bar times and the bar under x", () => {
    expect(lin.index(2 * H)).toBe(2);
    expect(lin.index(3.5 * H)).toBeCloseTo(2.5);
    expect(lin.timeAt(3)).toBe(5 * H);
    expect(lin.timeAt(4)).toBe(6 * H);
    expect(lin.barAt(390)).toBe(2);
    expect(lin.barAt(394)).toBe(2);
    expect(lin.barAt(396)).toBe(3);
    // Half a bar past the last one and beyond: no bar.
    expect(lin.barAt(404)).toBe(3);
    expect(lin.barAt(406)).toBe(-1);
    expect(lin.barAt(366)).toBe(0);
    expect(lin.barAt(364)).toBe(-1);
  });

  it("reads the prices of a bar when it has them", () => {
    expect(lin.prices(1)).toBeNull();
    const ohlc = { open: [10, 20, 30, 40], high: [15, 25, 35, 45], low: [5, 15, 25, 35], close: [12, 22, 32, 42] };
    const withBars = new Coords(times, COUNT, view, new PriceScale(1000, 2000, 500, "linear"), 400, 500, H, 2, ohlc);
    expect(withBars.decimals).toBe(2);
    expect(withBars.prices(1)).toEqual([20, 25, 15, 22]);
    expect(withBars.prices(4)).toBeNull();
    expect(withBars.prices(-1)).toBeNull();
  });

  it("clamps ticks to the safe integer range", () => {
    const huge = new Coords(times, COUNT, view, new PriceScale(0, 4e15, 1, "linear"), 400, 1, H);
    expect(huge.p(-1e6)).toBe(MAX_TICKS);
    expect(huge.p(1e6)).toBe(-MAX_TICKS);
  });
});

describe("distances", () => {
  it("to a segment", () => {
    expect(distToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distToSegment(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(distToSegment(-3, -4, 0, 0, 10, 0)).toBe(5);
    // A zero-length segment is a point.
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBe(5);
  });

  it("to a ray or a line, by the extend flags of each end", () => {
    expect(distToLine(20, 1, 0, 0, 10, 0, false, false)).toBeCloseTo(Math.hypot(10, 1));
    expect(distToLine(20, 1, 0, 0, 10, 0, false, true)).toBeCloseTo(1);
    expect(distToLine(-20, 1, 0, 0, 10, 0, false, true)).toBeCloseTo(Math.hypot(20, 1));
    expect(distToLine(-20, 1, 0, 0, 10, 0, true, false)).toBeCloseTo(1);
    expect(distToLine(-20, 1, 0, 0, 10, 0, true, true)).toBeCloseTo(1);
  });

  it("to a rectangle's edges and inside it", () => {
    expect(distToRect(5, 5, 0, 0, 10, 20)).toBe(5);
    expect(distToRect(5, 18, 10, 20, 0, 0)).toBe(2);
    expect(distToRect(15, 25, 0, 0, 10, 20)).toBeCloseTo(Math.hypot(5, 5));
    expect(insideRect(5, 5, 10, 20, 0, 0)).toBe(true);
    expect(insideRect(11, 5, 0, 0, 10, 20)).toBe(false);
  });
});

describe("clipLine", () => {
  it("clips a segment to the box", () => {
    expect(clipLine(-10, 5, 30, 5, false, false, 20, 10)).toEqual([0, 5, 20, 5]);
    expect(clipLine(2, 2, 4, 4, false, false, 20, 10)).toEqual([2, 2, 4, 4]);
  });

  it("extends a ray to the box edge", () => {
    expect(clipLine(2, 2, 4, 4, false, true, 20, 10)).toEqual([2, 2, 10, 10]);
    expect(clipLine(2, 2, 4, 4, true, false, 20, 10)).toEqual([0, 0, 4, 4]);
  });

  it("gives null when nothing is in the box", () => {
    expect(clipLine(30, 30, 40, 40, false, false, 20, 10)).toBeNull();
    expect(clipLine(30, 30, 40, 40, true, false, 20, 10)).not.toBeNull();
    expect(clipLine(5, 5, 5, 5, true, true, 20, 10)).toBeNull();
  });
});

describe("douglasPeucker", () => {
  it("keeps the ends and the corners only", () => {
    const xs = [0, 1, 2, 3, 4, 4, 4];
    const ys = [0, 0.1, -0.1, 0, 0, 2, 4];
    expect(douglasPeucker(xs, ys, 0.5)).toEqual([0, 4, 6]);
  });

  it("keeps everything with a zero tolerance on a curve, and handles short input", () => {
    expect(douglasPeucker([0, 1, 2], [0, 1, 0], 0)).toEqual([0, 1, 2]);
    expect(douglasPeucker([1], [1], 1)).toEqual([0]);
    expect(douglasPeucker([], [], 1)).toEqual([]);
  });

  it("does not recurse on long paths", () => {
    const n = 50_000;
    const xs = Array.from({ length: n }, (_, i) => i);
    const ys = xs.map((i) => Math.sin(i / 50) * 100);
    const kept = douglasPeucker(xs, ys, 1);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(n - 1);
    expect(kept.length).toBeLessThan(n / 10);
  });
});

describe("simplifyToLimit", () => {
  it("keeps a short path as it is", () => {
    expect(simplifyToLimit([0, 1, 2], [0, 5, 0], 500)).toEqual([0, 1, 2]);
  });

  it("drops points within the tolerance", () => {
    const xs = Array.from({ length: 101 }, (_, i) => i);
    const ys = xs.map((i) => (i % 2) * 0.4);
    expect(simplifyToLimit(xs, ys, 500)).toEqual([0, 100]);
  });

  it("raises the tolerance until the path fits the limit", () => {
    const n = 20_000;
    const xs = Array.from({ length: n }, (_, i) => i / 10);
    // A wiggle far above 1 px: the first tolerance keeps far more than 500 points.
    const ys = xs.map((_, i) => Math.sin(i / 3) * 40 + (i % 7) * 3);
    expect(douglasPeucker(xs, ys, 1).length).toBeGreaterThan(500);
    const kept = simplifyToLimit(xs, ys, 500);
    expect(kept.length).toBeLessThanOrEqual(500);
    expect(kept.length).toBeGreaterThan(50);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(n - 1);
  });
});
