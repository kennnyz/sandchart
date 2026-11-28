import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBackend } from "../backend/mock";
import type { Drawing } from "../backend/types";
import { AlertController, TOAST_MS } from "./alerts";

const id = { source: "mock", symbol: "BTCUSDT" };
const candle = (time: number, low: number, high: number, close: number) =>
  ({ kind: "candle", time, open: close, high, low, close, volume: 1, closed: false }) as const;
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const backend = createMockBackend({ candles: 1 });
  let n = 0;
  const changes = { count: 0 };
  const c = new AlertController(backend, () => changes.count++, () => `a${++n}`);
  const stop = c.start();
  return { backend, c, stop, changes };
}

describe("AlertController", () => {
  afterEach(() => vi.useRealTimers());

  it("creates a price alert, shows the toast when it fires and keeps it highlighted until seen", async () => {
    const { backend, c, stop } = setup();
    await flush();
    await c.createPrice(id, 2, 10_000);
    expect(c.list).toMatchObject([{ id: "a1", active: true, direction: "cross", kind: { kind: "price", price: 10_000 } }]);
    const unsub = await backend.subscribeLive(id, "1h", () => {});
    backend.emitLive(candle(0, 9_900, 9_950, 9_950));
    backend.emitLive(candle(0, 9_900, 10_020, 10_010));
    expect(c.toast?.id).toBe("a1");
    expect(c.unseen.has("a1")).toBe(true);
    await flush();
    expect(c.list[0]).toMatchObject({ active: false, triggeredPrice: 10_010 });

    c.seen("a1");
    expect(c.unseen.size).toBe(0);
    c.dismissToast();
    expect(c.toast).toBeNull();
    await c.rearm("a1");
    expect(c.list[0]!.active).toBe(true);
    await c.remove("a1");
    expect(c.list).toEqual([]);
    unsub();
    stop();
  });

  it("closes the toast by itself", async () => {
    vi.useFakeTimers();
    const { backend, c, stop } = setup();
    await c.createPrice(id, 2, 10_000, "above");
    await backend.subscribeLive(id, "1h", () => {});
    backend.emitLive(candle(0, 9_900, 9_950, 9_950));
    backend.emitLive(candle(0, 9_900, 10_020, 10_010));
    expect(c.toast).not.toBeNull();
    vi.advanceTimersByTime(TOAST_MS);
    expect(c.toast).toBeNull();
    // Still unseen: the panel keeps the highlight.
    expect(c.unseen.has("a1")).toBe(true);
    stop();
  });

  it("sets one alert per drawing, after the drawing is stored, and keeps the error of a refused one", async () => {
    const { backend, c, stop } = setup();
    const d: Drawing = {
      id: "h1",
      instrument: id,
      priceScale: 2,
      body: { kind: "hline", p: 10_000 },
      style: { color: 0, width: 1, dash: false },
      locked: false,
      hidden: false,
      z: 0,
      updatedAt: 0,
    };
    let store!: () => void;
    const saved = new Promise<void>((r) => (store = r));
    const set = c.setForDrawing(d, "above", saved.then(() => backend.saveDrawing(d)).then(() => {}));
    store();
    await set;
    expect(c.forDrawing("h1")).toMatchObject({ id: "a1", direction: "above" });
    await c.setForDrawing(d, "below");
    expect(c.list).toHaveLength(1);
    expect(c.forDrawing("h1")).toMatchObject({ id: "a1", direction: "below" });
    expect(c.error).toBeNull();

    await c.setForDrawing({ ...d, id: "gone" }, "cross");
    expect(c.error).toBe("drawing gone does not exist");
    // The list follows a drawing deleted elsewhere.
    await backend.deleteDrawing("h1");
    await flush();
    await flush();
    expect(c.list).toEqual([]);
    stop();
  });

  it("tells the view once per change, and keeps a refused change's error until dismissed or a change succeeds", async () => {
    const { c, stop, changes } = setup();
    await flush();
    changes.count = 0;
    await c.createPrice(id, 2, 10_000);
    expect(changes.count).toBe(1);

    changes.count = 0;
    await c.rearm("nope");
    expect(changes.count).toBe(1);
    expect(c.error).toBe('no alert "nope"');
    c.dismissError();
    expect(c.error).toBeNull();
    expect(changes.count).toBe(2);
    c.dismissError();
    expect(changes.count).toBe(2);

    await c.rearm("nope");
    await c.createPrice(id, 2, 10_100);
    expect(c.error).toBeNull();
    stop();
  });

  it("selects an alert picked on the chart until it is gone", async () => {
    const { c, stop, changes } = setup();
    await c.createPrice(id, 2, 10_000);
    changes.count = 0;
    c.select("a1");
    expect(c.selected).toBe("a1");
    expect(changes.count).toBe(1);
    c.select("a1");
    expect(changes.count).toBe(1);
    await c.remove("a1");
    expect(c.selected).toBeNull();
    stop();
  });
});
