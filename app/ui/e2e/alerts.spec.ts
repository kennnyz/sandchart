import { expect, test, type Page } from "@playwright/test";

const PRICE_AXIS = 72;
const TIME_AXIS = 26;

interface Plot {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StoredAlert {
  id: string;
  kind: { kind: "price"; price: number } | { kind: "drawing"; drawingId: string };
  direction: string;
  active: boolean;
  triggeredPrice: number | null;
}

interface Debug {
  baseDraws: number;
  overlayDraws: number;
  lastBarTime: number | null;
  alertLevels: { id: string; y: number }[];
}

async function openChart(page: Page): Promise<Plot> {
  await page.goto("/");
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  const box = await page.getByTestId("chart").boundingBox();
  if (!box) throw new Error("chart has no box");
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

async function debug(page: Page): Promise<Debug> {
  await nextFrame(page);
  return page.evaluate(() => ({ ...(window as unknown as { __sandchartDebug: Debug }).__sandchartDebug }));
}

/** What the mock has stored (it keeps alerts in localStorage). */
async function alerts(page: Page): Promise<StoredAlert[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sandchart.mock.alerts") ?? "[]") as StoredAlert[]);
}

async function alertCount(page: Page, n: number): Promise<StoredAlert[]> {
  await expect.poll(async () => (await alerts(page)).length).toBe(n);
  return alerts(page);
}

async function storedDrawings(page: Page): Promise<{ id: string; body: { p?: number } }[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sandchart.mock.drawings") ?? "[]"));
}

/** A live update of the chart's last bar with this range and close, through the mock's feed. */
async function feed(page: Page, low: number, high: number, close: number): Promise<void> {
  const time = (await debug(page)).lastBarTime!;
  await page.evaluate(
    (c) =>
      (window as unknown as { __sandchartMock: { emitLive(e: unknown): void } }).__sandchartMock.emitLive({
        kind: "candle",
        time: c.time,
        open: c.close,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 1,
        closed: false,
      }),
    { time, low, high, close },
  );
}

test("alt_a_sets_a_price_alert_that_fires_once_on_the_live_feed", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await expect(page.getByTestId("alerts-empty")).toBeVisible();

  await page.mouse.move(cx, y);
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  const [set] = await alertCount(page, 1);
  expect(set).toMatchObject({ direction: "cross", active: true, kind: { kind: "price" } });
  const price = (set!.kind as { price: number }).price;
  const row = page.getByTestId("alert-row");
  await expect(row).toHaveAttribute("data-state", "active");
  await expect(row).toContainText("BTCUSDT");

  // Moving the mouse with an alert set still redraws only the overlay.
  const before = await debug(page);
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(cx - 200 + i * 20, y + ((i % 5) - 2) * 10);
    await nextFrame(page);
  }
  const after = await debug(page);
  expect(after.baseDraws).toBe(before.baseDraws);
  expect(after.overlayDraws).toBeGreaterThan(before.overlayDraws + 10);

  // The feed crosses the level: the toast shows and the alert turns inactive, once.
  await feed(page, price - 300, price - 100, price - 100);
  await feed(page, price - 300, price + 150, price + 120);
  await expect(page.getByTestId("alert-toast")).toContainText("BTCUSDT");
  await expect(row).toHaveAttribute("data-state", "fired");
  await expect(row).toHaveAttribute("data-unseen", "true");
  const [fired] = await alerts(page);
  expect(fired).toMatchObject({ active: false, triggeredPrice: price + 120 });
  await feed(page, price - 300, price + 150, price - 200);
  await feed(page, price - 300, price + 400, price + 300);
  expect((await alerts(page))[0]!.triggeredPrice).toBe(price + 120);

  // Closing the toast counts as seen; arming it again makes it active; delete removes it.
  await page.getByTestId("alert-toast").getByRole("button").click();
  await expect(page.getByTestId("alert-toast")).toBeHidden();
  await expect(row).toHaveAttribute("data-unseen", "false");
  await page.getByTestId("alert-rearm").click();
  await expect(row).toHaveAttribute("data-state", "active");
  await expect.poll(async () => (await alerts(page))[0]!.active).toBe(true);
  await page.getByTestId("alert-delete").click();
  await alertCount(page, 0);
  await expect(page.getByTestId("alerts-empty")).toBeVisible();
});

test("an_hline_popover_sets_its_alert_and_deleting_the_line_deletes_it", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.3);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y);
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(1);
  const [line] = await storedDrawings(page);

  await page.mouse.dblclick(cx, y);
  const pop = page.getByTestId("drawing-style");
  await expect(pop).toBeVisible();
  const section = pop.getByTestId("drawing-alert");
  await expect(section).toHaveAttribute("data-state", "none");
  await pop.locator("#dstyle-alert-direction").selectOption("above");
  await pop.getByTestId("drawing-alert-set").click();
  const [set] = await alertCount(page, 1);
  expect(set).toMatchObject({ direction: "above", active: true, kind: { kind: "drawing", drawingId: line!.id } });
  await expect(section).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("alert-row")).toContainText("Line");

  // Another direction re-sets the same alert.
  await pop.locator("#dstyle-alert-direction").selectOption("below");
  await expect.poll(async () => (await alerts(page))[0]!.direction).toBe("below");
  expect(await alerts(page)).toHaveLength(1);

  // The line fires its alert from the feed.
  const p = line!.body.p!;
  await feed(page, p + 100, p + 300, p + 200);
  await feed(page, p - 50, p + 300, p + 20);
  await expect(page.getByTestId("alert-toast")).toContainText("the line");
  await expect(section).toHaveAttribute("data-state", "fired");
  expect((await alerts(page))[0]).toMatchObject({ active: false, triggeredPrice: p });

  // Deleting the line deletes its alert.
  await pop.getByTestId("drawing-style-delete").click();
  await expect(pop).toBeHidden();
  await alertCount(page, 0);
  await expect(page.getByTestId("alerts-empty")).toBeVisible();
});

test("removing_an_alert_from_the_popover_keeps_the_line", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.6);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y);
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(1);
  await page.mouse.dblclick(cx, y);
  const pop = page.getByTestId("drawing-style");
  await pop.getByTestId("drawing-alert-set").click();
  await alertCount(page, 1);
  await pop.getByTestId("drawing-alert-remove").click();
  await alertCount(page, 0);
  await expect(pop.getByTestId("drawing-alert")).toHaveAttribute("data-state", "none");
  expect(await storedDrawings(page)).toHaveLength(1);
});

test("alt_a_sets_no_alert_during_a_replay", async ({ page }) => {
  const plot = await openChart(page);
  await page.getByTestId("replay-button").click();
  await expect(page.getByTestId("replay-hint")).toBeVisible();
  await page.mouse.click(Math.round(plot.left + plot.width / 2), Math.round(plot.top + plot.height / 2));
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await page.mouse.move(Math.round(plot.left + plot.width / 3), Math.round(plot.top + plot.height * 0.4));
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  await nextFrame(page);
  await page.waitForTimeout(200);
  expect(await alerts(page)).toEqual([]);
  await expect(page.getByTestId("alerts-empty")).toBeVisible();
});

test("a_refused_alert_shows_its_reason_once_until_closed", async ({ page }) => {
  // 100 active alerts already: the next one is refused.
  await page.addInitScript(() => {
    const all = Array.from({ length: 100 }, (_, i) => ({
      id: `full-${i}`,
      instrument: { source: "mock", symbol: "BTCUSDT" },
      priceScale: 2,
      kind: { kind: "price", price: 1 + i },
      direction: "cross",
      active: true,
      createdAt: i,
      triggeredAt: null,
      triggeredPrice: null,
    }));
    if (localStorage.getItem("sandchart.mock.alerts") === null) localStorage.setItem("sandchart.mock.alerts", JSON.stringify(all));
  });
  const plot = await openChart(page);
  await page.mouse.move(Math.round(plot.left + plot.width / 2), Math.round(plot.top + plot.height * 0.4));
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  const strip = page.getByTestId("alert-error");
  await expect(strip).toContainText("at most 100 alerts can be active");
  const text = (await strip.textContent()) ?? "";
  expect(text.split("at most 100 alerts").length - 1).toBe(1);
  expect(await strip.getAttribute("title")).toBeNull();
  await strip.getByRole("button").click();
  await expect(strip).toHaveCount(0);
  expect(await alerts(page)).toHaveLength(100);
});

test("an_active_price_alert_is_a_level_on_the_chart_that_picks_it_in_the_panel", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.mouse.move(cx, y);
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  const [set] = await alertCount(page, 1);
  await expect.poll(async () => (await debug(page)).alertLevels.length).toBe(1);
  const [level] = (await debug(page)).alertLevels;
  expect(level!.id).toBe(set!.id);
  expect(Math.abs(plot.top + level!.y - y)).toBeLessThan(1.5);

  // Hovering the level and moving about redraws only the overlay.
  const before = await debug(page);
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx - 100 + i * 20, plot.top + level!.y + (i % 3) - 1);
    await nextFrame(page);
  }
  const after = await debug(page);
  expect(after.baseDraws).toBe(before.baseDraws);
  await expect(page.getByTestId("chart").locator("canvas").first()).toHaveCSS("cursor", "pointer");

  // A press on it picks the alert in the panel.
  const row = page.getByTestId("alert-row");
  await expect(row).toHaveAttribute("data-selected", "false");
  await page.mouse.click(cx - 150, plot.top + level!.y);
  await expect(row).toHaveAttribute("data-selected", "true");

  // Fired: nothing left to watch, so no level.
  const price = (set!.kind as { price: number }).price;
  await feed(page, price - 300, price - 100, price - 100);
  await feed(page, price - 300, price + 150, price + 120);
  await expect(row).toHaveAttribute("data-state", "fired");
  await expect.poll(async () => (await debug(page)).alertLevels.length).toBe(0);
});
