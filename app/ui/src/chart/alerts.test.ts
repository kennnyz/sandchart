import { describe, expect, it } from "vitest";
import type { Alert, Instrument } from "../backend/types";
import { alertLevels, levelAt } from "./alerts";

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
