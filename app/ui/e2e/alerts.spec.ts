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
  plusButton: { x: number; y: number } | null;
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

test("first_vertical_pan_after_a_timeframe_switch_moves_the_price_levels", async ({ page }) => {
  const plot = await openChart(page);
  const x = plot.left + plot.width / 2;
  const y = plot.top + plot.height / 3;
  await page.getByRole("button", { name: "5m", exact: true }).click();
  await expect(page.getByTestId("legend")).toContainText("5m");
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);

  // A price alert gives us a fixed price whose screen position we can track.
  await page.mouse.move(x, y);
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  await expect.poll(async () => (await debug(page)).alertLevels.length).toBe(1);
  const before = (await debug(page)).alertLevels[0]!.y;
  await page.mouse.move(x, y + 30);
  await page.mouse.down();
  await page.mouse.move(x, y + 90);
  await page.mouse.up();
  const after = (await debug(page)).alertLevels[0]!.y;
  expect(Math.abs(after - before - 60)).toBeLessThan(2);
});

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
  // The panel shows the line's price, and the line carries a bell tag.
  await expect(page.getByTestId("alert-level")).toHaveText(price2(line!.body.p!));
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __sandchartDebug: { lineBells: string[] } }).__sandchartDebug.lineBells))).toEqual([line!.id]);

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

  // Deleting the line deletes its alert, once that is agreed.
  await pop.getByTestId("drawing-style-delete").click();
  const ask = page.getByTestId("drawing-delete-confirm");
  await expect(ask).toContainText("This also deletes its alert");
  await page.getByTestId("drawing-delete-confirm-ok").click();
  await expect(pop).toBeHidden();
  await alertCount(page, 0);
  await expect(page.getByTestId("alerts-empty")).toBeVisible();
});

test("deleting_lines_with_alerts_asks_first_with_the_key_and_for_a_group", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const ys = [0.3, 0.5].map((f) => Math.round(plot.top + plot.height * f));
  for (const y of ys) {
    await page.keyboard.press("Alt+KeyH");
    await page.mouse.click(cx, y);
  }
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(2);
  // An alert on the first line only.
  await page.mouse.dblclick(cx, ys[0]!);
  await page.getByTestId("drawing-alert-set").click();
  await alertCount(page, 1);
  await expect(page.getByTestId("alert-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drawing-style")).toBeHidden();

  // Delete on the line asks; Esc keeps the line and its alert.
  await page.mouse.click(cx, ys[0]!);
  await page.keyboard.press("Delete");
  const ask = page.getByTestId("drawing-delete-confirm");
  await expect(ask).toContainText("Delete the line?");
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  expect(await storedDrawings(page)).toHaveLength(2);
  await alertCount(page, 1);

  // Both selected: the question names the count; Delete removes both and the alert.
  // Off the line's middle handle, where ⌘ would snap the handle instead.
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(cx - 150, ys[1]!);
  await page.keyboard.up("ControlOrMeta");
  await page.keyboard.press("Delete");
  await expect(ask).toContainText("Delete 2 drawings?");
  await expect(ask).toContainText("alerts of 1 of them");
  await page.getByTestId("drawing-delete-confirm-ok").click();
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(0);
  await alertCount(page, 0);

  // A line without an alert goes at once.
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, ys[1]!);
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(1);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(0);
  await expect(ask).toHaveCount(0);
});

test("a_line_menu_adds_a_crossing_alert_at_once_and_removes_it", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2) - 120;
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y);
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(1);
  const [line] = await storedDrawings(page);

  await page.mouse.click(cx, y, { button: "right" });
  const menu = page.getByTestId("drawing-menu");
  await expect(menu.getByTestId("drawing-menu-remove-alert")).toHaveCount(0);
  await menu.getByTestId("drawing-menu-add-alert").click();
  await expect(menu).toHaveCount(0);
  const [set] = await alertCount(page, 1);
  expect(set).toMatchObject({ direction: "cross", active: true, kind: { kind: "drawing", drawingId: line!.id } });
  await expect(page.getByTestId("alert-row")).toHaveCount(1);

  await page.mouse.click(cx, y, { button: "right" });
  await expect(menu.getByTestId("drawing-menu-add-alert")).toHaveCount(0);
  await menu.getByTestId("drawing-menu-remove-alert").click();
  await alertCount(page, 0);
  expect(await storedDrawings(page)).toHaveLength(1);

  // Several selected: no alert items.
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y + 60);
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(cx - 60, y);
  await page.keyboard.up("ControlOrMeta");
  await page.mouse.click(cx - 60, y, { button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("drawing-menu-add-alert")).toHaveCount(0);
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

test("alerts_of_the_replayed_pair_say_they_are_paused", async ({ page }) => {
  const plot = await openChart(page);
  await page.mouse.move(Math.round(plot.left + plot.width / 2), Math.round(plot.top + plot.height * 0.4));
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  await alertCount(page, 1);
  const row = page.getByTestId("alert-row");
  await expect(row).toContainText("Active");
  await page.getByTestId("replay-button").click();
  await page.mouse.click(Math.round(plot.left + plot.width / 2), Math.round(plot.top + plot.height / 2));
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect(row).toHaveAttribute("data-paused", "true");
  await expect(row).toContainText("Paused during replay");
  await page.getByTestId("replay-exit").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");
  await expect(row).toHaveAttribute("data-paused", "false");
  await expect(row).toContainText("Active");
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
  await expect(page.getByTestId("chart").locator("canvas").first()).toHaveCSS("cursor", "ns-resize");

  // A press on it picks the alert in the panel.
  const row = page.getByTestId("alert-row");
  await expect(row).toHaveAttribute("data-selected", "false");
  await page.mouse.click(cx - 150, plot.top + level!.y);
  await expect(row).toHaveAttribute("data-selected", "true");

  // A drag moves it: the same alert, armed at the new price, and the level stays where it was dropped.
  await page.mouse.move(cx - 150, plot.top + level!.y);
  await page.mouse.down();
  await page.mouse.move(cx - 150, plot.top + level!.y + 30, { steps: 5 });
  await page.mouse.move(cx - 150, plot.top + level!.y + 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => ((await alerts(page))[0]!.kind as { price: number }).price).toBeLessThan((set!.kind as { price: number }).price);
  const [moved] = await alerts(page);
  expect(moved).toMatchObject({ id: set!.id, active: true, direction: "cross" });
  await expect.poll(async () => Math.round((await debug(page)).alertLevels[0]!.y - level!.y)).toBe(60);
  expect(await alerts(page)).toHaveLength(1);

  // Fired: nothing left to watch, so no level.
  const price = (moved!.kind as { price: number }).price;
  await feed(page, price - 300, price - 100, price - 100);
  await feed(page, price - 300, price + 150, price + 120);
  await expect(row).toHaveAttribute("data-state", "fired");
  await expect.poll(async () => (await debug(page)).alertLevels.length).toBe(0);
});

/** `ticks` at 2 decimals as the chart writes them: thin-space thousands. */
function price2(ticks: number): string {
  const [int, frac] = (ticks / 100).toFixed(2).split(".");
  return `${int!.replace(/\B(?=(\d{3})+$)/g, "\u2009")}.${frac}`;
}

test("right_click_on_an_alert_level_removes_the_alert", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.mouse.move(cx, y);
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  await alertCount(page, 1);
  await expect.poll(async () => (await debug(page)).alertLevels.length).toBe(1);
  const ly = plot.top + (await debug(page)).alertLevels[0]!.y;

  // Off the level: no menu of ours (the drawing menu needs a drawing).
  await page.mouse.click(cx - 150, ly + 60, { button: "right" });
  await expect(page.getByTestId("alert-menu")).toHaveCount(0);
  await expect(page.getByTestId("drawing-menu")).toHaveCount(0);

  await page.mouse.click(cx - 150, ly, { button: "right" });
  const menu = page.getByTestId("alert-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("drawing-menu")).toHaveCount(0);
  await expect(page.getByTestId("alert-menu-remove")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(await alerts(page)).toHaveLength(1);

  await page.mouse.click(cx - 150, ly, { button: "right" });
  await page.getByTestId("alert-menu-remove").click();
  await alertCount(page, 0);
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await debug(page)).alertLevels.length).toBe(0);
});

test("right_click_on_a_drawing_over_an_alert_level_keeps_the_drawing_menu", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.mouse.move(cx, y);
  await nextFrame(page);
  await page.keyboard.press("Alt+KeyA");
  await alertCount(page, 1);
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.click(cx, y);
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(1);
  await page.mouse.click(cx, y, { button: "right" });
  await expect(page.getByTestId("drawing-menu")).toBeVisible();
  await expect(page.getByTestId("alert-menu")).toHaveCount(0);
});

test("the_plus_at_the_crosshair_price_sets_an_alert_or_draws_a_level_there", async ({ page }) => {
  const plot = await openChart(page);
  const cx = Math.round(plot.left + plot.width / 2);
  const y = Math.round(plot.top + plot.height * 0.4);
  await page.mouse.move(cx, y);
  const shown = await debug(page);
  expect(shown.plusButton).not.toBeNull();
  expect(Math.abs(plot.top + shown.plusButton!.y - y)).toBeLessThan(1);
  const px = plot.left + shown.plusButton!.x;
  expect(px).toBeGreaterThan(plot.left + plot.width - 24);
  expect(px).toBeLessThan(plot.left + plot.width);

  // It follows the crosshair on the overlay only; off the price plot it goes away.
  const before = await debug(page);
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx - 100 + i * 20, y + (i % 3) * 7);
    await nextFrame(page);
  }
  await page.mouse.move(px, y);
  const after = await debug(page);
  expect(after.baseDraws).toBe(before.baseDraws);
  expect(Math.abs(plot.top + after.plusButton!.y - y)).toBeLessThan(1);
  await expect(page.getByTestId("chart").locator("canvas").first()).toHaveCSS("cursor", "pointer");
  await page.mouse.move(cx, plot.top + plot.height + 10);
  expect((await debug(page)).plusButton).toBeNull();

  // With the level tool armed, a press on the + neither places a line nor pans; focus comes back.
  await page.mouse.move(cx, y);
  await nextFrame(page);
  const hovered = await page.getByTestId("legend").getAttribute("data-time");
  await page.getByTestId("replay-button").focus();
  await page.keyboard.press("Alt+KeyH");
  await page.mouse.move(px, y);
  await nextFrame(page);
  await page.mouse.down();
  await page.mouse.move(px - 200, y, { steps: 5 });
  await page.mouse.up();
  const menu = page.getByTestId("price-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("price-menu-buy")).toHaveCount(0);
  const alertItem = page.getByTestId("price-menu-alert");
  await expect(alertItem).toContainText(/Add alert on BTCUSDT at [\d\u2009]+\.\d\d/);
  await expect(alertItem).toContainText(/A$/);
  await expect(page.getByTestId("price-menu-hline")).toContainText(/Draw horizontal line at [\d\u2009]+\.\d\d/);
  await expect(page.getByTestId("price-menu-hline")).toContainText(/H$/);
  await expect(alertItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("price-menu-hline")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("replay-button")).toBeFocused();
  expect(await storedDrawings(page)).toHaveLength(0);
  await page.mouse.move(cx, y);
  await nextFrame(page);
  expect(await page.getByTestId("legend").getAttribute("data-time")).toBe(hovered);
  await page.keyboard.press("Escape");

  // The alert: at the price of the label, direction cross, as with Alt+A.
  await page.mouse.move(px, y);
  await nextFrame(page);
  await page.mouse.click(px, y);
  const label = (await alertItem.textContent()) ?? "";
  await alertItem.click();
  const [set] = await alertCount(page, 1);
  expect(set).toMatchObject({ direction: "cross", active: true, kind: { kind: "price" } });
  const price = (set!.kind as { price: number }).price;
  expect(label).toContain(`at ${price2(price)}`);
  await expect(menu).toHaveCount(0);

  // The level: exactly at that price, selected.
  await page.mouse.move(px, y);
  await nextFrame(page);
  await page.mouse.click(px, y);
  await expect(page.getByTestId("price-menu-hline")).toContainText(`at ${price2(price)}`);
  await expect(alertItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await storedDrawings(page)).length).toBe(1);
  expect((await storedDrawings(page))[0]!.body).toEqual({ kind: "hline", p: price });
});
