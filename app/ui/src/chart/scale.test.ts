import { describe, expect, it } from "vitest";
import { PriceScale, autoscale } from "./scale";

describe("PriceScale", () => {
  it("maps linear prices top-down", () => {
    const s = new PriceScale(100, 200, 500, "linear");
    expect(s.toY(200)).toBe(0);
    expect(s.toY(100)).toBe(500);
    expect(s.toY(150)).toBe(250);
  });

  it("log scale round-trips", () => {
    const s = new PriceScale(1234, 98_000_000, 731, "log");
    for (const p of [1234, 5000, 77_777, 1_000_000, 98_000_000]) {
      const back = s.fromY(s.toY(p));
      expect(Math.abs(back - p) / p).toBeLessThan(1e-9);
    }
  });

  it("linear scale round-trips", () => {
    const s = new PriceScale(10, 90, 400, "linear");
    expect(s.fromY(s.toY(37))).toBeCloseTo(37, 9);
  });

  it("ticks are nice numbers inside the range", () => {
    const s = new PriceScale(103, 497, 400, "linear");
    const t = s.ticks(6);
    expect(t).toEqual([200, 300, 400]);
  });

  it("log ticks stay in range and ascend", () => {
    const s = new PriceScale(100, 100_000, 400, "log");
    const t = s.ticks(8);
    expect(t.length).toBeGreaterThan(1);
    expect(t.length).toBeLessThanOrEqual(8);
    for (let i = 0; i < t.length; i++) {
      expect(t[i]!).toBeGreaterThanOrEqual(100);
      expect(t[i]!).toBeLessThanOrEqual(100_000);
      if (i > 0) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    }
  });
});

describe("autoscale", () => {
  it("pads 8%", () => {
    const lows = [10, 20, 5, 30];
    const highs = [110, 120, 105, 130];
    const [lo, hi] = autoscale(lows, highs, [1, 2]);
    // min low 20.., range [1,2]: lows 20,5 -> 5; highs 120,105 -> 120
    expect(lo).toBeCloseTo(5 - 115 * 0.08, 9);
    expect(hi).toBeCloseTo(120 + 115 * 0.08, 9);
  });

  it("handles a flat range", () => {
    const [lo, hi] = autoscale(new Float64Array([50]), new Float64Array([50]), [0, 0]);
    expect(lo).toBeLessThan(50);
    expect(hi).toBeGreaterThan(50);
  });
});
