import { expect, test, type Page } from "@playwright/test";

// Layout constants from the Design Reference: price axis 72 px, time axis 26 px.
const PRICE_AXIS = 72;
const TIME_AXIS = 26;
const HOUR = 3_600_000;
// The mock's fixed "now" (src/backend/mock.ts); the default timeframe is 1h.
const LAST_TIME = Date.UTC(2026, 10, 27);

interface Plot {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function openChart(page: Page, query = ""): Promise<Plot> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  const box = await page.getByTestId("chart").boundingBox();
  if (!box) throw new Error("chart has no box");
  return { left: box.x, top: box.y, width: box.width - PRICE_AXIS, height: box.height - TIME_AXIS };
}

async function legendTime(page: Page): Promise<number> {
  return Number(await page.getByTestId("legend").getAttribute("data-time"));
}

/** Moves the mouse and waits until the legend has caught up with the next frame. */
async function hover(page: Page, x: number, y: number): Promise<number> {
  await page.mouse.move(x, y);
  await nextFrame(page);
  return legendTime(page);
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

async function drag(page: Page, fromX: number, y: number, dx: number): Promise<void> {
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(fromX + dx, y, { steps: 10 });
  await page.mouse.up();
  await nextFrame(page);
}

async function mockRequests(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __sandchartMock: { getCandles: number } }).__sandchartMock.getCandles,
  );
}

test("drag_pans_chart", async ({ page }) => {
  const plot = await openChart(page);
  const x = plot.left + plot.width / 2;
  const y = plot.top + plot.height / 2;
  const before = await hover(page, x, y);

  await drag(page, x, y, 300);
  const after = await hover(page, x, y);

  expect(after).toBeLessThan(before);
  expect(before - after).toBeGreaterThanOrEqual(10 * HOUR);
  // The content moved with the cursor: the bar that was under it is 300 px to the right now.
  const moved = await hover(page, x + 300, y);
  expect(Math.abs(moved - before)).toBeLessThanOrEqual(HOUR);
});

test("wheel_zooms_at_cursor", async ({ page }) => {
  const plot = await openChart(page);
  const x = plot.left + plot.width * 0.4;
  const y = plot.top + plot.height / 2;
  const away = await hover(page, x + 200, y);
  const under = await hover(page, x, y);

  await page.mouse.wheel(0, -400);
  await nextFrame(page);
  expect(await legendTime(page)).toBe(under);
  // The zoom really happened: the bar 200 px to the right is a different one now.
  expect(await hover(page, x + 200, y)).not.toBe(away);
  expect(await hover(page, x, y)).toBe(under);

  await page.mouse.wheel(0, 400);
  await nextFrame(page);
  expect(await legendTime(page)).toBe(under);
});

test("legend_follows_crosshair", async ({ page }) => {
  const plot = await openChart(page);
  const legend = page.getByTestId("legend");
  // No crosshair: the legend shows the last candle.
  expect(await legendTime(page)).toBe(LAST_TIME);
  await expect(legend).toContainText("BTCUSDT");
  await expect(legend).toContainText("1h");

  const y = plot.top + plot.height / 2;
  const left = await hover(page, plot.left + plot.width * 0.25, y);
  const leftText = await legend.innerText();
  const right = await hover(page, plot.left + plot.width * 0.75, y);
  expect(right).toBeGreaterThan(left);
  expect(await legend.innerText()).not.toBe(leftText);
  for (const label of ["O", "H", "L", "C", "V"]) await expect(legend).toContainText(label);

  // Leaving the plot (onto the time axis) hides the crosshair: back to the last candle.
  await hover(page, plot.left + plot.width / 2, plot.top + plot.height + TIME_AXIS / 2);
  expect(await legendTime(page)).toBe(LAST_TIME);
});

test("pan_to_history_start_stops_loading", async ({ page }) => {
  const bars = 3_500;
  const historyStart = LAST_TIME - (bars - 1) * HOUR;
  const plot = await openChart(page, `?mockHistoryStart=${historyStart}&mockLatency=10`);
  const x = plot.left + plot.width * 0.1;
  const y = plot.top + plot.height / 2;

  // Zoom all the way out, then keep dragging towards older bars.
  await page.mouse.move(plot.left + plot.width / 2, y);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 600);
  for (let i = 0; i < 12; i++) {
    await drag(page, x, y, plot.width * 0.8);
    await page.waitForTimeout(50);
  }
  const loaded = await mockRequests(page);
  // 3 500 bars in pages of 1 000: the first page plus three older ones.
  expect(loaded).toBe(4);

  for (let i = 0; i < 8; i++) {
    await drag(page, x, y, plot.width * 0.8);
    await page.waitForTimeout(50);
  }
  expect(await mockRequests(page)).toBe(loaded);
  // The oldest bar is on screen now.
  expect(await hover(page, plot.left + plot.width - 2, y)).toBeGreaterThanOrEqual(historyStart);
});

interface ChartDebug {
  drawMs: number[];
  axisWidth: number;
  widestLabel: number;
  widestText: string;
  canvasWidth: number;
  plotWidth: number;
}

async function chartDebug(page: Page): Promise<ChartDebug> {
  return page.evaluate(() => {
    const d = (window as unknown as { __sandchartDebug: ChartDebug }).__sandchartDebug;
    return { ...d, drawMs: [...d.drawMs] };
  });
}

for (const [name, query, sample] of [
  ["btc_2_decimals", "?mockPrice=10234567&mockPriceScale=2", "102 345.67"],
  ["tiny_8_decimals", "?mockPrice=1234&mockPriceScale=8", "0.00001234"],
  ["millions_2_decimals", "?mockPrice=123456789&mockPriceScale=2", "1 234 567.89"],
] as const) {
  test(`price_axis_fits_labels_${name}`, async ({ page }) => {
    const plot = await openChart(page, `${query}&mockLatency=0`);
    // Crosshair on, so its price label is part of the measurement too.
    await hover(page, plot.left + plot.width / 2, plot.top + plot.height / 2);
    // The axis is re-measured once the web font has loaded (slow on CI runners).
    await page.evaluate(() => document.fonts.load('11px "IBM Plex Mono"'));
    await nextFrame(page);
    await nextFrame(page);
    const d = await chartDebug(page);
    // The mock really produced labels as long as the sample. Compare text, not pixel
    // widths: glyph advances are rounded differently across platforms (Linux Chromium
    // rounds them to whole pixels), so a width measured elsewhere is not comparable.
    expect(d.widestText.length).toBeGreaterThanOrEqual(sample.length);
    expect(d.axisWidth).toBeGreaterThanOrEqual(PRICE_AXIS);
    expect(d.axisWidth).toBeGreaterThanOrEqual(d.widestLabel + 16);
    // Labels start 8 px into the axis; the axis ends at the canvas edge.
    expect(d.plotWidth + d.axisWidth).toBeCloseTo(d.canvasWidth, 3);
    expect(d.plotWidth + 8 + d.widestLabel).toBeLessThanOrEqual(d.canvasWidth);
  });
}

test("draw_time_under_budget @perf", async ({ page }, info) => {
  const plot = await openChart(page);
  const x = plot.left + plot.width / 2;
  const y = plot.top + plot.height / 2;
  // Zoom out so a full screen of bars (the per-column path) is drawn every frame.
  await page.mouse.move(x, y);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 300);
  await nextFrame(page);

  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean; __sandchartDebug: ChartDebug };
    w.__sandchartDebug.drawMs.length = 0;
    w.__frames = [];
    w.__recording = true;
    const tick = (t: number) => {
      w.__frames.push(t);
      if (w.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.mouse.down();
  const start = Date.now();
  let dir = 1;
  let pos = x;
  while (Date.now() - start < 2_000) {
    pos += dir * 8;
    if (Math.abs(pos - x) > 300) dir = -dir;
    await page.mouse.move(pos, y);
  }
  await page.mouse.up();

  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __recording: boolean };
    w.__recording = false;
    return w.__frames;
  });
  const draws = (await chartDebug(page)).drawMs;
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  const sorted = [...draws].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? NaN;
  const intervals = frames.slice(1).map((t, i) => t - frames[i]!);
  const interval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const note =
    `draw time mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms over ${draws.length} draws; ` +
    `rAF interval mean ${interval.toFixed(2)} ms (information only). ` +
    "The spec target (60 fps with 200 000 candles) is measured on the MacBook Air M1 reference";
  console.log(note);
  info.annotations.push({ type: "draw-time", description: note });
  expect(draws.length).toBeGreaterThan(30);
  expect(mean).toBeLessThan(8);
});
