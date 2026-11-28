import { describe, expect, it } from "vitest";
import type { Alert, Instrument } from "../backend/types";
import { AlertLevelLayer, alertLevels, levelAt } from "./alerts";
import { Coords } from "./drawings/geometry";
import { PriceScale } from "./scale";
import { dark } from "./theme";

const inst: Instrument = { id: { source: "mock", symbol: "BTCUSDT" }, base: "BTC", quote: "USDT", priceScale: 2, qtyScale: 3 };

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id,
    instrument: inst.id,
    priceScale: 2,
    kind: { kind: "price", price: 10_000 },
    direction: "cross",
    active: true,
    createdAt: 0,
    triggeredAt: null,
    triggeredPrice: null,
    ...over,
  };
}

describe("alert levels on the chart", () => {
  it("are the active price alerts of the chart's pair, at its tick size", () => {
    const list = [
      alert("a"),
      alert("fired", { active: false, triggeredAt: 1, triggeredPrice: 10_001 }),
      alert("line", { kind: { kind: "drawing", drawingId: "h1" } }),
      alert("other", { instrument: { source: "mock", symbol: "ETHUSDT" } }),
      // Set before the tick size changed: 100.5 at scale 1 is 10050 at scale 2.
      alert("coarse", { priceScale: 1, kind: { kind: "price", price: 1_005 } }),
      // At a finer scale it is rounded half away from zero, like the engine's rescale.
      alert("fine", { priceScale: 3, kind: { kind: "price", price: -100_005 } }),
    ];
    expect(alertLevels(list, inst)).toEqual([
      { id: "a", price: 10_000 },
      { id: "coarse", price: 10_050 },
      { id: "fine", price: -10_001 },
    ]);
    expect(alertLevels(list, null)).toEqual([]);
  });

  it("are hit within a few pixels of their line, the closest first", () => {
    const levels = [
      { id: "a", price: 100 },
      { id: "b", price: 103 },
    ];
    const y = (p: number) => 1_000 - p;
    expect(levelAt(levels, y, 900)).toBe("a");
    expect(levelAt(levels, y, 896)).toBe("b");
    expect(levelAt(levels, y, 899)).toBe("a");
    expect(levelAt(levels, y, 904)).toBe("a");
    expect(levelAt(levels, y, 905)).toBeNull();
    expect(levelAt(levels, y, 880)).toBeNull();
    expect(levelAt([], y, 900)).toBeNull();
  });
});

/** A 2D context that accepts every call and does nothing. */
const ctx = new Proxy({} as CanvasRenderingContext2D, {
  get: (_t, key) => (key === "measureText" ? () => ({ width: 10 }) : () => undefined),
  set: () => true,
});
(globalThis as { Path2D?: unknown }).Path2D ??= class {};

describe("dragging an alert level", () => {
  // Price p ticks at y = 1000 - p / 20 on a 1000 px plot from 0 to 20 000 ticks.
  const times = new Float64Array([0, 1, 2]);
  const ohlc = { open: [0, 0, 0], high: [0, 0, 0], low: [0, 0, 0], close: [0, 0, 0] };
  const c = new Coords(times, 3, { barWidth: 10, rightIndex: 2 }, new PriceScale(0, 20_000, 1000, "linear"), 1000, 1000, 1, 2, ohlc);

  function layer() {
    const l = new AlertLevelLayer();
    l.set([alert("a"), alert("b", { kind: { kind: "price", price: 15_000 } })]);
    l.paintBase(ctx, c, 1, dark, inst);
    return l;
  }

  it("moves the level while dragged and gives the new price on release", () => {
    const l = layer();
    expect(l.hit(100, 500)).toBe("a");
    l.startDrag("a");
    l.moveDrag(12_340);
    l.paintBase(ctx, c, 1, dark, inst);
    expect(l.axisPrices()).toEqual([12_340, 15_000]);
    expect(l.endDrag()).toEqual({ id: "a", price: 12_340 });
    // Until the alert comes back at its new price it stays there, not at the old one.
    l.paintBase(ctx, c, 1, dark, inst);
    expect(l.axisPrices()).toEqual([12_340, 15_000]);
    l.set([alert("a", { kind: { kind: "price", price: 12_340 } }), alert("b", { kind: { kind: "price", price: 15_000 } })]);
    l.paintBase(ctx, c, 1, dark, inst);
    expect(l.axisPrices()).toEqual([12_340, 15_000]);
  });

  it("gives nothing for a press without a move, and goes back when the change failed", () => {
    const l = layer();
    l.startDrag("a");
    expect(l.endDrag()).toBeNull();
    l.startDrag("a");
    l.moveDrag(11_000);
    expect(l.endDrag()).not.toBeNull();
    // The change failed: the list read back still has the old price.
    l.settled();
    l.set([alert("a"), alert("b", { kind: { kind: "price", price: 15_000 } })]);
    l.paintBase(ctx, c, 1, dark, inst);
    expect(l.axisPrices()).toEqual([10_000, 15_000]);
  });
});
