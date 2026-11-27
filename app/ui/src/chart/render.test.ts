import { describe, expect, it } from "vitest";
import type { SeriesSpec } from "../backend/types";
import type { IndicatorLayer } from "./indicators";
import { draw, RenderBuffers, type Series } from "./render";
import type { IndicatorFrame } from "./renderIndicators";
import { PriceScale } from "./scale";
import { dark } from "./theme";

/** A 2D context that records property writes and method calls, in order. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        ops.push(`call:${key}`);
        return key === "measureText" ? { width: String(args[0]).length * 7 } : undefined;
      };
    },
    set(_, key: string, value: unknown) {
      ops.push(`set:${key}=${String(value)}`);
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

describe("draw order", () => {
  it("draws bands under the candles and lines over them", () => {
    const n = 20;
    const series: Series = {
      time: Float64Array.from({ length: n }, (_, i) => i * 3_600_000),
      open: Float64Array.from({ length: n }, () => 100),
      high: Float64Array.from({ length: n }, () => 120),
      low: Float64Array.from({ length: n }, () => 90),
      close: Float64Array.from({ length: n }, () => 110),
      volume: Float64Array.from({ length: n }, () => 5),
      count: n,
    };
    const line = (id: string, color: number): SeriesSpec => ({ id, label: id, kind: "line", pane: "price", color });
    const layer: IndicatorLayer = {
      instance: "b",
      meta: {
        id: "builtin.bands",
        name: "Bands",
        version: "1.0.0",
        description: "",
        params: [],
        series: [
          line("upper", 0),
          line("lower", 0),
          { id: "fill", label: "fill", kind: { band: ["upper", "lower"] }, pane: "price", color: 3 },
        ],
      },
      colors: {},
      computed: {
        firstTime: 0,
        lastTime: 0,
        series: [
          { id: "upper", data: { values: new Float64Array(n).fill(115) } },
          { id: "lower", data: { values: new Float64Array(n).fill(95) } },
          { id: "fill", data: { values: new Float64Array(0) } },
        ],
        log: "",
      },
      error: null,
      repaints: false,
    };
    const indicators: IndicatorFrame = { layers: [layer], offsets: [0], tickMul: 1, priceH: 400, panes: [] };
    const { ctx, ops } = recordingCtx();
    draw(
      {
        ctx,
        dpr: 1,
        width: 500,
        height: 426,
        axisWidth: 72,
        series,
        view: { barWidth: 10, rightIndex: n - 1 },
        scale: new PriceScale(80, 130, 400, "linear"),
        priceDecimals: 0,
        tf: "1h",
        crosshair: null,
        historyStart: null,
        theme: dark,
        indicators,
      },
      new RenderBuffers(),
    );
    const band = ops.indexOf(`set:globalAlpha=${dark.bandOpacity}`);
    const candle = ops.indexOf(`set:fillStyle=${dark.upCandle.border}`);
    const lineStroke = ops.indexOf(`set:strokeStyle=${dark.indicatorPalette[0]}`);
    expect(band).toBeGreaterThan(-1);
    expect(candle).toBeGreaterThan(-1);
    expect(lineStroke).toBeGreaterThan(-1);
    expect(band).toBeLessThan(candle);
    expect(lineStroke).toBeGreaterThan(candle);
  });
});
