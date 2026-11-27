import { expect, test, type Page } from "@playwright/test";

// Updates against the browser mock (src/backend/mock.ts): `mockUpdate` is the version the
// check finds, `mockUpdateDelay=0` runs the first automatic check at once instead of after
// 10 s, and `window.__sandchartMock.checkUpdate` counts the checks.

async function openApp(page: Page, query: string): Promise<void> {
  await page.goto(`/?mockLatency=10&${query}`);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
}

const checks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sandchartMock: { checkUpdate: number } }).__sandchartMock.checkUpdate);

test.beforeEach(async ({ page }) => {
  // English copy and the default (auto on) for every test; the page sets nothing before this.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("e2e-init")) {
      sessionStorage.setItem("e2e-init", "1");
      localStorage.setItem("sandchart.lang", "en");
      localStorage.removeItem("sandchart.updates.auto");
    }
  });
});

test("an available update installs with progress, then restarts", async ({ page }) => {
  await openApp(page, "mockUpdate=0.3.0&mockUpdateDelay=0");
  const banner = page.getByTestId("update-banner");
  await expect(banner).toHaveText("Update 0.3.0 available");
  await banner.click();
  const panel = page.getByTestId("update-panel");
  await expect(panel).toContainText("Faster chart redraws.");
  await panel.getByTestId("update-install").click();
  await expect(panel.getByTestId("update-progress")).toHaveText(/^Downloading… \d+%$/);
  await expect(panel.getByTestId("update-progress")).toHaveText("Restarting…");
  await expect(banner).toHaveText("Restarting…");
});

test("a failed download shows the error and Retry checks again", async ({ page }) => {
  await openApp(page, "mockUpdateError=install&mockUpdateDelay=0");
  await page.getByTestId("update-banner").click();
  const panel = page.getByTestId("update-panel");
  await panel.getByTestId("update-install").click();
  await expect(panel.getByTestId("update-error")).toHaveText("Update failed: mock: connection reset");
  await expect(panel.getByTestId("release-url")).toHaveText("https://github.com/kennnyz/sandchart/releases/latest");
  const retry = panel.getByTestId("update-install");
  await expect(retry).toHaveText("Retry");
  // The app keeps working: the chart is still there.
  await expect(page.getByTestId("legend")).toBeVisible();

  const before = await checks(page);
  await retry.click();
  await expect(panel.getByTestId("update-progress")).toHaveText(/^Downloading…/);
  // A second attempt starts clean: a fresh check first, as Rust kept nothing.
  expect(await checks(page)).toBe(before + 1);
  await expect(panel.getByTestId("update-error")).toBeVisible();
});

test("a translocated app explains the move and offers no install", async ({ page }) => {
  await openApp(page, "mockUpdateBlocker=translocated&mockUpdateDelay=0");
  await page.getByTestId("update-banner").click();
  const panel = page.getByTestId("update-panel");
  await expect(panel).toContainText("Move Sandchart to Applications, then update.");
  await expect(panel.getByTestId("release-url")).toHaveText("https://github.com/kennnyz/sandchart/releases/latest");
  await expect(panel.getByTestId("update-install")).toHaveCount(0);
});

test("Later hides the update until the next start", async ({ page }) => {
  await openApp(page, "mockUpdate=0.3.0&mockUpdateDelay=0");
  await page.getByTestId("update-banner").click();
  await page.getByTestId("update-panel").getByRole("button", { name: "Later" }).click();
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("update-banner")).toBeVisible();
});

test("auto check off persists and makes no check", async ({ page }) => {
  await openApp(page, "mockUpdate=0.3.0&mockUpdateDelay=0");
  await page.getByTestId("version-button").click();
  const auto = page.getByTestId("version-popover").getByTestId("update-auto");
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "false");

  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  // With auto on, the first check would have run at once (mockUpdateDelay=0).
  await page.waitForTimeout(500);
  expect(await checks(page)).toBe(0);
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
  await page.getByTestId("version-button").click();
  await expect(page.getByTestId("update-auto")).toHaveAttribute("aria-checked", "false");

  // The manual check still works.
  await page.getByTestId("update-check").click();
  await expect(page.getByTestId("update-status")).toHaveText("Update 0.3.0 available");
  expect(await checks(page)).toBe(1);
  await expect(page.getByTestId("update-banner")).toBeVisible();
});

test("a manual check with no update says so; Escape closes the popover", async ({ page }) => {
  await openApp(page, "");
  await page.getByTestId("version-button").click();
  const popover = page.getByTestId("version-popover");
  await expect(popover).toContainText("github.com and release-assets.githubusercontent.com");
  await popover.getByTestId("update-check").click();
  await expect(popover.getByTestId("update-status")).toHaveText("You have the latest version");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("a failed manual check shows the error and Retry", async ({ page }) => {
  await openApp(page, "mockUpdateError=check");
  await page.getByTestId("version-button").click();
  const popover = page.getByTestId("version-popover");
  await popover.getByTestId("update-check").click();
  await expect(popover.getByTestId("update-status")).toHaveText("Update failed: mock: could not reach the update server");
  await expect(popover.getByTestId("update-check")).toHaveText("Retry");
});

test("a failed automatic check shows nothing", async ({ page }) => {
  await openApp(page, "mockUpdateError=check&mockUpdateDelay=0");
  await expect.poll(() => checks(page)).toBe(1);
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
  await page.getByTestId("version-button").click();
  await expect(page.getByTestId("update-status")).toHaveText("");
});
