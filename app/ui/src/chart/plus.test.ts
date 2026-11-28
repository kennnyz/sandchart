import { describe, expect, it } from "vitest";
import { onPlus, PLUS_R, plusX, priceMenuEntries } from "./plus";

describe("the + at the crosshair price", () => {
  it("sits just left of the price axis, on the crosshair row", () => {
    expect(plusX(800)).toBe(800 - PLUS_R - 2);
    expect(onPlus(800, 600, plusX(800), 300, 300)).toBe(true);
    expect(onPlus(800, 600, plusX(800) - PLUS_R, 300, 300)).toBe(true);
    expect(onPlus(800, 600, plusX(800) - PLUS_R - 2, 300, 300)).toBe(false);
    expect(onPlus(800, 600, plusX(800), 300 + PLUS_R + 2, 300)).toBe(false);
  });

  it("is not on the price axis, nor outside the price plot", () => {
    expect(onPlus(800, 600, 801, 300, 300)).toBe(false);
    expect(onPlus(800, 600, plusX(800), 600, 600)).toBe(false);
    expect(onPlus(800, 600, plusX(800), -1, -1)).toBe(false);
    expect(onPlus(0, 600, plusX(0), 300, 300)).toBe(false);
  });
});

describe("the price menu", () => {
  it("offers an alert and a horizontal line on the live chart", () => {
    expect(priceMenuEntries(null)).toEqual([{ id: "alert" }, { id: "hline" }]);
  });

  it("offers buy, sell and a horizontal line in a replay, no alert", () => {
    expect(priceMenuEntries({ finished: false, hasOpen: false })).toEqual([{ id: "buy" }, { id: "sell" }, { id: "hline" }]);
  });

  it("turns buy and sell off while a trade is open, and once real time is reached", () => {
    expect(priceMenuEntries({ finished: false, hasOpen: true })).toEqual([
      { id: "buy", disabled: true },
      { id: "sell", disabled: true },
      { id: "hline" },
    ]);
    expect(priceMenuEntries({ finished: true, hasOpen: false })).toEqual([
      { id: "buy", disabled: true, realTime: true },
      { id: "sell", disabled: true, realTime: true },
      { id: "hline" },
    ]);
  });
});
