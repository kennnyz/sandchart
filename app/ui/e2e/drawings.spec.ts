import { expect, test, type Page } from "@playwright/test";

const PRICE_AXIS = 72;
const TIME_AXIS = 26;
/** Palette slot 0 of the dark theme, the default drawing colour. */
const BLUE = [0x6e, 0x9f, 0xd8];
/** Palette slot 3 of the dark theme (violet). */
const VIOLET = [0xa5, 0x8b, 0xd6];

interface Plot {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Stored {
  id: string;
  style: { color: number; width: number; dash: boolean };
  locked: boolean;
  hidden: boolean;
  body: {
    kind: string;
    p?: number;
    a?: { t: number; p: number };
    b?: { t: number; p: number };
    levels?: number[];
    points?: { t: number; p: number }[];
    extendRight?: boolean;
    side?: string;
    entry?: { t: number; p: number };
    stop?: number;
    take?: number;
    endT?: number;
    t?: number;
    text?: string;
  };
}

interface Debug {
  baseDraws: number;
  overlayDraws: number;
  drawingsPainted: number;
  selectedDrawing: string | null;
  hoveredDrawing: string | null;
  selectedDrawings: string[];
  selectionBox: boolean;
  selectedHandles: { x: number; y: number }[];
  ruler: string | null;
  outcomes: Record<string, string>;
  snapRing: { x: number; y: number } | null;
  crosshair: { x: number; y: number } | null;
  lockGlyphs: number;
  lockedHint: boolean;
}

async function openChart(page: Page, query = ""): Promise<Plot> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  const box = await page.getByTestId("chart").boundingBox();
  if (!box) throw new Error("chart has no box");
  // Whole px everywhere: WebKit rounds mouse positions, so pixel samples must match.
  return {
    left: Math.round(box.x),
    top: Math.round(box.y),
    width: Math.round(box.width - PRICE_AXIS) - 1,
    height: Math.round((box.height - TIME_AXIS) / 10) * 10,
  };
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** What the mock has stored (it keeps drawings in localStorage). */
async function stored(page: Page): Promise<Stored[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sandchart.mock.drawings") ?? "[]") as Stored[]);
}

/** Waits until the mock has stored `n` drawings and returns them. */
async function storedCount(page: Page, n: number): Promise<Stored[]> {
  await expect.poll(async () => (await stored(page)).length).toBe(n);
  return stored(page);
}

async function debug(page: Page): Promise<Debug> {
  await nextFrame(page);
  return page.evaluate(() => {
    const d = (window as unknown as { __sandchartDebug: Debug }).__sandchartDebug;
    return { ...d };
  });
}

/** The debug state once the base layer has stopped redrawing (a late font or page load redraws it once more). */
async function settled(page: Page): Promise<Debug> {
  let last = await debug(page);
  for (;;) {
    await page.waitForTimeout(150);
    const now = await debug(page);
    if (now.baseDraws === last.baseDraws) return now;
    last = now;
  }
}

/** RGBA of one CSS pixel of the chart's base canvas. WebKit rounds mouse positions: sample at whole px. */
async function basePixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.getByTestId("chart").evaluate(
    (el, [cx, cy]) => {
      const c = el.querySelectorAll("canvas")[0]!;
      const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      const d = c.getContext("2d")!.getImageData(Math.round((cx! - r.left) * k), Math.round((cy! - r.top) * k), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]!];
    },
    [x, y],
  );
}

function isColor(rgba: number[], rgb: number[]): boolean {
  return rgb.every((v, i) => Math.abs(v - rgba[i]!) <= 12);
}

function isBlue(rgba: number[]): boolean {
  return isColor(rgba, BLUE);
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
  await nextFrame(page);
}

test("places_hline_and_trend_line", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.3);

  await page.getByTestId("tool-hline").click();
  await expect(page.getByTestId("tool-hline")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(cx, y);
  const [hline] = await storedCount(page, 1);
  expect(hline!.body.kind).toBe("hline");
  // The tool is put down after one placement; the level is drawn across the plot.
  await expect(page.getByTestId("tool-hline")).toHaveAttribute("aria-pressed", "false");
  await nextFrame(page);
  expect(isBlue(await basePixel(page, plot.left + 80, y))).toBe(true);
  expect(isBlue(await basePixel(page, plot.left + plot.width - 20, y))).toBe(true);

  // Alt+T picks the trend line (by the physical key); two clicks place it.
  await page.keyboard.press("Alt+KeyT");
  await expect(page.getByTestId("tool-trend")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(cx - 150, plot.top + plot.height * 0.7);
  await page.mouse.move(cx, plot.top + plot.height * 0.6, { steps: 4 });
  await page.mouse.click(cx + 150, plot.top + plot.height * 0.5);
  const list = await storedCount(page, 2);
  const trend = list.find((d) => d.body.kind === "trend")!;
  expect(trend.body.a!.t).toBeLessThan(trend.body.b!.t);
  expect(trend.body.a!.p).toBeLessThan(trend.body.b!.p);
  await expect(page.getByTestId("tool-trend")).toHaveAttribute("aria-pressed", "false");
  await nextFrame(page);
  expect(isBlue(await basePixel(page, cx, Math.round(plot.top + plot.height * 0.6)))).toBe(true);
  expect((await debug(page)).drawingsPainted).toBe(2);
});

test("selects_drags_deletes_and_undoes", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const a: [number, number] = [cx - 150, plot.top + plot.height * 0.6];
  const b: [number, number] = [cx + 150, plot.top + plot.height * 0.4];

  // Press, drag and release places a trend line too.
  await page.keyboard.press("Alt+KeyT");
  await drag(page, a, b);
  const [placed] = await storedCount(page, 1);
  expect((await debug(page)).selectedDrawing).toBe(placed!.id);

  // A click on empty space deselects; a click on the line selects it.
  await page.mouse.click(cx, plot.top + plot.height * 0.2);
  expect((await debug(page)).selectedDrawing).toBeNull();
  await page.mouse.click(cx, plot.top + plot.height * 0.5 + 2);
  expect((await debug(page)).selectedDrawing).toBe(placed!.id);

  // Dragging the body moves both ends down, to lower prices.
  await drag(page, [cx, plot.top + plot.height * 0.5], [cx + 20, plot.top + plot.height * 0.5 + 60]);
  await expect.poll(async () => (await stored(page))[0]!.body.a!.p).toBeLessThan(placed!.body.a!.p);
  const moved = (await stored(page))[0]!;
  expect(moved.body.b!.p).toBeLessThan(placed!.body.b!.p);
  expect(moved.body.a!.t).toBeGreaterThan(placed!.body.a!.t);

  // Shift while dragging a handle puts that end at the other end's price.
  await page.keyboard.down("Shift");
  await drag(page, [b[0] + 20, b[1] + 60], [b[0] + 80, b[1] - 50]);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await stored(page))[0]!.body.b!.p).toBe(moved.body.a!.p);
  const flat = (await stored(page))[0]!;
  expect(flat.body.b!.t).toBeGreaterThan(moved.body.b!.t);

  // Delete removes the selection; ⌘Z brings it back, ⇧⌘Z removes it again.
  await page.keyboard.press("Delete");
  await storedCount(page, 0);
  await page.keyboard.press("ControlOrMeta+z");
  const [back] = await storedCount(page, 1);
  expect(back!.body).toEqual(flat.body);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page))[0]!.body.b!.p).toBe(moved.body.b!.p);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await stored(page))[0]!.body.b!.p).toBe(moved.body.a!.p);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await storedCount(page, 0);
});

test("shift_places_a_horizontal_line_and_esc_cancels", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  await page.keyboard.press("Alt+KeyT");
  await page.mouse.click(cx - 100, plot.top + plot.height * 0.5);
  await page.keyboard.down("Shift");
  await page.mouse.click(cx + 100, plot.top + plot.height * 0.3);
  await page.keyboard.up("Shift");
  const [line] = await storedCount(page, 1);
  expect(line!.body.b!.p).toBe(line!.body.a!.p);

  // Esc drops a half-placed line and the tool.
  await page.keyboard.press("Alt+KeyT");
  await page.mouse.click(cx - 100, plot.top + plot.height * 0.7);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tool-trend")).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click(cx + 100, plot.top + plot.height * 0.8);
  await page.waitForTimeout(300);
  expect(await stored(page)).toHaveLength(1);
});

test("drawings_survive_a_reload", async ({ page }) => {
  const plot = await openChart(page);
  const y = Math.round(plot.top + plot.height * 0.35);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(plot.left + plot.width / 2, y);
  const [saved] = await storedCount(page, 1);

  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);
  expect(await stored(page)).toEqual([saved]);
  expect(isBlue(await basePixel(page, plot.left + 80, y))).toBe(true);
});

test("hovering_drawings_redraws_only_the_overlay", async ({ page }) => {
  const plot = await openChart(page);
  const y = plot.top + plot.height * 0.4;
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(plot.left + plot.width / 2, y);
  await storedCount(page, 1);
  await page.mouse.move(plot.left + 100, plot.top + plot.height * 0.8);
  const before = await debug(page);

  for (let i = 0; i < 40; i++) {
    await page.mouse.move(plot.left + 100 + i * 12, y + ((i % 9) - 4) * 4);
    await nextFrame(page);
  }
  const over = await debug(page);
  expect(over.hoveredDrawing).not.toBeNull();
  await page.mouse.move(plot.left + 100, plot.top + plot.height * 0.8);
  const after = await debug(page);
  expect(after.hoveredDrawing).toBeNull();
  expect(after.baseDraws).toBe(before.baseDraws);
  expect(after.overlayDraws).toBeGreaterThan(before.overlayDraws + 20);
  // The cursor says what a press would do.
  await page.mouse.move(plot.left + 140, y);
  await expect(page.getByTestId("chart").locator("canvas").first()).toHaveCSS("cursor", "move");
});

test("places_a_rect_a_fib_and_a_brush_stroke_that_survive_a_reload", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const cy = Math.round(plot.top + plot.height / 2);

  await page.keyboard.press("Alt+KeyB");
  await expect(page.getByTestId("tool-rect")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(cx - 300, cy - 150);
  await page.mouse.click(cx - 150, cy - 50);
  const [rect] = await storedCount(page, 1);
  expect(rect!.body).toMatchObject({ kind: "rect", extendRight: false });
  await expect(page.getByTestId("tool-rect")).toHaveAttribute("aria-pressed", "false");
  // The zone is filled lightly in its colour: inside it the ground turns a little blue.
  await nextFrame(page);
  const inside = await basePixel(page, cx - 225, cy - 100);
  expect(inside[2]!).toBeGreaterThan(inside[0]! + 4);

  await page.getByTestId("tool-fib").click();
  await page.mouse.click(cx - 50, cy + 150);
  await page.mouse.click(cx + 150, cy - 150);
  const fib = (await storedCount(page, 2)).find((d) => d.body.kind === "fib")!;
  expect(fib.body.levels).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618]);
  expect(fib.body.a!.t).toBeLessThan(fib.body.b!.t);

  // The brush strokes while pressed and stays picked until Esc.
  await page.keyboard.press("Alt+KeyP");
  await page.mouse.move(cx + 200, cy + 100);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(cx + 200 + i * 4, cy + 100 + Math.sin(i / 6) * 60);
  await page.mouse.up();
  const brush = (await storedCount(page, 3)).find((d) => d.body.kind === "brush")!;
  expect(brush.body.points!.length).toBeGreaterThanOrEqual(2);
  expect(brush.body.points!.length).toBeLessThanOrEqual(61);
  await expect(page.getByTestId("tool-brush")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tool-brush")).toHaveAttribute("aria-pressed", "false");
  const saved = await stored(page);

  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(3);
  expect(await stored(page)).toEqual(saved);
});

test("ruler_measures_on_shift_drag_without_panning_or_storing", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const cy = Math.round(plot.top + plot.height / 2);
  await page.mouse.move(cx, cy);
  const before = await settled(page);
  const legendTime = await page.getByTestId("legend").getAttribute("data-time");

  await page.keyboard.down("Shift");
  await drag(page, [cx - 100, cy + 80], [cx + 100, cy - 80]);
  await page.keyboard.up("Shift");
  const after = await debug(page);
  // Up and to the right: a positive change, 20 bars of 10 px.
  expect(after.ruler).toMatch(/^\+[\d\u2009.]+ \(\+[\d.]+%\)\|\d+ bars, \d+[dhm]/);
  // Neither the chart moved nor the base was redrawn, and nothing was stored.
  expect(after.baseDraws).toBe(before.baseDraws);
  await page.mouse.move(cx, cy);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", legendTime!);
  await page.waitForTimeout(200);
  expect(await stored(page)).toEqual([]);

  // A click puts it away.
  await page.mouse.click(cx, cy + 200);
  expect((await debug(page)).ruler).toBeNull();

  // Alt+R arms it for one drag with a tool picked; Esc removes it.
  await page.keyboard.press("Alt+KeyT");
  await page.keyboard.press("Alt+KeyR");
  await drag(page, [cx + 100, cy - 80], [cx - 100, cy + 80]);
  expect((await debug(page)).ruler).toMatch(/^\u2212/);
  await expect(page.getByTestId("tool-trend")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  expect((await debug(page)).ruler).toBeNull();
  expect(await stored(page)).toEqual([]);
  expect((await debug(page)).baseDraws).toBe(before.baseDraws);
});

/** Ticks of a price as the legend shows it ("1 234.50" -> 123450). */
const ticksOf = (text: string) => Number(text.replace(/[\u2009\s.]/g, ""));

test("magnet_snaps_a_level_to_a_candle_high", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y1 = Math.round(plot.top + plot.height * 0.2);
  const y2 = Math.round(plot.top + plot.height * 0.8);
  // Two levels without the magnet give the price of every y (linear scale).
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(plot.left + 60, y1);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(plot.left + 60, y2);
  const [l1, l2] = await storedCount(page, 2);
  const yOf = (p: number) => y1 + ((p - l1!.body.p!) * (y2 - y1)) / (l2!.body.p! - l1!.body.p!);

  // The high of the bar under the centre, from the legend.
  await page.mouse.move(cx, plot.top + plot.height / 2);
  const legend = page.getByTestId("legend");
  const high = ticksOf((await legend.locator("span").nth(5).textContent())!);
  const yHigh = Math.round(yOf(high));

  await expect(page.getByTestId("tool-magnet")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Alt+KeyM");
  await expect(page.getByTestId("tool-magnet")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("sandchart.drawings.magnet"))).toBe("1");

  await page.keyboard.press("Alt+KeyH");
  // Moving with a tool and the magnet on still redraws only the overlay.
  const before = await settled(page);
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(cx - 40 + i * 4, yHigh + 30 - i);
    await nextFrame(page);
  }
  expect((await debug(page)).baseDraws).toBe(before.baseDraws);
  await page.mouse.click(cx, yHigh + 5);
  const snapped = (await storedCount(page, 3)).map((d) => d.body.p).filter((p) => p !== l1!.body.p && p !== l2!.body.p);
  expect(snapped).toEqual([high]);

  // 25 px above the high is too far for the magnet, but not with ⌘ (Ctrl) held.
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, yHigh - 25);
  expect((await storedCount(page, 4)).filter((d) => d.body.p === high)).toHaveLength(1);
  await page.keyboard.press("Alt+KeyH");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(cx, yHigh - 25);
  await page.keyboard.up("ControlOrMeta");
  const all = await storedCount(page, 5);
  expect(all.filter((d) => d.body.p === high)).toHaveLength(2);

  // The switch is kept across a reload.
  await page.reload();
  await expect(page.getByTestId("tool-magnet")).toHaveAttribute("aria-pressed", "true");
});

test("cmd_held_before_the_first_click_previews_the_snap_and_places_on_a_bar_price", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const legend = page.getByTestId("legend");
  await page.mouse.move(cx, plot.top + plot.height / 2);
  const time = Number(await legend.getAttribute("data-time"));
  const prices = await Promise.all([3, 5, 7, 9].map(async (i) => ticksOf((await legend.locator("span").nth(i).textContent())!)));

  await page.keyboard.press("Alt+KeyT");
  await expect.poll(async () => (await debug(page)).snapRing).toBeNull();
  // With ⌘ held, find a height close enough to the bar under the mouse for a snap.
  await page.keyboard.down("ControlOrMeta");
  let y = plot.top + 10;
  for (; y < plot.top + plot.height; y += 20) {
    await page.mouse.move(cx, y);
    if ((await debug(page)).snapRing) break;
  }
  const ring = (await debug(page)).snapRing;
  expect(ring).not.toBeNull();
  expect(ring!.x).toBeCloseTo(cx - plot.left, -1);
  // The crosshair (and its price label) sits on the ring, not at the pointer.
  expect((await debug(page)).crosshair).toEqual(ring);
  // The key alone, without moving the mouse, hides and shows the ring; the base stays as it is.
  const before = await settled(page);
  await page.keyboard.up("ControlOrMeta");
  await expect.poll(async () => (await debug(page)).snapRing).toBeNull();
  await page.keyboard.down("ControlOrMeta");
  await expect.poll(async () => (await debug(page)).snapRing).toEqual(ring);
  const after = await debug(page);
  expect(after.baseDraws).toBe(before.baseDraws);
  expect(after.overlayDraws).toBeGreaterThan(before.overlayDraws);

  // The first point lands on the price the ring showed: one of the bar's O, H, L, C.
  await page.mouse.click(cx, y);
  await page.keyboard.up("ControlOrMeta");
  await page.mouse.click(cx + 120, plot.top + plot.height * 0.3);
  const [line] = await storedCount(page, 1);
  expect(line!.body.a!.t).toBe(time);
  expect(prices).toContain(line!.body.a!.p);
});

/** Handles of the selected drawing in page px. */
async function handles(page: Page, plot: Plot): Promise<[number, number][]> {
  const d = await debug(page);
  return d.selectedHandles.map((h) => [Math.round(plot.left + h.x), Math.round(plot.top + h.y)]);
}

const HOUR = 3_600_000;

test("places_a_long_and_a_short_drags_stop_and_take_and_shows_outcomes", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  // Low on the plot: the candles after the entry trade above it.
  const ey = Math.round(plot.top + plot.height * 0.8);
  const bottom = plot.top + plot.height - 4;

  // Alt+L, one click: the entry, with the default stop, take and length.
  await page.keyboard.press("Alt+KeyL");
  await expect(page.getByTestId("tool-long")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(cx - 250, ey);
  const [long] = await storedCount(page, 1);
  const lb = long!.body;
  expect(lb).toMatchObject({ kind: "position", side: "long" });
  expect(lb.stop!).toBeLessThan(lb.entry!.p);
  expect(lb.take! - lb.entry!.p).toBe(3 * (lb.entry!.p - lb.stop!));
  expect(lb.endT! - lb.entry!.t).toBe(20 * HOUR);
  await expect(page.getByTestId("tool-long")).toHaveAttribute("aria-pressed", "false");

  // Take dragged below the entry stops one tick above it; stop dragged to the bottom.
  let [stopH, takeH] = await handles(page, plot);
  await drag(page, takeH!, [takeH![0], ey + 30]);
  await expect.poll(async () => (await stored(page))[0]!.body.take).toBe(lb.entry!.p + 1);
  [stopH] = await handles(page, plot);
  await drag(page, stopH!, [stopH![0], bottom]);
  await expect.poll(async () => (await stored(page))[0]!.body.stop).toBeLessThan(lb.stop!);
  await expect.poll(async () => (await debug(page)).outcomes[long!.id]).toBe("take");

  // A short: its stop dragged below the entry stops one tick above it, so the next bars hit it.
  await page.keyboard.press("Alt+KeyS");
  await page.mouse.click(cx + 100, ey);
  const list = await storedCount(page, 2);
  const short = list.find((d) => d.body.side === "short")!;
  expect(short.body.stop!).toBeGreaterThan(short.body.entry!.p);
  expect(short.body.take!).toBeLessThan(short.body.entry!.p);
  [stopH, takeH] = await handles(page, plot);
  await drag(page, takeH!, [takeH![0], bottom]);
  [stopH] = await handles(page, plot);
  await drag(page, stopH!, [stopH![0], ey + 30]);
  const shortStop = async () => (await stored(page)).find((d) => d.id === short.id)!.body.stop;
  await expect.poll(shortStop).toBe(short.body.entry!.p + 1);
  await expect.poll(async () => (await debug(page)).outcomes[short.id]).toBe("stop");

  // The end handle makes it longer; the outcome is asked for again.
  const end = (await handles(page, plot))[3]!;
  await drag(page, end, [end[0] + 60, end[1]]);
  await expect.poll(async () => (await stored(page)).find((d) => d.id === short.id)!.body.endT).toBeGreaterThan(short.body.endT!);
  await expect.poll(async () => (await debug(page)).outcomes[short.id]).toBe("stop");

  // Both come back after a reload, with their outcomes.
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).outcomes).toEqual({ [long!.id]: "take", [short.id]: "stop" });
  expect((await debug(page)).drawingsPainted).toBe(2);

  // Moving the mouse over them redraws only the overlay.
  const before = await settled(page);
  for (let i = 0; i <= 10; i++) await page.mouse.move(cx - 300 + i * 50, ey - 20 + (i % 3) * 10);
  const after = await debug(page);
  expect(after.overlayDraws).toBeGreaterThan(before.overlayDraws);
  expect(after.baseDraws).toBe(before.baseDraws);
});

/** Centre of the blue note marker near column `x` of the base canvas, in page px. */
async function findMarker(page: Page, x: number): Promise<[number, number]> {
  const found = await page.getByTestId("chart").evaluate(
    (el, [cx, blue]) => {
      const c = el.querySelectorAll("canvas")[0]!;
      const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      const x0 = Math.round((cx as number) - r.left - 12);
      const d = c.getContext("2d")!.getImageData(Math.round(x0 * k), 0, Math.round(24 * k), c.height).data;
      const w = Math.round(24 * k);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const b = blue as number[];
        if (Math.abs(d[i]! - b[0]!) <= 12 && Math.abs(d[i + 1]! - b[1]!) <= 12 && Math.abs(d[i + 2]! - b[2]!) <= 12) {
          const p = i / 4;
          sx += (p % w) / k;
          sy += Math.floor(p / w) / k;
          n++;
        }
      }
      return n === 0 ? null : [r.left + x0 + sx / n, r.top + sy / n];
    },
    [x, BLUE] as [number, number[]],
  );
  if (!found) throw new Error("no note marker");
  return [Math.round(found[0]!), Math.round(found[1]!)];
}

test("writes_edits_and_deletes_a_note", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.5);

  // A note without text is no note.
  await page.keyboard.press("Alt+KeyN");
  await page.mouse.click(cx, y);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("note-editor")).toBeHidden();
  await page.getByTestId("tool-note").click();
  await page.mouse.click(cx, y);
  await page.getByTestId("note-save").click();
  await expect(page.getByTestId("note-editor")).toBeHidden();
  expect(await stored(page)).toEqual([]);

  // Click on a bar, type, save: stored at the bar's open time.
  await page.keyboard.press("Alt+KeyN");
  await page.mouse.click(cx, y);
  const area = page.getByTestId("note-editor").getByRole("textbox");
  await expect(area).toBeFocused();
  await page.keyboard.type("Breakout\nretest");
  await expect(page.getByTestId("note-editor")).toContainText("15 / 2000");
  await page.getByTestId("note-save").click();
  const [note] = await storedCount(page, 1);
  expect(note!.body).toMatchObject({ kind: "note", text: "Breakout\nretest" });
  expect(note!.body.t! % HOUR).toBe(0);

  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await settled(page);
  const marker = await findMarker(page, cx);
  expect(Math.abs(marker[0] - cx)).toBeLessThan(10);
  // Hovering shows the first line; it redraws only the overlay.
  const before = await settled(page);
  await page.mouse.move(marker[0], marker[1]);
  await expect.poll(async () => (await debug(page)).hoveredDrawing).toBe(note!.id);
  expect((await debug(page)).baseDraws).toBe(before.baseDraws);

  // A double-click opens the editor with the text; ⌘Enter saves the change.
  await page.mouse.dblclick(marker[0], marker[1]);
  await expect(area).toHaveValue("Breakout\nretest");
  await expect(area).toBeFocused();
  // Over the limit the text is cut at 2000 bytes.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("x".repeat(2100));
  await expect(area).toHaveValue("x".repeat(2000));
  await expect(page.getByTestId("note-editor")).toContainText("2000 / 2000");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("note-editor")).toBeHidden();
  await expect.poll(async () => (await stored(page))[0]!.body.text).toBe("x".repeat(2000));

  // Click selects it, Enter opens the editor, Delete removes it.
  await page.mouse.click(plot.left + 30, plot.top + 30);
  await page.mouse.click(marker[0], marker[1]);
  expect((await debug(page)).selectedDrawing).toBe(note!.id);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("note-editor")).toBeVisible();
  await page.getByTestId("note-delete").click();
  await storedCount(page, 0);
});

test("delete_keys_on_a_note_editor_button_stay_in_the_editor", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  await page.keyboard.press("Alt+KeyN");
  await page.mouse.click(cx, Math.round(plot.top + plot.height * 0.5));
  await expect(page.getByTestId("note-editor").getByRole("textbox")).toBeFocused();
  await page.keyboard.type("keep me");
  await page.getByTestId("note-save").click();
  const [note] = await storedCount(page, 1);
  const marker = await findMarker(page, cx);

  // The note is selected and its editor is open with the focus on a button.
  await page.mouse.click(marker[0], marker[1]);
  expect((await debug(page)).selectedDrawing).toBe(note!.id);
  await page.keyboard.press("Enter");
  await page.getByTestId("note-save").focus();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await nextFrame(page);
  await expect(page.getByTestId("note-editor")).toBeVisible();
  expect((await debug(page)).selectedDrawing).toBe(note!.id);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("note-editor")).toBeHidden();
  await nextFrame(page);
  expect(await stored(page)).toHaveLength(1);
});

test("style_popover_changes_a_fib_and_the_change_survives_a_reload", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const yA = Math.round(plot.top + plot.height * 0.7);
  const yB = Math.round(plot.top + plot.height * 0.3);
  await page.keyboard.press("Alt+KeyF");
  await page.mouse.click(cx - 150, yA);
  await page.mouse.click(cx + 150, yB);
  const [fib] = await storedCount(page, 1);

  // A double-click on a level opens the popover with the drawing's style.
  const mid = Math.round((yA + yB) / 2);
  await page.mouse.dblclick(cx, mid);
  const pop = page.getByTestId("drawing-style");
  await expect(pop).toBeVisible();
  await expect(page.getByTestId("drawing-color-0")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("drawing-color-0")).toBeFocused();

  // Each change is applied and stored at once, one save each.
  await page.getByTestId("drawing-color-3").click();
  await expect.poll(async () => (await stored(page))[0]!.style.color).toBe(3);
  await page.getByTestId("drawing-width-4").click();
  await expect.poll(async () => (await stored(page))[0]!.style.width).toBe(4);
  await pop.getByLabel("Dashed").check();
  await expect.poll(async () => (await stored(page))[0]!.style.dash).toBe(true);
  // A level off; the last one left cannot be turned off.
  await pop.getByTestId("drawing-style-levels").getByLabel("0.5", { exact: true }).uncheck();
  await expect.poll(async () => (await stored(page))[0]!.body.levels).toEqual(fib!.body.levels!.filter((l) => l !== 0.5));
  await expect(page.getByTestId("drawing-color-3")).toHaveAttribute("aria-checked", "true");

  // Esc closes it; the level at 0.5 is gone from the chart, the others are violet.
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await page.mouse.move(cx, plot.top + 20);
  await nextFrame(page);
  expect(isColor(await basePixel(page, cx, mid), VIOLET)).toBe(false);

  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);
  const [after] = await stored(page);
  expect(after!.style).toEqual({ color: 3, width: 4, dash: true });
  expect(after!.body.levels).toHaveLength(fib!.body.levels!.length - 1);
  // The 0 level runs through b at full width: a violet pixel on it, away from the label and the dash gaps.
  let violet = false;
  for (let x = cx - 40; x <= cx + 40 && !violet; x += 2) violet = isColor(await basePixel(page, x, yB), VIOLET);
  expect(violet).toBe(true);
});

test("enter_opens_the_style_popover_and_undo_reverts_a_style_change", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  await page.keyboard.press("Alt+KeyT");
  await page.mouse.click(cx - 150, plot.top + plot.height * 0.6);
  await page.mouse.click(cx + 150, plot.top + plot.height * 0.4);
  await storedCount(page, 1);

  // The new line is selected: Enter opens its popover.
  await page.keyboard.press("Enter");
  const pop = page.getByTestId("drawing-style");
  await expect(pop).toBeVisible();
  await page.getByTestId("drawing-color-5").click();
  await expect.poll(async () => (await stored(page))[0]!.style.color).toBe(5);
  await pop.getByLabel("Extend right").check();
  await expect.poll(async () => (await stored(page))[0]!.body.extendRight).toBe(true);

  // ⌘Z inside the popover undoes the last change, and the popover follows.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page))[0]!.body.extendRight).toBe(false);
  await expect(pop.getByLabel("Extend right")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page))[0]!.style.color).toBe(0);

  // Delete in the popover removes the drawing and closes it.
  await page.keyboard.press("Enter");
  await pop.getByTestId("drawing-style-delete").click();
  await storedCount(page, 0);
  await expect(pop).toBeHidden();
});

test("delete_keys_on_a_style_popover_control_stay_in_the_popover", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  await page.keyboard.press("Alt+KeyT");
  await page.mouse.click(cx - 150, plot.top + plot.height * 0.6);
  await page.mouse.click(cx + 150, plot.top + plot.height * 0.4);
  const [line] = await storedCount(page, 1);
  await page.keyboard.press("Enter");
  const pop = page.getByTestId("drawing-style");
  await expect(pop).toBeVisible();
  // On a button and on a checkbox: no delete, and WebKit does not go back a page.
  await page.getByTestId("drawing-color-3").focus();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await pop.getByLabel("Extend right").focus();
  await page.keyboard.press("Backspace");
  await nextFrame(page);
  await expect(pop).toBeVisible();
  expect((await debug(page)).selectedDrawing).toBe(line!.id);
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  expect(await stored(page)).toHaveLength(1);
});

test("a_locked_drawing_does_not_move", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y);
  const [line] = await storedCount(page, 1);

  await page.mouse.dblclick(cx - 100, y);
  await page.getByTestId("drawing-style").getByLabel("Locked").check();
  await expect.poll(async () => (await stored(page))[0]!.locked).toBe(true);
  await page.keyboard.press("Escape");

  // Selected, it shows a lock by its handle; a drag says "Locked" for a moment and moves nothing.
  await expect.poll(async () => (await debug(page)).lockGlyphs).toBe(1);
  await drag(page, [cx - 100, y], [cx - 60, y + 80]);
  expect((await debug(page)).lockedHint).toBe(true);
  await expect.poll(async () => (await debug(page)).lockedHint, { timeout: 3000 }).toBe(false);
  const [after] = await stored(page);
  expect(after!.body.p).toBe(line!.body.p);
  expect((await debug(page)).selectedDrawing).toBe(line!.id);
  expect(isBlue(await basePixel(page, plot.left + 80, y))).toBe(true);
});

test("hide_all_hides_drawings_from_painting_and_hit_testing", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y);
  const [line] = await storedCount(page, 1);
  expect((await debug(page)).selectedDrawing).toBe(line!.id);

  const toggle = page.getByTestId("tool-hide-all");
  const hideAll = async () => {
    await toggle.click();
    await page.getByTestId("visibility-menu-toggle").click();
    await expect(page.getByTestId("visibility-menu")).toHaveCount(0);
  };
  await hideAll();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(0);
  expect((await debug(page)).selectedDrawing).toBeNull();
  expect(isBlue(await basePixel(page, plot.left + 80, y))).toBe(false);
  // A click where the line is selects nothing, a drag pans instead of moving it, Delete does nothing.
  await page.mouse.click(cx - 100, y);
  expect((await debug(page)).selectedDrawing).toBeNull();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  expect(await stored(page)).toEqual([line]);

  // Shown again, as stored: hiding changed nothing in storage.
  await hideAll();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);
  expect(isBlue(await basePixel(page, plot.left + 80, y))).toBe(true);

  // Picking a tool shows hidden drawings.
  await hideAll();
  await page.keyboard.press("Alt+KeyT");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("a_failed_save_shows_an_error_and_the_chart_shows_what_is_stored", async ({ page }) => {
  const plot = await openChart(page, "?mockDrawingSaveError=1");
  await expect(page.getByTestId("drawing-error")).toHaveCount(0);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(plot.left + plot.width / 2, plot.top + plot.height * 0.4);
  const banner = page.getByTestId("drawing-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("could not be saved");
  await expect(banner).toHaveAttribute("title", "mock: cannot save the drawing");
  // The controller reloads the list: the unsaved level disappears.
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(0);
  expect(await stored(page)).toEqual([]);
});

test("base_frame_with_500_drawings_under_budget @perf", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  // One real drawing gives the instrument and times on screen; 500 copies spread around it.
  await page.keyboard.press("Alt+KeyT");
  await drag(page, [cx - 200, plot.top + 200], [cx + 200, plot.top + 300]);
  const [seed] = await storedCount(page, 1);
  await page.evaluate((s) => {
    const all = [];
    for (let i = 0; i < 500; i++) {
      const shift = (i % 50) * 3_600_000 * 4 - 100 * 3_600_000;
      const body =
        i % 5 === 0
          ? { kind: "hline", p: s.body.a.p + i * 3 }
          : { ...s.body, a: { t: s.body.a.t + shift, p: s.body.a.p + i * 5 }, b: { t: s.body.b.t + shift, p: s.body.b.p - i * 5 }, extendRight: i % 7 === 0 };
      all.push({ ...s, id: `perf-${i}`, z: i, body });
    }
    localStorage.setItem("sandchart.mock.drawings", JSON.stringify(all));
  }, seed as unknown as { body: { a: { t: number; p: number }; b: { t: number; p: number } } });
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBeGreaterThan(300);

  const before = await page.evaluate(() => (window as unknown as { __sandchartDebug: { baseMs: number[] } }).__sandchartDebug.baseMs.length);
  // Pan with horizontal scrolls (a press could land on a drawing): every frame redraws the base.
  await page.mouse.move(cx, plot.top + plot.height / 2);
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(i % 20 < 10 ? 8 : -8, 0);
    await nextFrame(page);
  }
  const ms = await page.evaluate(
    (n) => (window as unknown as { __sandchartDebug: { baseMs: number[] } }).__sandchartDebug.baseMs.slice(n),
    before,
  );
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const painted = (await debug(page)).drawingsPainted;
  console.log(`base frame with ${painted} drawings painted: mean ${mean.toFixed(2)} ms over ${ms.length} frames`);
  expect(ms.length).toBeGreaterThan(10);
  expect(mean).toBeLessThan(4);
});

/** Places horizontal levels at these y and returns them as stored, top first. */
async function levels(page: Page, x: number, ys: number[]): Promise<Stored[]> {
  for (const y of ys) {
    await page.keyboard.press("Alt+KeyH");
    await page.mouse.click(x, y);
  }
  const list = await storedCount(page, ys.length);
  return [...list].sort((a, b) => b.body.p! - a.body.p!);
}

/** ⌘-drag (Ctrl-drag) from one point to another. */
async function cmdDrag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.keyboard.down("ControlOrMeta");
  await drag(page, from, to);
  await page.keyboard.up("ControlOrMeta");
}

test("right_click_shows_our_menu_and_never_the_native_one", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  const [line] = await levels(page, cx, [y]);
  // A listener added after the app's sees whether the app blocked the web view's menu.
  await page.evaluate(() => {
    const w = window as unknown as { __ctx: boolean[] };
    w.__ctx = [];
    window.addEventListener("contextmenu", (e) => w.__ctx.push(e.defaultPrevented));
  });
  const prevented = () => page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx);

  // On empty chart space and on the rail: no menu of ours, and none of the web view's.
  await page.mouse.click(cx, plot.top + plot.height * 0.8, { button: "right" });
  await page.getByTestId("tool-trend").click({ button: "right" });
  await expect(page.getByTestId("drawing-menu")).toHaveCount(0);
  expect(await prevented()).toEqual([true, true]);

  // On the line: our menu, keyboard first; Esc closes it and keeps the selection.
  await page.mouse.click(cx - 100, y, { button: "right" });
  const menu = page.getByTestId("drawing-menu");
  await expect(menu).toBeVisible();
  expect((await prevented()).at(-1)).toBe(true);
  expect((await debug(page)).selectedDrawing).toBe(line!.id);
  await expect(menu.getByRole("menuitem")).toHaveText([/Lock/, /Hide/, /Remove/, /Settings/]);
  await expect(page.getByTestId("drawing-menu-lock")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("drawing-menu-hide")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect((await debug(page)).selectedDrawing).toBe(line!.id);

  // Esc gives focus back to where it was: here the eye button that opened the rail menu.
  await page.getByTestId("tool-hide-all").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("visibility-menu")).toBeVisible();
  await expect(page.getByTestId("visibility-menu-toggle")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("visibility-menu")).toHaveCount(0);
  await expect(page.getByTestId("tool-hide-all")).toBeFocused();

  // Lock by keyboard; the menu then offers Unlock.
  await page.mouse.click(cx - 100, y, { button: "right" });
  await expect(page.getByTestId("drawing-menu-lock")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await stored(page))[0]!.locked).toBe(true);
  await page.mouse.click(cx - 100, y, { button: "right" });
  await expect(page.getByTestId("drawing-menu-unlock")).toBeVisible();
  // Settings… opens the style popover of the line.
  await page.getByTestId("drawing-menu-settings").click();
  await expect(page.getByTestId("drawing-style")).toBeVisible();
  await page.keyboard.press("Escape");

  // A text field keeps the web view's edit menu: an input and a textarea.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("dialog").locator("input").first();
  await input.click({ button: "right" });
  expect((await prevented()).at(-1)).toBe(false);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+KeyN");
  await page.mouse.click(cx + 150, plot.top + plot.height * 0.7);
  const area = page.getByTestId("note-editor").getByRole("textbox");
  await expect(area).toBeFocused();
  await area.click({ button: "right" });
  expect((await prevented()).at(-1)).toBe(false);
});

test("ctrl_click_on_macos_opens_the_menu_of_a_drawing", async ({ page }) => {
  // The app reads the platform once at load: pretend to be a Mac on every runner.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const ys = [0.3, 0.6].map((f) => Math.round(plot.top + plot.height * f));
  const [top, bottom] = await levels(page, cx, ys);
  await page.mouse.click(cx - 100, ys[0]!);
  expect((await debug(page)).selectedDrawing).toBe(top!.id);

  // macOS turns Ctrl+click into a right click: the press arrives with Ctrl and the main
  // button, then `contextmenu` (sent here by hand, as a headless browser may not).
  await page.keyboard.down("Control");
  await page.mouse.move(cx - 100, ys[1]!);
  await page.mouse.down();
  await page.getByTestId("chart").evaluate((el, [x, y]) => {
    const canvas = el.querySelectorAll("canvas")[0]!;
    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, ctrlKey: true, button: 0 }));
  }, [cx - 100, ys[1]!]);
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.getByTestId("drawing-menu")).toBeVisible();
  // Not a ⌘-click: the line under the pointer is selected alone, not added.
  expect((await debug(page)).selectedDrawings).toEqual([bottom!.id]);
  expect((await debug(page)).selectionBox).toBe(false);
});

test("cmd_box_selects_several_drawings_and_delete_removes_them_in_one_step", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const ys = [0.3, 0.4, 0.7].map((f) => Math.round(plot.top + plot.height * f));
  const all = await levels(page, cx, ys);
  await page.mouse.click(cx, plot.top + plot.height * 0.9);
  await page.mouse.move(cx - 200, ys[0]! - 20);
  const before = await settled(page);

  // ⌘-drag over the top two: a box on the overlay, the base stays as it is.
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx - 200 + i * 10, ys[0]! - 20 + i * ((ys[1]! + 20 - ys[0]! + 20) / 10));
    await nextFrame(page);
  }
  expect((await debug(page)).selectionBox).toBe(true);
  await page.mouse.up();
  await page.keyboard.up("ControlOrMeta");
  const d = await debug(page);
  expect(d.baseDraws).toBe(before.baseDraws);
  expect(d.selectionBox).toBe(false);
  expect([...d.selectedDrawings].sort()).toEqual([all[0]!.id, all[1]!.id].sort());

  // ⌘-click adds the third, ⌘-click again takes it out.
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(cx + 100, ys[2]!);
  expect((await debug(page)).selectedDrawings).toHaveLength(3);
  await page.mouse.click(cx + 100, ys[2]!);
  await page.keyboard.up("ControlOrMeta");
  expect((await debug(page)).selectedDrawings).toHaveLength(2);

  // Dragging one moves both, one undo step.
  await drag(page, [cx + 50, ys[0]!], [cx + 50, ys[0]! + 30]);
  await expect.poll(async () => (await stored(page)).find((s) => s.id === all[0]!.id)!.body.p).toBeLessThan(all[0]!.body.p!);
  await expect.poll(async () => (await stored(page)).find((s) => s.id === all[1]!.id)!.body.p).toBeLessThan(all[1]!.body.p!);
  const moved = await stored(page);
  expect(moved.find((s) => s.id === all[2]!.id)!.body.p).toBe(all[2]!.body.p);
  await page.keyboard.press("ControlOrMeta+z");
  const prices = async () => (await stored(page)).map((s) => s.body.p).sort();
  await expect.poll(prices).toEqual(all.map((s) => s.body.p).sort());

  // Delete removes both; one undo brings both back.
  await page.keyboard.press("Delete");
  const [left] = await storedCount(page, 1);
  expect(left!.id).toBe(all[2]!.id);
  await page.keyboard.press("ControlOrMeta+z");
  await storedCount(page, 3);
});

test("a_group_delete_of_many_drawings_is_one_write_and_one_undo", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const [hi, lo] = await levels(page, cx, [plot.top + plot.height * 0.2, plot.top + plot.height * 0.8].map(Math.round));
  // 40 levels between the two placed ones.
  await page.evaluate(
    ([a, b]) => {
      const all = JSON.parse(localStorage.getItem("sandchart.mock.drawings")!) as { id: string; z: number; body: { p: number } }[];
      const seed = all[0]!;
      const n = 40;
      const list = Array.from({ length: n }, (_, i) => ({ ...seed, id: `many-${i}`, z: i, body: { kind: "hline", p: Math.round(b! + ((a! - b!) * i) / (n - 1)) } }));
      localStorage.setItem("sandchart.mock.drawings", JSON.stringify(list));
    },
    [hi!.body.p!, lo!.body.p!],
  );
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(40);
  const writes = () => page.evaluate(() => (window as unknown as { __sandchartMock: { drawingWrites: number } }).__sandchartMock.drawingWrites);

  await cmdDrag(page, [cx - 300, plot.top + plot.height * 0.15], [cx - 260, plot.top + plot.height * 0.85]);
  expect((await debug(page)).selectedDrawings).toHaveLength(40);
  const before = await writes();
  await page.keyboard.press("Delete");
  await storedCount(page, 0);
  expect(await writes()).toBe(before + 1);
  await page.keyboard.press("ControlOrMeta+z");
  await storedCount(page, 40);
  expect(await writes()).toBe(before + 2);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(40);
});

test("lock_from_the_menu_keeps_every_selected_drawing_in_place", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const ys = [0.3, 0.5].map((f) => Math.round(plot.top + plot.height * f));
  const all = await levels(page, cx, ys);
  await cmdDrag(page, [cx - 300, ys[0]! - 15], [cx - 250, ys[1]! + 15]);
  expect((await debug(page)).selectedDrawings).toHaveLength(2);
  await page.mouse.click(cx, ys[1]!, { button: "right" });
  await expect(page.getByTestId("drawing-menu-settings")).toHaveCount(0);
  await page.getByTestId("drawing-menu-lock").click();
  await expect.poll(async () => (await stored(page)).every((s) => s.locked)).toBe(true);

  await drag(page, [cx, ys[0]!], [cx + 40, ys[0]! + 90]);
  await page.waitForTimeout(300);
  const after = await stored(page);
  for (const d of all) expect(after.find((s) => s.id === d.id)!.body.p).toBe(d.body.p);
  expect((await debug(page)).selectedDrawings).toHaveLength(2);

  // Unlock both again from the menu of the selection.
  await page.mouse.click(cx, ys[0]!, { button: "right" });
  await page.getByTestId("drawing-menu-unlock").click();
  await expect.poll(async () => (await stored(page)).some((s) => s.locked)).toBe(false);
});

test("hide_from_the_menu_persists_across_a_reload_until_shown_from_the_rail", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const ys = [0.3, 0.6].map((f) => Math.round(plot.top + plot.height * f));
  const [top] = await levels(page, cx, ys);
  await page.mouse.click(cx, ys[0]!, { button: "right" });
  await page.getByTestId("drawing-menu-hide").click();
  await expect.poll(async () => (await stored(page)).find((s) => s.id === top!.id)!.hidden).toBe(true);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);
  // The eye says how many are hidden one by one.
  await expect(page.getByTestId("drawings-hidden-badge")).toHaveText("1");
  expect(isBlue(await basePixel(page, plot.left + 80, ys[0]!))).toBe(false);
  // Neither hit nor selected.
  await page.mouse.click(cx - 100, ys[0]!);
  expect((await debug(page)).selectedDrawing).toBeNull();

  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);

  await page.getByTestId("tool-hide-all").click();
  const show = page.getByTestId("visibility-menu-show-hidden");
  await expect(show).toHaveText(/\(1\)/);
  await show.click();
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(2);
  await expect.poll(async () => (await stored(page)).some((s) => s.hidden)).toBe(false);
  await expect(page.getByTestId("drawings-hidden-badge")).toHaveCount(0);
  await page.getByTestId("tool-hide-all").click();
  await expect(page.getByTestId("visibility-menu-show-hidden")).toBeDisabled();
});

test("rect_edge_handle_resizes_one_side_and_trend_middle_moves_the_line", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const cy = Math.round(plot.top + plot.height / 2);
  await page.keyboard.press("Alt+KeyB");
  await page.mouse.click(cx - 300, cy - 150);
  await page.mouse.click(cx - 100, cy - 50);
  const [rect] = await storedCount(page, 1);
  // Eight handles: four corners, then the middles of a's price, b's time, b's price and a's time edges.
  const h = await handles(page, plot);
  expect(h).toHaveLength(8);
  const right = h[5]!;
  await drag(page, right, [right[0] + 60, right[1] + 40]);
  await expect.poll(async () => (await stored(page))[0]!.body.b!.t).toBeGreaterThan(rect!.body.b!.t);
  const r = (await stored(page))[0]!;
  expect(r.body.a).toEqual(rect!.body.a);
  expect(r.body.b!.p).toBe(rect!.body.b!.p);

  await page.keyboard.press("Alt+KeyT");
  await page.mouse.click(cx + 50, cy + 100);
  await page.mouse.click(cx + 250, cy);
  const trend = (await storedCount(page, 2)).find((d) => d.body.kind === "trend")!;
  const th = await handles(page, plot);
  expect(th).toHaveLength(3);
  const mid = th[2]!;
  await drag(page, mid, [mid[0] + 40, mid[1] + 60]);
  await expect.poll(async () => (await stored(page)).find((d) => d.id === trend.id)!.body.a!.p).toBeLessThan(trend.body.a!.p);
  const moved = (await stored(page)).find((d) => d.id === trend.id)!;
  expect(moved.body.a!.t).toBeGreaterThan(trend.body.a!.t);
  expect(moved.body.b!.t).toBeGreaterThan(trend.body.b!.t);
  // Rigid: both ends moved by the same price.
  expect(Math.abs(moved.body.b!.p - moved.body.a!.p - (trend.body.b!.p - trend.body.a!.p))).toBeLessThanOrEqual(1);
});
