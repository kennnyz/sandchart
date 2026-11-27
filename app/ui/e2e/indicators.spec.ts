import { expect, test, type Page } from "@playwright/test";

// Indicators against the browser mock (src/backend/mock.ts): built-ins sma, ema,
// bollinger, rsi, macd and the test module "Echo" that any file installs.

interface Debug {
  panes: number;
  drawMs: number[];
}

async function openApp(page: Page, query = "?mockLatency=10"): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
}

async function panes(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __sandchartDebug: Debug }).__sandchartDebug.panes);
}

function rows(page: Page) {
  return page.getByTestId("indicator-legend-row");
}

async function addFromDialog(page: Page, moduleId: string): Promise<void> {
  await page.getByTestId("indicators-button").click();
  const dialog = page.getByTestId("indicators-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(`[data-testid="indicator-option"][data-id="${moduleId}"]`).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test("add_sma_and_change_its_period", async ({ page }) => {
  await openApp(page);
  await addFromDialog(page, "builtin.sma");
  const row = rows(page).first();
  await expect(row.getByTestId("indicator-title")).toHaveText("SMA 20 close");
  // A value arrives once the compute is done.
  await expect(row.getByTestId("indicator-value").first()).toHaveText(/\d/);

  await row.hover();
  await row.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("indicator-settings");
  await expect(settings).toBeVisible();
  await settings.getByLabel("Period").fill("50");
  await expect(row.getByTestId("indicator-title")).toHaveText("SMA 50 close");
  // Out of range is not applied.
  await settings.getByLabel("Period").fill("5000");
  await expect(row.getByTestId("indicator-title")).toHaveText("SMA 50 close");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
});

test("rsi_gets_an_own_pane_hide_and_remove_work", async ({ page }) => {
  await openApp(page);
  expect(await panes(page)).toBe(0);
  await addFromDialog(page, "builtin.rsi");
  await expect.poll(() => panes(page)).toBe(1);
  const row = rows(page).first();
  await expect(row.getByTestId("indicator-title")).toHaveText("RSI 14 close");

  await row.hover();
  await row.getByRole("button", { name: "Hide" }).click();
  await expect.poll(() => panes(page)).toBe(0);
  await expect(row.getByRole("button", { name: "Show" })).toBeVisible();
  await row.getByRole("button", { name: "Show" }).click();
  await expect.poll(() => panes(page)).toBe(1);

  await row.hover();
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect.poll(() => panes(page)).toBe(0);
});

test("instances_last_for_the_page_only_in_the_mock", async ({ page }) => {
  await openApp(page);
  await addFromDialog(page, "builtin.ema");
  await expect(rows(page)).toHaveCount(1);
  // Switching the symbol keeps the instances.
  await page.getByTestId("watchlist-row").nth(1).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().getByTestId("indicator-value").first()).toHaveText(/\d/);
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect(rows(page)).toHaveCount(0);
});

test("a_failing_indicator_shows_its_error_and_candles_still_draw", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockIndicators=sma,rsi&mockIndicatorError=1");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByTestId("indicator-error").first()).toHaveText("SMA stopped: mock: out of fuel");
  await expect(page.getByTestId("indicator-error")).toHaveCount(2);
  // An errored layer gets no pane; the candles are drawn as usual.
  await expect.poll(() => panes(page)).toBe(0);
  const draws = () =>
    page.evaluate(() => (window as unknown as { __sandchartDebug: Debug }).__sandchartDebug.drawMs.length);
  const before = await draws();
  const box = (await page.getByTestId("chart").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(draws).toBeGreaterThan(before);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
});

test("install_from_file_confirms_a_replace_and_shows_repaints", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("indicators-button").click();
  const dialog = page.getByTestId("indicators-dialog");
  await expect(dialog.getByText("Indicators run in a sandbox: no files, no network.")).toBeVisible();
  const file = { name: "echo.wasm", mimeType: "application/wasm", buffer: Buffer.from([0, 97, 115, 109]) };

  await dialog.getByTestId("indicator-file").setInputFiles(file);
  const echo = dialog.locator('[data-testid="indicator-option"][data-id="test.echo"]');
  await expect(echo).toBeVisible();
  await expect(dialog.getByTestId("indicator-replace")).toHaveCount(0);

  // The same module again: an in-dialog confirm row first.
  await dialog.getByTestId("indicator-file").setInputFiles(file);
  const confirm = dialog.getByTestId("indicator-replace");
  await expect(confirm).toContainText("Replace Echo 1.0.0 with 1.0.0?");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await dialog.getByTestId("indicator-file").setInputFiles(file);
  await dialog.getByTestId("indicator-replace").getByRole("button", { name: "Replace" }).click();
  await expect(dialog.getByTestId("indicator-replace")).toHaveCount(0);

  await echo.click();
  await page.keyboard.press("Escape");
  const row = rows(page).first();
  await expect(row.getByTestId("indicator-title")).toHaveText("Echo");
  await expect(row.getByTestId("indicator-repaints")).toHaveText("Repaints: past values can change");
  await expect.poll(() => panes(page)).toBe(1);

  // Uninstalling asks first, then removes the module and its chart instance.
  await page.getByTestId("indicators-button").click();
  const opened = page.getByTestId("indicators-dialog");
  await opened.getByRole("button", { name: "Remove Echo" }).click();
  const ask = opened.getByTestId("indicator-remove");
  await expect(ask).toContainText("Remove Echo? Its indicators on the chart go too.");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(opened.locator('[data-id="test.echo"]')).toHaveCount(1);
  await opened.getByRole("button", { name: "Remove Echo" }).click();
  await opened.getByTestId("indicator-remove").getByRole("button", { name: "Remove" }).click();
  await expect(opened.locator('[data-id="test.echo"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(0);
});

test("a_failed_save_shows_an_error_and_adds_nothing", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockIndicatorSaveError=1");
  await page.getByTestId("indicators-button").click();
  const dialog = page.getByTestId("indicators-dialog");
  await dialog.locator('[data-testid="indicator-option"][data-id="builtin.sma"]').click();
  await expect(dialog.getByTestId("indicator-dialog-error")).toHaveText("mock: cannot save");
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(0);
});

test("a_failed_load_shows_an_error_in_the_dialog_and_retry_works", async ({ page }) => {
  // The first two list calls fail: the one at start and the retry when the dialog opens.
  await openApp(page, "?mockLatency=10&mockIndicatorLoadFailures=2");
  await page.getByTestId("indicators-button").click();
  const dialog = page.getByTestId("indicators-dialog");
  await expect(dialog.getByTestId("indicator-load-error")).toContainText("mock: engine starting");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByTestId("indicator-load-error")).toHaveCount(0);
  await expect(dialog.getByTestId("indicator-option")).toHaveCount(5);
});

test("modules_that_failed_to_load_and_the_service_error_are_shown", async ({ page }) => {
  await openApp(page, "?mockLatency=10&mockIndicatorProblems=1");
  await page.getByTestId("indicators-button").click();
  const dialog = page.getByTestId("indicators-dialog");
  await expect(dialog.getByTestId("indicator-service-error")).toHaveText(
    "Indicators did not load: mock: cannot read the installed indicators",
  );
  const broken = dialog.getByTestId("indicator-failed");
  await expect(broken).toContainText("test.broken");
  await expect(broken).toContainText("Did not load: mock: not an indicator component");
  await broken.getByRole("button", { name: "Remove test.broken" }).click();
  await dialog.getByTestId("indicator-remove").getByRole("button", { name: "Remove" }).click();
  await expect(dialog.getByTestId("indicator-failed")).toHaveCount(0);
});
