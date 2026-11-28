import { describe, expect, it } from "vitest";
import { clampLevel, formatR, snapStart } from "./replay";

describe("replay on the chart", () => {
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
});
