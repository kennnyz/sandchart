import { expect, test, type Page } from "@playwright/test";

const PRICE_AXIS = 72;
const TIME_AXIS = 26;
/** Palette slot 0 of the dark theme, the default drawing colour. */
const BLUE = [0x6e, 0x9f, 0xd8];

interface Plot {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Stored {
  id: string;
  body: { kind: string; p?: number; a?: { t: number; p: number }; b?: { t: number; p: number } };
}

interface Debug {
  baseDraws: number;
  overlayDraws: number;
  drawingsPainted: number;
  selectedDrawing: string | null;
  hoveredDrawing: string | null;
}

async function openChart(page: Page): Promise<Plot> {
  await page.goto("/");
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

function isBlue(rgba: number[]): boolean {
  return BLUE.every((v, i) => Math.abs(v - rgba[i]!) <= 12);
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
