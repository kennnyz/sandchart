import { describe, expect, it } from "vitest";
import { indexToX, panBy, visibleRange, xToIndex, zoomAt, type Viewport } from "./viewport";

const v: Viewport = { barWidth: 10, rightIndex: 99 };

describe("viewport", () => {
  it("indexToX and xToIndex are inverse", () => {
    expect(xToIndex(v, indexToX(v, 42.5, 800), 800)).toBeCloseTo(42.5, 9);
    expect(indexToX(v, 99, 800)).toBe(800);
  });

  it("zoom keeps the anchor index", () => {
    const before = xToIndex(v, 300, 800);
    const z = zoomAt(v, 300, 800, 1.7);
    expect(z.barWidth).toBeCloseTo(17, 9);
    expect(xToIndex(z, 300, 800)).toBeCloseTo(before, 9);
  });

  it("zoom clamps bar width", () => {
    expect(zoomAt(v, 100, 800, 1000).barWidth).toBe(60);
    expect(zoomAt(v, 100, 800, 0.0001).barWidth).toBe(1);
  });

  it("pan moves right index by dx / barWidth", () => {
    // dragging right reveals older bars
    expect(panBy(v, 50).rightIndex).toBeCloseTo(94, 9);
    expect(panBy(v, -25).rightIndex).toBeCloseTo(101.5, 9);
  });

  it("visible range clamps to data", () => {
    expect(visibleRange({ barWidth: 10, rightIndex: 99 }, 300, 100)).toEqual([69, 99]);
    expect(visibleRange({ barWidth: 10, rightIndex: 20 }, 300, 100)).toEqual([0, 20]);
    expect(visibleRange({ barWidth: 10, rightIndex: 500 }, 300, 100)).toEqual([99, 99]);
    expect(visibleRange(v, 300, 0)).toEqual([0, -1]);
  });
});
