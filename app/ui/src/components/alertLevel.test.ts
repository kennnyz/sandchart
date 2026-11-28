import { describe, expect, it } from "vitest";
import type { Alert, Drawing, DrawingBody } from "../backend/types";
import type { DrawingStore } from "../state/drawings";
import { alertLevel } from "./AlertsPanel";

const id = { source: "mock", symbol: "BTCUSDT" };
const alert = (kind: Alert["kind"]): Alert => ({
  id: "a",
  instrument: id,
  priceScale: 2,
  kind,
  direction: "cross",
  active: true,
  createdAt: 0,
  triggeredAt: null,
  triggeredPrice: null,
});
const line = (body: DrawingBody): Drawing => ({
  id: "l",
  instrument: id,
  priceScale: 2,
  body,
  style: { color: 0, width: 1, dash: false },
  locked: false,
  hidden: false,
  z: 0,
  updatedAt: 0,
});
const store = (d: Drawing | undefined) => ({ state: { line: () => d } }) as unknown as DrawingStore;

describe("an alert's level in the panel", () => {
  it("is the price, or a line's price now, or 'Line' without the line", () => {
    expect(alertLevel(alert({ kind: "price", price: 12_345 }))).toBe("123.45");
    const onLine = alert({ kind: "drawing", drawingId: "l" });
    expect(alertLevel(onLine, store(line({ kind: "hline", p: 10_050 })))).toBe("100.50");
    // A trend line from 100.00 at t=0 to 200.00 at t=1000: 150.00 at t=500.
    const trend = line({ kind: "trend", a: { t: 0, p: 10_000 }, b: { t: 1000, p: 20_000 }, extendLeft: false, extendRight: false });
    expect(alertLevel(onLine, store(trend), 500)).toBe("150.00");
    // Past its end without extending right: no level now.
    expect(alertLevel(onLine, store(trend), 2000)).toBe("Line");
    expect(alertLevel(onLine, store(undefined))).toBe("Line");
    expect(alertLevel(onLine)).toBe("Line");
  });
});
