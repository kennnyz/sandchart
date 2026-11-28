import { describe, expect, it } from "vitest";
import type { ReplayTrade } from "../backend/types";
import { clampLevel, drawingCut, formatR, ReplayLayer, snapStart, type ReplayMarks } from "./replay";

const trade = (entryBar: number, reason: ReplayTrade["reason"] = "open"): ReplayTrade => ({
  side: "long",
  entryTime: entryBar * 1000,
  entryPrice: 100,
  initialStop: 90,
  stop: 90,
  take: 120,
  exitTime: reason === "open" ? null : (entryBar + 2) * 1000,
  exitPrice: reason === "open" ? null : 90,
  reason,
  ambiguous: false,
  r: reason === "open" ? 0.1 : -1,
});
const marks = (trades: ReplayTrade[], time: number): ReplayMarks => ({ trades, time, close: 101, cut: time + 1000, label: "Replay" });

describe("replay on the chart", () => {
  it("hides drawings from the cut on until the replay catches up, then shows them all", () => {
    const m = marks([], 5000);
    expect(drawingCut(m)).toBe(6000);
    // Caught up: the chart shows live data again, so nothing after the cut is a secret.
    expect(drawingCut({ ...m, caughtUp: true })).toBeNull();
    expect(drawingCut(null)).toBeNull();
  });

  it("snaps a picked date to the first bar opening at or after it", () => {
    const times = [10, 20, 30, 40];
    expect(snapStart(times, 4, 5)).toBe(10);
    expect(snapStart(times, 4, 20)).toBe(20);
    expect(snapStart(times, 4, 21)).toBe(30);
    expect(snapStart(times, 4, 41)).toBeNull();
    expect(snapStart(times, 2, 25)).toBeNull();
    expect(snapStart([], 0, 1)).toBeNull();
  });

  it("formats R with a sign and one decimal", () => {
    expect(formatR(2)).toBe("+2.0R");
    expect(formatR(-1)).toBe("−1.0R");
    expect(formatR(0)).toBe("0.0R");
    expect(formatR(-0.01)).toBe("0.0R");
    expect(formatR(0.44)).toBe("+0.4R");
  });

  it("keeps a dragged level on its side of the close", () => {
    expect(clampLevel("long", "stop", 100, 150)).toBe(99);
    expect(clampLevel("long", "take", 100, 50)).toBe(101);
    expect(clampLevel("short", "stop", 100, 50)).toBe(101);
    expect(clampLevel("short", "take", 100, 150)).toBe(99);
    expect(clampLevel("long", "stop", 100, 80)).toBe(80);
  });

  it("keeps a drag through new bars while its trade is open, and drops it once the trade closed", () => {
    const l = new ReplayLayer();
    l.set(marks([trade(5)], 5000));
    l.startDrag("stop");
    expect(l.dragging).toBe(true);
    // Play reveals bars: the same trade, still open, marked to a new close.
    l.set(marks([{ ...trade(5), r: 0.3 }], 6000));
    expect(l.dragging).toBe(true);
    // A close that fell under the dragged stop pushes it back under the close.
    l.set({ ...marks([trade(5)], 6500), close: 89 });
    expect(l.axisPrices()).toEqual([100, 88, 120]);
    // The trade was stopped: the drag goes with it.
    l.set(marks([trade(5, "stop")], 7000));
    expect(l.dragging).toBe(false);
    // Nor does a drag survive into another trade opened later.
    l.set(marks([trade(5, "stop"), trade(8)], 8000));
    l.startDrag("take");
    l.set(marks([trade(5, "stop"), trade(8, "stop"), trade(10)], 10_000));
    expect(l.dragging).toBe(false);
    l.startDrag("take");
    l.set(null);
    expect(l.dragging).toBe(false);
  });
});
