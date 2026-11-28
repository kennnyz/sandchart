import { describe, expect, it } from "vitest";
import { PriceScale } from "../scale";
import { Coords } from "./geometry";
import { MAGNET_RADIUS, snapToBar, STRONG_RADIUS } from "./magnet";

const H = 3_600_000;
const times = new Float64Array([0, H, 2 * H]);
// Three bars 10 px apart, the last at x = 100; 1 tick per px, 1000 at the top.
const ohlc = { open: [500, 600, 700], high: [550, 650, 760], low: [450, 580, 690], close: [520, 640, 700] };
const c = new Coords(times, 3, { barWidth: 10, rightIndex: 2 }, new PriceScale(0, 1000, 1000, "linear"), 100, 1000, H, 2, ohlc);
const y = (p: number) => 1000 - p;

describe("snapToBar", () => {
  it("snaps to the nearest of open, high, low and close of the bar under the pointer", () => {
    expect(MAGNET_RADIUS).toBe(8);
    // Bar 1 is at x = 90; its high is 650.
    expect(snapToBar(c, 92, y(648))).toEqual({ t: H, p: 650 });
    expect(snapToBar(c, 88, y(583))).toEqual({ t: H, p: 580 });
    // Between close 640 and high 650: the nearer one wins.
    expect(snapToBar(c, 90, y(643))).toEqual({ t: H, p: 640 });
    expect(snapToBar(c, 100, y(768))).toEqual({ t: 2 * H, p: 760 });
  });

  it("does not snap farther than the radius or off the bars", () => {
    expect(snapToBar(c, 90, y(660))).toBeNull();
    expect(snapToBar(c, 90, y(658))).toEqual({ t: H, p: 650 });
    expect(snapToBar(c, 110, y(700))).toBeNull();
    const noPrices = new Coords(times, 3, { barWidth: 10, rightIndex: 2 }, new PriceScale(0, 1000, 1000, "linear"), 100, 1000, H);
    expect(snapToBar(noPrices, 90, y(650))).toBeNull();
  });

  it("measures the radius on screen, so it works on a log scale", () => {
    const log = new Coords(times, 3, { barWidth: 10, rightIndex: 2 }, new PriceScale(100, 10_000, 400, "log"), 100, 400, H, 2, ohlc);
    expect(snapToBar(log, 100, log.y(760) - 7)).toEqual({ t: 2 * H, p: 760 });
    expect(snapToBar(log, 100, log.y(760) - 30)).toBeNull();
  });

  it("with ⌘ held snaps from anywhere on the bar's range, and from farther above and below it", () => {
    expect(STRONG_RADIUS).toBe(40);
    // Bar 1: low 580, open 600, close 640, high 650. Inside its range the nearest price wins.
    expect(snapToBar(c, 90, y(615), true)).toEqual({ t: H, p: 600 });
    expect(snapToBar(c, 90, y(625), true)).toEqual({ t: H, p: 640 });
    // 30 px over the high: too far for the magnet, close enough with ⌘.
    expect(snapToBar(c, 90, y(680))).toBeNull();
    expect(snapToBar(c, 90, y(680), true)).toEqual({ t: H, p: 650 });
    expect(snapToBar(c, 90, y(540), true)).toEqual({ t: H, p: 580 });
    expect(snapToBar(c, 90, y(691), true)).toBeNull();
  });

  it("moves bar to bar with the pointer while ⌘ stays held", () => {
    // The same height over three bars: each lands on that bar's open time and nearest price,
    // the last is too far below its low (690) to snap.
    const ys = [80, 90, 100].map((x) => snapToBar(c, x, y(560), true));
    expect(ys).toEqual([{ t: 0, p: 550 }, { t: H, p: 580 }, null]);
    expect(snapToBar(c, 100, y(660), true)).toEqual({ t: 2 * H, p: 690 });
  });
});

