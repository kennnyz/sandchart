import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// The main screen against the browser mock (src/backend/index.ts). Screenshots go to
// the test report and, when SANDCHART_SHOTS_DIR is set, into that directory too.

async function openApp(page: Page, query = "?mockLatency=10"): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
}

function legend(page: Page) {
  return page.getByTestId("legend");
}

async function watchlistOrder(page: Page): Promise<string[]> {
  return page.getByTestId("watchlist-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-symbol") ?? ""));
}

async function storedWatchlist(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (JSON.parse(localStorage.getItem("sandchart.mock.watchlist") ?? "[]") as { symbol: string }[]).map((i) => i.symbol),
  );
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  // Let fonts and the next frame settle so the capture is the steady state.
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => r(null)))));
  const body = await page.screenshot();
  await info.attach(name, { body, contentType: "image/png" });
  const dir = process.env.SANDCHART_SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `task-9-${name}.png`) });
  }
}

test("search_opens_symbol", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();
  await input.fill("eth");
  await input.press("Enter");
  await expect(page.getByTestId("search")).toBeHidden();
  await expect(legend(page)).toHaveAttribute("data-symbol", "ETHUSDT");
  await expect(legend(page)).toContainText("ETHUSDT");
  await expect(page.getByTestId("symbol-button")).toContainText("ETHUSDT");
});

test("symbol_button_opens_search_and_escape_closes_it", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("symbol-button").click();
  await expect(page.getByTestId("search")).toBeVisible();
  await expect(page.getByTestId("search-row").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search")).toBeHidden();
});

test("stale_response_is_ignored", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockSlow=ETHUSDT&mockSlowLatency=1500");
  const row = (s: string) => page.locator(`[data-testid="watchlist-row"][data-symbol="${s}"]`);
  await row("ETHUSDT").click();
  await row("SOLUSDT").click();
  await expect(legend(page)).toHaveAttribute("data-symbol", "SOLUSDT");
  // The slow ETH page lands after this; it must not replace SOL.
  await page.waitForTimeout(2_000);
  await expect(legend(page)).toHaveAttribute("data-symbol", "SOLUSDT");
  await expect(legend(page)).toContainText("SOLUSDT");
  await expect(legend(page)).not.toContainText("ETHUSDT");
});

test("switch_clears_the_old_chart_and_shows_loading", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockSlow=ETHUSDT&mockSlowLatency=1500");
  await page.locator('[data-testid="watchlist-row"][data-symbol="ETHUSDT"]').click();
  // Immediately: the new name, no candle values from the old chart, the loading state.
  await expect(legend(page)).toContainText("ETHUSDT");
  await expect(legend(page)).toHaveAttribute("data-time", "");
  await expect(legend(page)).toHaveAttribute("data-symbol", "");
  await expect(page.getByTestId("loading")).toContainText("Loading ETHUSDT · 1h");
  await expect(legend(page)).toHaveAttribute("data-symbol", "ETHUSDT");
  await expect(page.getByTestId("loading")).toBeHidden();
});

test("timeframe_switch_reloads", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "4h", exact: true }).click();
  await expect(legend(page)).toContainText("4h · Mock");
  await expect(legend(page)).toHaveAttribute("data-time", String(Date.UTC(2026, 10, 27)));
  await expect(page.getByRole("button", { name: "4h", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The "more" menu holds the other timeframes.
  await page.getByTestId("tf-more").click();
  await page.getByRole("menuitem", { name: "30m" }).click();
  await expect(legend(page)).toContainText("30m · Mock");
});

test("watchlist_persists_order", async ({ page }) => {
  await openApp(page);
  const before = await watchlistOrder(page);
  expect(before.length).toBeGreaterThanOrEqual(3);
  const rows = page.getByTestId("watchlist-row");
  const from = await rows.nth(0).boundingBox();
  const to = await rows.nth(2).boundingBox();
  if (!from || !to) throw new Error("rows have no box");
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 40, to.y + to.height / 2 + 4, { steps: 10 });
  await page.mouse.up();
  const after = [before[1], before[2], before[0], ...before.slice(3)];
  await expect.poll(() => watchlistOrder(page)).toEqual(after);
  // A drag is not a click: the open chart did not change.
  await expect(legend(page)).toHaveAttribute("data-symbol", before[0]!);
  // Saved through setWatchlist into the mock's storage (async, so wait for it).
  await expect.poll(() => storedWatchlist(page)).toEqual(after);

  await page.reload();
  await expect(legend(page)).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(() => watchlistOrder(page)).toEqual(after);
});

test("watchlist_add_and_remove", async ({ page }) => {
  await openApp(page);
  expect(await watchlistOrder(page)).not.toContain("DOGEUSDT");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("search-input").fill("doge");
  await expect(page.getByTestId("search-row").first()).toContainText("DOGE");
  await page.getByTestId("search-input").press("Shift+Enter");
  await expect.poll(() => watchlistOrder(page)).toContain("DOGEUSDT");
  await expect.poll(() => storedWatchlist(page)).toContain("DOGEUSDT");
  await page.reload();
  await expect.poll(() => watchlistOrder(page)).toContain("DOGEUSDT");

  const row = page.locator('[data-testid="watchlist-row"][data-symbol="DOGEUSDT"]');
  await row.hover();
  await row.getByTestId("watchlist-remove").click();
  await expect.poll(() => watchlistOrder(page)).not.toContain("DOGEUSDT");
  await expect.poll(() => storedWatchlist(page)).not.toContain("DOGEUSDT");
  await page.reload();
  await expect(legend(page)).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(() => watchlistOrder(page)).not.toContain("DOGEUSDT");
});

test("watchlist_shows_24h_change", async ({ page }) => {
  await openApp(page);
  const first = page.getByTestId("watchlist-row").first();
  await expect(first).toContainText("+1.84%");
});

test("offline_shows_banner", async ({ page }, info) => {
  await openApp(page, "?mockLatency=10&mockWarning=1&mockConnection=offline");
  const banner = page.getByTestId("banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Can't reach Mock. Showing cached candles up to");
  await expect(banner).toContainText(/Retry in \d+ s/);
  // The chart is still drawn from the cached candles.
  await expect(legend(page)).toHaveAttribute("data-symbol", "BTCUSDT");
  await expect(page.getByTestId("status-bar")).toContainText("offline");
  await shot(page, info, "offline-banner");
});

test("banner_names_rate_limit_and_waits_for_retry_after", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockWarning=rate_limited&mockRetryAfter=90");
  const banner = page.getByTestId("banner");
  await expect(banner).toContainText("Mock is limiting requests from this computer. Showing cached candles up to");
  await expect(banner).toContainText(/Retry in (8\d|90) s/);
});

test("banner_names_region_block", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockWarning=blocked");
  await expect(page.getByTestId("banner")).toContainText("Mock is not available in your region.");
});

test("status_bar_shows_connecting_before_first_contact", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockConnection=connecting");
  await expect(page.getByTestId("status-bar")).toContainText("Mock spot · connecting");
  await expect(page.getByTestId("connection")).toContainText("Connecting");
});

test("first_run_opens_the_default_pair_after_the_instrument_sync", async ({ page }) => {
  await page.goto("/?mockLatency=10&mockWatchlist=&mockSyncDelay=1000");
  await expect(page.getByTestId("loading")).toContainText("Loading BTCUSDT");
  await expect(legend(page)).toHaveAttribute("data-symbol", "BTCUSDT", { timeout: 5_000 });
  await expect(legend(page)).toHaveAttribute("data-time", /^\d+$/);
});

test("no_banner_when_online", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("banner")).toHaveCount(0);
  await expect(page.getByTestId("status-bar")).toContainText("Mock spot · connected");
  await expect(page.getByTestId("status-bar")).toContainText("UTC");
});

test("theme_toggle_persists", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-button").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(legend(page)).toHaveAttribute("data-time", /^\d+$/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("sandchart.theme"))).toBe("light");
});

test("language_switch", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("lang-button")).toHaveText("EN");
  await page.getByTestId("lang-button").click();
  await expect(page.getByTestId("lang-button")).toHaveText("RU");
  await expect(page.getByTestId("status-bar")).toContainText("подключено");
  await expect(page.getByTestId("watchlist")).toContainText("Список");
  // Legend letters are translated too.
  await expect(legend(page)).toContainText("Макс");
  await page.reload();
  await expect(page.getByTestId("lang-button")).toHaveText("RU");
});

test("empty_watchlist_state", async ({ page }, info) => {
  await openApp(page, "?mockLatency=10&mockWatchlist=");
  const empty = page.getByTestId("watchlist-empty");
  await expect(empty).toContainText("No pairs yet");
  await expect(empty.getByRole("button")).toContainText("Add a pair");
  await shot(page, info, "empty-watchlist");
  await empty.getByRole("button").click();
  await expect(page.getByTestId("search")).toBeVisible();
});

test("start_of_history_is_marked", async ({ page }) => {
  // 300 bars only: the whole history fits on screen.
  const start = Date.UTC(2026, 10, 27) - 299 * 3_600_000;
  await openApp(page, `?mockLatency=10&mockHistoryStart=${start}`);
  // The label appears on the frame after the history start is known; wait for it.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __sandchartDebug: { historyLabel: string | null } }).__sandchartDebug.historyLabel,
      ),
    )
    .toBe("Start of history|First candle 14 Nov 2026");
});

test("screens_match_design", async ({ page }, info) => {
  await openApp(page);
  await shot(page, info, "main-dark");
  await page.getByTestId("symbol-button").click();
  await expect(page.getByTestId("search-row").first()).toBeVisible();
  await page.getByTestId("search-input").fill("usdt");
  await expect(page.getByTestId("search-row").nth(2)).toBeVisible();
  await shot(page, info, "search-dark");
  await page.keyboard.press("Escape");
  await page.getByTestId("theme-button").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await shot(page, info, "main-light");
});

test("watchlist_add_button_adds_with_enter_and_click", async ({ page }) => {
  await openApp(page);
  await expect(legend(page)).toContainText("BTCUSDT");

  await page.getByTestId("watchlist-add").click();
  await page.getByTestId("search-input").fill("doge");
  await expect(page.getByTestId("search-row").first()).toContainText("DOGE");
  await page.getByTestId("search-input").press("Enter");
  await expect.poll(() => watchlistOrder(page)).toContain("DOGEUSDT");
  // Adding does not switch the chart.
  await expect(legend(page)).toContainText("BTCUSDT");

  await page.getByTestId("watchlist-add").click();
  await page.getByTestId("search-input").fill("ada");
  await page.getByTestId("search-row").first().click();
  await expect.poll(() => watchlistOrder(page)).toContain("ADAUSDT");
  await expect(legend(page)).toContainText("BTCUSDT");
});

test("watchlist_can_be_hidden_and_shown", async ({ page }) => {
  await openApp(page);
  const chartWidth = () => page.getByTestId("chart").evaluate((el) => el.getBoundingClientRect().width);
  const before = await chartWidth();

  await page.getByTestId("watchlist-hide").click();
  await expect(page.getByTestId("watchlist")).toBeHidden();
  await expect.poll(chartWidth).toBeGreaterThan(before + 200);

  await page.reload();
  await expect(legend(page)).toHaveAttribute("data-time", /^\d+$/);
  await expect(page.getByTestId("watchlist")).toBeHidden();

  await page.getByTestId("watchlist-show").click();
  await expect(page.getByTestId("watchlist")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("watchlist")).toBeVisible();
});
