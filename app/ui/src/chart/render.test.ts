import { describe, expect, it } from "vitest";
import type { SeriesSpec } from "../backend/types";
import { formatPrice } from "./format";
import type { IndicatorLayer } from "./indicators";
import { draw, drawOverlay, priceAxisWidth, RenderBuffers, type FrameInput, type Series } from "./render";
import type { IndicatorFrame } from "./renderIndicators";
import { PriceScale } from "./scale";
import { dark } from "./theme";
import { xToIndex } from "./viewport";

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

function flatSeries(n: number): Series {
  return {
    time: Float64Array.from({ length: n }, (_, i) => i * 3_600_000),
    open: Float64Array.from({ length: n }, () => 100),
    high: Float64Array.from({ length: n }, () => 120),
    low: Float64Array.from({ length: n }, () => 90),
    close: Float64Array.from({ length: n }, () => 110),
    volume: Float64Array.from({ length: n }, () => 5),
    count: n,
  };
}

function frame(ctx: CanvasRenderingContext2D): FrameInput {
  const n = 200;
  return {
    ctx,
    dpr: 1,
    width: 500,
    height: 426,
    axisWidth: 72,
    series: flatSeries(n),
    view: { barWidth: 10, rightIndex: n - 1 },
    scale: new PriceScale(80, 130, 400, "linear"),
    priceDecimals: 0,
    tf: "1h",
    historyStart: null,
    theme: dark,
    indicators: null,
  };
}

describe("priceAxisWidth", () => {
  it("fits the crosshair label at the top of the scale without a mouse", () => {
    const { ctx } = recordingCtx();
    // Every tick is at most "9 950"; the crosshair at the very top reads "10 000".
    const scale = new PriceScale(9901, 9999.6, 120, "linear");
    const axis = priceAxisWidth(ctx, new RenderBuffers(), 1, scale, 0, NaN);
    expect(axis.widestText).toBe(formatPrice(10_000, 0));
  });
});

describe("overlay", () => {
  it("base frame draws no crosshair and every tick label", () => {
    const { ctx, ops } = recordingCtx();
    const buf = new RenderBuffers();
    draw(frame(ctx), buf);
    expect(ops).not.toContain(`set:fillStyle=${dark.crosshairLabelBg}`);
    expect(buf.priceLabelCount).toBeGreaterThan(0);
    expect(buf.timeLabelCount).toBeGreaterThan(0);
  });

  it("clears, draws the lines and covers the tick labels under the crosshair labels", () => {
    const base = recordingCtx();
    const buf = new RenderBuffers();
    const f = frame(base.ctx);
    draw(f, buf);
    const tickY = buf.priceLabelY[0]!;
    const tickX = buf.timeLabelX[0]!;
    const { ctx, ops } = recordingCtx();
    drawOverlay(f, ctx, { x: tickX, y: tickY + 3, index: Math.round(xToIndex(f.view, tickX, 428)) }, buf);
    expect(ops[0]).toBe("call:setTransform");
    expect(ops).toContain("call:clearRect");
    expect(ops).toContain("call:stroke");
    const cover = ops.indexOf(`set:fillStyle=${dark.bg}`);
    const label = ops.indexOf(`set:fillStyle=${dark.crosshairLabelBg}`);
    expect(cover).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(cover);
    expect(ops.filter((o) => o === "call:fillText")).toHaveLength(2);
  });

  it("only clears when there is no crosshair", () => {
    const base = recordingCtx();
    const buf = new RenderBuffers();
    const f = frame(base.ctx);
    draw(f, buf);
    const { ctx, ops } = recordingCtx();
    drawOverlay(f, ctx, null, buf);
    expect(ops).toContain("call:clearRect");
    expect(ops).not.toContain("call:stroke");
    expect(ops).not.toContain("call:fillText");
  });
});
