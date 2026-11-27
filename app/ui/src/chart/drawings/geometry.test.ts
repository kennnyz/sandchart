import { describe, expect, it } from "vitest";
import { PriceScale } from "../scale";
import {
  Coords,
  MAX_TICKS,
  clipLine,
  distToLine,
  distToRect,
  distToSegment,
  douglasPeucker,
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
    expect(lin.visibleTimes()).toEqual([lin.t(0), lin.t(400)]);
  });

  it("uses the log scale", () => {
    const log = new Coords(times, COUNT, view, new PriceScale(100, 10_000, 400, "log"), 400, 400, H);
    expect(log.y(1000)).toBeCloseTo(200);
    expect(log.p(200)).toBe(1000);
    // Never below one tick on a log scale.
    expect(log.p(10_000)).toBeGreaterThanOrEqual(1);
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
