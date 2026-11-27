import { describe, expect, it } from "vitest";
import type { IndicatorMeta, SeriesSpec } from "../backend/types";
import { alignOffset, layoutPanes, overlayRange, paneRange, type IndicatorLayer } from "./indicators";

function layer(series: [SeriesSpec, number[]][]): IndicatorLayer {
  const meta: IndicatorMeta = {
    id: "builtin.test",
    name: "Test",
    version: "1.0.0",
    description: "",
    params: [],
    series: series.map(([s]) => s),
  };
  return {
    instance: "t1",
    meta,
    colors: {},
    computed: {
      firstTime: 0,
      lastTime: 0,
      series: series.map(([s, v]) => ({ id: s.id, data: { values: Float64Array.from(v) } })),
      log: "",
    },
    error: null,
    repaints: false,
  };
}

const priceLine = (id: string): SeriesSpec => ({ id, label: id, kind: "line", pane: "price", color: 0 });

describe("alignOffset", () => {
  const time = new Float64Array([100, 200, 300, 400, 500, 0, 0]);

  it("finds the bar with firstTime", () => {
    expect(alignOffset(time, 5, 100)).toBe(0);
    expect(alignOffset(time, 5, 300)).toBe(2);
    expect(alignOffset(time, 5, 500)).toBe(4);
  });

  it("returns null when firstTime is missing or past count", () => {
    expect(alignOffset(time, 5, 250)).toBeNull();
    expect(alignOffset(time, 5, 50)).toBeNull();
    expect(alignOffset(time, 5, 600)).toBeNull();
    expect(alignOffset(time, 0, 100)).toBeNull();
    // Slots past `count` are not bars.
    expect(alignOffset(time, 3, 400)).toBeNull();
  });
});

describe("layoutPanes", () => {
  it("no own panes keeps the whole plot for price", () => {
    expect(layoutPanes(600, 0)).toEqual({ priceH: 600, panes: [] });
  });

  it("one pane is 120 px under the price plot", () => {
    expect(layoutPanes(600, 1)).toEqual({ priceH: 480, panes: [{ top: 480, height: 120 }] });
  });

  it("five panes on 600 px share 60 % and price keeps 40 %", () => {
    const { priceH, panes } = layoutPanes(600, 5);
    expect(priceH).toBe(240);
    expect(panes.map((p) => p.height)).toEqual([72, 72, 72, 72, 72]);
    expect(panes.map((p) => p.top)).toEqual([240, 312, 384, 456, 528]);
    expect(priceH).toBeGreaterThanOrEqual(0.4 * 600);
  });

  it("never gives a negative height", () => {
    for (const [h, n] of [[100, 3], [0, 2], [1, 7], [5, 1]] as const) {
      const { priceH, panes } = layoutPanes(h, n);
      expect(priceH).toBeGreaterThanOrEqual(0);
      for (const p of panes) {
        expect(p.height).toBeGreaterThanOrEqual(0);
        expect(p.top + p.height).toBeLessThanOrEqual(h);
      }
    }
  });
});

describe("overlayRange", () => {
  it("ignores NaN and Infinity and scales by the price multiplier", () => {
    const l = layer([[priceLine("a"), [NaN, 1.5, Infinity, 2.25, -Infinity, 9]]]);
    // Visible bars 0..3 only: 9 at index 5 is off screen.
    expect(overlayRange([l], [0], 0, 4, 100)).toEqual([150, 225]);
  });

  it("returns null when every visible value is NaN", () => {
    const l = layer([[priceLine("a"), [NaN, NaN, NaN]]]);
    expect(overlayRange([l], [0], 0, 2, 100)).toBeNull();
  });

  it("skips own-pane series, histograms, errored and unaligned layers", () => {
    const own: SeriesSpec = { id: "o", label: "o", kind: "line", pane: "own", color: 0 };
    const hist: SeriesSpec = { id: "h", label: "h", kind: "histogram", pane: "price", color: 0 };
    const l = layer([[own, [1000]], [hist, [-1000]], [priceLine("a"), [5]]]);
    const failed = { ...layer([[priceLine("a"), [7]]]), error: "boom" };
    const unaligned = layer([[priceLine("a"), [8]]]);
    expect(overlayRange([l, failed, unaligned], [0, 0, null], 0, 0, 1)).toEqual([5, 5]);
  });

  it("maps values through the offset", () => {
    const l = layer([[priceLine("a"), [1, 2, 3]]]);
    // Value k sits at chart index 10 + k: visible 11..20 sees values 2 and 3.
    expect(overlayRange([l], [10], 11, 20, 1)).toEqual([2, 3]);
  });
});

describe("paneRange", () => {
  it("histograms include 0", () => {
    const hist: SeriesSpec = { id: "h", label: "h", kind: "histogram", pane: "own", color: 0 };
    expect(paneRange(layer([[hist, [1, 2]]]), 0, 0, 1)).toEqual([0, 2]);
  });

  it("lines cover their finite values only", () => {
    const own: SeriesSpec = { id: "o", label: "o", kind: "line", pane: "own", color: 0 };
    expect(paneRange(layer([[own, [NaN, 30, Infinity, 70]]]), 0, 0, 3)).toEqual([30, 70]);
    expect(paneRange(layer([[own, [NaN, NaN]]]), 0, 0, 1)).toBeNull();
  });
});
