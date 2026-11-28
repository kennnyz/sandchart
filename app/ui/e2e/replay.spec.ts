import { expect, test, type Page } from "@playwright/test";

const PRICE_AXIS = 72;
const TIME_AXIS = 26;
const H = 3_600_000;

interface Plot {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Debug {
  baseDraws: number;
  overlayDraws: number;
  lastBarTime: number | null;
  indicatorLastTimes: number[];
  replayHandles: { stop: { x: number; y: number }; take: { x: number; y: number } } | null;
  replayClosed: number;
  outcomes: Record<string, string>;
  drawingsPainted: number;
}

/** Little mock latency, so stepping through a few hundred bars stays quick. */
async function openChart(page: Page, query = "?mockLatency=5"): Promise<Plot> {
  await page.goto(`/${query}`);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  return plotOf(page);
}

/** The price plot now: the replay bar and its results take room under the chart. */
async function plotOf(page: Page): Promise<Plot> {
  const box = await page.getByTestId("chart").boundingBox();
  if (!box) throw new Error("chart has no box");
  return {
    left: Math.round(box.x),
    top: Math.round(box.y),
    width: Math.round(box.width - PRICE_AXIS) - 1,
    height: Math.round(box.height - TIME_AXIS),
  };
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function debug(page: Page): Promise<Debug> {
  return page.evaluate(() => ({ ...(window as unknown as { __sandchartDebug: Debug }).__sandchartDebug }));
}

const lastBar = async (page: Page) => (await debug(page)).lastBarTime!;
const stat = (page: Page, id: string) => page.getByTestId(`replay-stat-${id}`);

/** Starts a replay with a click on the bar under `x` (in the plot); resolves to its open time. */
async function startAt(page: Page, plot: Plot, x: number): Promise<number> {
  await page.getByTestId("replay-button").click();
  await expect(page.getByTestId("replay-hint")).toBeVisible();
  await page.mouse.move(plot.left + x, plot.top + plot.height / 2);
  await nextFrame(page);
  const picked = Number(await page.getByTestId("legend").getAttribute("data-time"));
  await page.mouse.click(plot.left + x, plot.top + plot.height / 2);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect.poll(() => lastBar(page)).toBe(picked);
  // Off the plot, so the legend shows the last revealed bar.
  await page.mouse.move(plot.left + plot.width + 30, plot.top + plot.height + 40);
  return picked;
}

/** → until `done` holds, at most `max` times. */
async function stepUntil(page: Page, done: () => Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    const before = await lastBar(page);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => lastBar(page)).toBe(before + H);
  }
  throw new Error("the condition never held");
}

test("replay_start_step_play_trade_save_open_exit", async ({ page }) => {
  const plot = await openChart(page);
  const live = await lastBar(page);
  const start = await startAt(page, plot, plot.width * 0.35);
  expect(start).toBeLessThan(live);
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", String(start));

  // Step with the button and with →.
  await page.getByTestId("replay-step").click();
  await expect.poll(() => lastBar(page)).toBe(start + H);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => lastBar(page)).toBe(start + 2 * H);

  // Play at 10 bars a second, pause with Space.
  await page.getByTestId("replay-speed").click();
  await page.getByTestId("replay-speed-menu-10").click();
  await expect(page.getByTestId("replay-speed")).toHaveText("10x");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("replay-play")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => lastBar(page)).toBeGreaterThanOrEqual(start + 6 * H);
  await page.keyboard.press("Space");
  await expect(page.getByTestId("replay-play")).toHaveAttribute("aria-pressed", "false");
  const paused = await lastBar(page);
  await page.waitForTimeout(400);
  expect(await lastBar(page)).toBe(paused);

  // Buy: the default stop 1.5 % under the close and the take at 2R, both shown with handles.
  await page.getByTestId("replay-buy").click();
  await expect(stat(page, "open-r")).not.toHaveText("—");
  await expect(page.getByTestId("replay-buy")).toBeDisabled();
  await expect(page.getByTestId("replay-sell")).toBeDisabled();
  await expect.poll(async () => (await debug(page)).replayHandles !== null).toBe(true);
  const handles = (await debug(page)).replayHandles!;
  expect(handles.stop.y).toBeGreaterThan(handles.take.y);
  // The take is twice as far from the entry as the stop: 2R.

  // Drag the stop far down: it is sent as an edit when the button comes up.
  const now = await plotOf(page);
  const sx = now.left + handles.stop.x;
  const sy = now.top + handles.stop.y;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx, now.top + now.height - 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await debug(page)).replayHandles!.stop.y).toBeGreaterThan(handles.stop.y + 40);
  expect((await debug(page)).replayHandles!.take.y).toBeCloseTo(handles.take.y, 0);

  // Step until the take is reached: +2R, measured against the stop at entry.
  await stepUntil(page, async () => (await stat(page, "trades").textContent()) === "1");
  await expect(stat(page, "total-r")).toHaveText("+2.0R");
  await expect(stat(page, "total-r")).toHaveClass(/up/);
  await expect(stat(page, "win-rate")).toHaveText("100%");
  await expect(stat(page, "profit-factor")).toHaveText("—");
  await expect(stat(page, "open-r")).toHaveText("—");
  await expect.poll(async () => (await debug(page)).replayClosed).toBe(1);

  // Sell short and close it by hand two bars later.
  await page.keyboard.press("Shift+S");
  await expect(page.getByTestId("replay-close")).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("replay-close").click();
  await expect(stat(page, "trades")).toHaveText("2");
  await expect(page.getByTestId("replay-buy")).toBeEnabled();

  // Save, then open the saved text: the same trades and statistics.
  const ids = ["trades", "win-rate", "total-r", "average-r", "profit-factor", "max-drawdown", "losing-streak"];
  const before = await Promise.all(ids.map((id) => stat(page, id).textContent()));
  const revealed = await lastBar(page);
  await page.getByTestId("replay-save").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __sandchartMock: { replayFile(): string | null } }).__sandchartMock.replayFile()))
    .not.toBeNull();
  const text = await page.evaluate(
    () => (window as unknown as { __sandchartMock: { replayFile(): string } }).__sandchartMock.replayFile(),
  );

  // Exit: the live chart again, up to its newest bar.
  await page.getByTestId("replay-exit").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");
  await expect(page.getByTestId("replay-bar")).toHaveCount(0);
  await expect(page.getByTestId("replay-stats")).toHaveCount(0);
  await expect.poll(() => lastBar(page)).toBe(live);

  await page.getByTestId("replay-button").click();
  await page.getByTestId("replay-file").setInputFiles({ name: "BTCUSDT-1h.replay", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect.poll(() => lastBar(page)).toBe(revealed);
  const after = await Promise.all(ids.map((id) => stat(page, id).textContent()));
  expect(after).toEqual(before);
  // A file holds no bar after its current one.
  await expect(page.getByTestId("replay-step")).toBeDisabled();

  // A broken file shows the engine's message and leaves the replay as it was.
  await page.getByTestId("replay-file").setInputFiles({
    name: "bad.replay",
    mimeType: "application/json",
    buffer: Buffer.from(text.replace('"version": 2', '"version": 9')),
  });
  await expect(page.getByTestId("replay-error")).toContainText("replay file version 9 is not supported");
  expect(await lastBar(page)).toBe(revealed);

  await page.getByTestId("replay-exit").click();
  await expect.poll(() => lastBar(page)).toBe(live);
  await expect(page.getByTestId("replay-error")).toHaveCount(0);
});

test("replay_picking_cancels_with_esc_and_starts_by_date", async ({ page }) => {
  const plot = await openChart(page);
  const live = await lastBar(page);
  await page.getByTestId("replay-button").click();
  await expect(page.getByTestId("replay-hint")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("replay-bar")).toHaveCount(0);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");

  // A date starts at the first bar of that day (UTC).
  await page.getByTestId("replay-button").click();
  const dayStart = Math.floor((live - 10 * 24 * H) / (24 * H)) * 24 * H;
  await page.getByTestId("replay-date").fill(new Date(dayStart).toISOString().slice(0, 10));
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect.poll(() => lastBar(page)).toBe(dayStart);
  // Only that day's first bar and the context before it are on the chart.
  expect(await page.getByTestId("legend").getAttribute("data-time")).not.toBe(String(live));
  void plot;
});

test("replay_indicators_and_drawings_see_only_revealed_bars", async ({ page }) => {
  const plot = await openChart(page, "?mockLatency=5&mockIndicators=sma");
  await expect.poll(async () => (await debug(page)).indicatorLastTimes[0]).toBe(await lastBar(page));
  const start = await startAt(page, plot, plot.width * 0.5);
  await expect.poll(async () => (await debug(page)).indicatorLastTimes).toEqual([start]);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(() => lastBar(page)).toBe(start + 3 * H);
  await expect.poll(async () => (await debug(page)).indicatorLastTimes).toEqual([start + 3 * H]);
  await page.getByTestId("replay-exit").click();
  await expect.poll(async () => (await debug(page)).indicatorLastTimes[0]).toBeGreaterThan(start + 3 * H);

  // A position entered at a bar with its stop and take one tick away: the next bar decides it
  // (every bar is above, below or across the entry). In a replay started at that bar nothing
  // after it is revealed, so it must stay open.
  const live = await lastBar(page);
  const at = live - 50 * H;
  await page.evaluate((t) => {
    const position = { kind: "position", side: "long", entry: { t, p: 10_000 }, stop: 9_999, take: 10_001, endT: t + 40 * 3_600_000 };
    const d = {
      id: "tight",
      instrument: { source: "mock", symbol: "BTCUSDT" },
      priceScale: 2,
      body: position,
      style: { color: 0, width: 1, dash: false },
      locked: false,
      hidden: false,
      z: 0,
      updatedAt: 1,
    };
    localStorage.setItem("sandchart.mock.drawings", JSON.stringify([d]));
  }, at);
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).outcomes.tight).toMatch(/^(take|stop\??)$/);
  const decided = (await debug(page)).outcomes.tight;
  await page.getByTestId("replay-button").click();
  await page.getByTestId("replay-date").fill(new Date(at).toISOString().slice(0, 10));
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  const first = Math.floor(at / (24 * H)) * 24 * H;
  await expect.poll(() => lastBar(page)).toBe(first);
  // Step to the position's entry bar.
  for (let t = first; t < at; t += H) await page.keyboard.press("ArrowRight");
  await expect.poll(() => lastBar(page)).toBe(at);
  await expect.poll(async () => (await debug(page)).outcomes.tight).toBe("open");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await debug(page)).outcomes.tight).toBe(decided);
  await page.getByTestId("replay-exit").click();
  await expect.poll(() => lastBar(page)).toBe(live);
  await expect.poll(async () => (await debug(page)).outcomes.tight).toBe(decided);
});

test("replay_mouse_move_redraws_only_the_overlay", async ({ page }) => {
  const plot = await openChart(page);
  await startAt(page, plot, plot.width * 0.5);
  await page.getByTestId("replay-buy").click();
  await expect.poll(async () => (await debug(page)).replayHandles !== null).toBe(true);
  const y = plot.top + plot.height / 3;
  await page.mouse.move(plot.left + 100, y);
  await nextFrame(page);
  const before = await debug(page);
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(plot.left + 100 + i * 12, y + (i % 5) * 20);
    await nextFrame(page);
  }
  // Over the handles too: only the cursor changes.
  const h = before.replayHandles!;
  await page.mouse.move(plot.left + h.stop.x, plot.top + h.stop.y);
  await nextFrame(page);
  const after = await debug(page);
  expect(after.baseDraws).toBe(before.baseDraws);
  expect(after.overlayDraws).toBeGreaterThanOrEqual(before.overlayDraws + 20);
});

test("replay_hides_drawings_anchored_after_the_revealed_bars", async ({ page }) => {
  await openChart(page);
  const live = await lastBar(page);
  const at = live - 30 * H;
  await page.evaluate((t) => {
    const d = {
      id: "later",
      instrument: { source: "mock", symbol: "BTCUSDT" },
      priceScale: 2,
      body: { kind: "note", t, text: "later" },
      style: { color: 0, width: 1, dash: false },
      locked: false,
      hidden: false,
      z: 0,
      updatedAt: 1,
    };
    localStorage.setItem("sandchart.mock.drawings", JSON.stringify([d]));
  }, at);
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);

  // A day or two before the note: step up to the bar just before it, which leaves the note's
  // bar inside the room right of the cut, where it would be painted.
  await page.getByTestId("replay-button").click();
  const dayStart = Math.floor((at - 24 * H) / (24 * H)) * 24 * H;
  await page.getByTestId("replay-date").fill(new Date(dayStart).toISOString().slice(0, 10));
  await expect.poll(() => lastBar(page)).toBe(dayStart);
  await stepUntil(page, async () => (await lastBar(page)) === at - H);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => lastBar(page)).toBe(at);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);
  await page.getByTestId("replay-exit").click();
  await expect.poll(() => lastBar(page)).toBe(live);
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(1);
});

test("replay_hides_the_replayed_pair_quote_in_the_watchlist", async ({ page }) => {
  const plot = await openChart(page);
  const row = (s: string) => page.locator(`[data-testid="watchlist-row"][data-symbol="${s}"]`);
  await expect(row("BTCUSDT")).toContainText("+1.84%");
  const ethBefore = await row("ETHUSDT").textContent();
  await startAt(page, plot, plot.width * 0.5);
  // The live price and 24h change would tell where the replay goes: a dash and a marker instead.
  await expect(row("BTCUSDT").locator(".wl-last")).toHaveText("—");
  await expect(row("BTCUSDT").locator(".wl-chg")).toHaveText("Replay");
  await expect(row("BTCUSDT")).not.toContainText("%");
  // Other pairs keep their quotes.
  await expect(row("ETHUSDT")).toHaveText(ethBefore!);
  await page.getByTestId("replay-exit").click();
  await expect(row("BTCUSDT")).toContainText("+1.84%");
});
