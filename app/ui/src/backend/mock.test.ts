import { describe, expect, it } from "vitest";
import { createMockBackend } from "./mock";

const id = { source: "mock", symbol: "BTCUSDT" };

describe("mock backend", () => {
  it("returns ascending pages and stops at history start", async () => {
    const b = createMockBackend({ candles: 2500 });

    const p1 = await b.getCandles(id, "1h");
    expect(p1.time).toHaveLength(1000);
    expect(p1.atHistoryStart).toBe(false);
    expect(p1.time).toEqual([...p1.time].sort((a, c) => a - c));

    const p2 = await b.getCandles(id, "1h", p1.time[0]);
    expect(p2.time).toHaveLength(1000);
    expect(p2.time.at(-1)).toBe(p1.time[0]! - 3_600_000);
    expect(p2.atHistoryStart).toBe(false);

    const p3 = await b.getCandles(id, "1h", p2.time[0]);
    expect(p3.time).toHaveLength(500);
    expect(p3.atHistoryStart).toBe(true);
    expect(p3.time.at(-1)).toBe(p2.time[0]! - 3_600_000);

    const p4 = await b.getCandles(id, "1h", p3.time[0]);
    expect(p4.time).toHaveLength(0);
    expect(p4.atHistoryStart).toBe(true);
  });

  it("honours historyStartAt", async () => {
    const full = await createMockBackend({ candles: 300 }).getCandles(id, "1h");
    const cut = full.time[100]!;
    const page = await createMockBackend({ candles: 300, historyStartAt: cut }).getCandles(id, "1h");
    expect(page.time).toHaveLength(200);
    expect(page.time[0]).toBe(cut);
    expect(page.atHistoryStart).toBe(true);
  });

  it("returns columns of equal length with ints", async () => {
    const page = await createMockBackend({ candles: 10 }).getCandles(id, "1d");
    for (const col of [page.open, page.high, page.low, page.close, page.volume]) {
      expect(col).toHaveLength(page.time.length);
      expect(col.every(Number.isInteger)).toBe(true);
    }
  });

  it("reports the connection state", async () => {
    expect(await createMockBackend({ candles: 1 }).getConnection()).toBe("connected");
  });
});
