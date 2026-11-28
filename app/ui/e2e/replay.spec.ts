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
  plusButton: { x: number; y: number } | null;
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

  // The bar shows where the replay stands: the close of the current bar, in UTC.
  const time = page.getByTestId("replay-time");
  await expect(time).toHaveAttribute("data-time", String(start + H));
  const d = new Date(start + H);
  await expect(time).toContainText(`${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:00`);

  // Step with the button and with →.
  await page.getByTestId("replay-step").click();
  await expect.poll(() => lastBar(page)).toBe(start + H);
  await expect(time).toHaveAttribute("data-time", String(start + 2 * H));
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
  await expect(page.getByTestId("replay-trades-r")).toHaveAttribute("title", "R relative to the stop at entry");
  // The first trade unfolds the results, which takes room from the chart: read the handles after it.
  await expect(page.getByTestId("replay-stats")).toHaveAttribute("data-collapsed", "false");
  await nextFrame(page);
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
  // A broken file says so in plain words, the engine's in the tooltip, and closes with ×.
  const refused = page.getByTestId("replay-file-error");
  await expect(refused).toContainText("from a newer Sandchart");
  await expect(refused).toHaveAttribute("title", /replay file version 9 is not supported/);
  expect(await lastBar(page)).toBe(revealed);
  await refused.getByRole("button", { name: "Close" }).click();
  await expect(refused).toHaveCount(0);
  for (const [bytes, says] of [
    ["not json", "not a Sandchart replay file"],
    [text.replace(/"sha256": "[0-9a-f]+"/, `"sha256": "${"0".repeat(64)}"`), "damaged or was edited"],
  ] as const) {
    await page.getByTestId("replay-file").setInputFiles({ name: "bad.replay", mimeType: "application/json", buffer: Buffer.from(bytes) });
    await expect(refused).toContainText(says);
  }

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

  // The field takes a UTC date (and time) the same in every language; a bad one says how.
  await page.getByTestId("replay-button").click();
  await page.getByTestId("replay-date").fill("20.11.2026");
  await page.getByTestId("replay-date-go").click();
  await expect(page.getByTestId("replay-date-error")).toContainText("YYYY-MM-DD");
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "picking");
  await page.getByTestId("replay-date").fill("2001-01-01");
  await page.getByTestId("replay-date").press("Enter");
  await expect(page.getByTestId("replay-date-error")).toContainText("scroll the chart left");
  await page.keyboard.press("Escape");

  // A date starts at the first bar of that day (UTC).
  await page.getByTestId("replay-button").click();
  const dayStart = Math.floor((live - 10 * 24 * H) / (24 * H)) * 24 * H;
  await page.getByTestId("replay-date").fill(new Date(dayStart).toISOString().slice(0, 10));
  await page.getByTestId("replay-date").press("Enter");
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect.poll(() => lastBar(page)).toBe(dayStart);
  // Only that day's first bar and the context before it are on the chart.
  expect(await page.getByTestId("legend").getAttribute("data-time")).not.toBe(String(live));
  void plot;
});

test("replay_picking_pans_on_drag_zooms_on_wheel_and_picks_on_click", async ({ page }) => {
  const plot = await openChart(page);
  await page.getByTestId("replay-button").click();
  const x = plot.left + plot.width * 0.5;
  const y = plot.top + plot.height / 2;
  /** Open time of the bar under (px, y). */
  const barAt = async (px: number) => {
    await page.mouse.move(px, y);
    await nextFrame(page);
    return Number(await page.getByTestId("legend").getAttribute("data-time"));
  };
  const before = await barAt(x);

  // A drag pans the chart and starts nothing.
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await page.mouse.move(x + 150, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "picking");
  expect(await barAt(x)).toBeLessThan(before);

  // A drag that comes back to where it began is still a pan, not a pick.
  await page.mouse.down();
  await page.mouse.move(x + 40, y, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "picking");

  // The wheel zooms while picking (around the pointer, so look away from it).
  const left = plot.left + 40;
  const unzoomed = await barAt(left);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => barAt(left)).not.toBe(unzoomed);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "picking");

  // A click with a little jitter picks the bar under the release.
  await page.mouse.move(x, y);
  await page.mouse.down();
  const picked = await barAt(x + 2);
  await page.mouse.up();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect.poll(() => lastBar(page)).toBe(picked);
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
  await page.getByTestId("replay-date").press("Enter");
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
  await page.getByTestId("replay-date").press("Enter");
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

test("replay_on_a_higher_timeframe_hides_drawings_until_the_cut_passes_them", async ({ page }) => {
  await openChart(page);
  const live = await lastBar(page);
  // A note two hours into a 4h bar, well before the newest bars.
  const bucket = Math.floor((live - 40 * H) / (4 * H)) * 4 * H;
  const at = bucket + 2 * H;
  await page.evaluate((t) => {
    const d = {
      id: "inside",
      instrument: { source: "mock", symbol: "BTCUSDT" },
      priceScale: 2,
      body: { kind: "note", t, text: "inside" },
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

  // Stepping 1h up to the start of the note's 4h bar, then showing 4h.
  await page.getByTestId("replay-button").click();
  const dayStart = Math.floor((bucket - 24 * H) / (24 * H)) * 24 * H;
  await page.getByTestId("replay-date").fill(new Date(dayStart).toISOString().slice(0, 10));
  await page.getByTestId("replay-date").press("Enter");
  await expect.poll(() => lastBar(page)).toBe(dayStart);
  await stepUntil(page, async () => (await lastBar(page)) === bucket - H);
  await tfButton(page, "4h").click();
  await expect.poll(() => lastBar(page)).toBe(bucket - 4 * H);
  await expect(page.getByTestId("replay-interval")).toHaveText("1h");
  await expect.poll(async () => (await debug(page)).drawingsPainted).toBe(0);

  // The forming 4h bar opens before the note, but the cut has not reached it yet.
  for (const cut of [bucket + H, bucket + 2 * H]) {
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => cutOf(page)).toBe(cut);
    expect(await lastBar(page)).toBe(bucket);
    await nextFrame(page);
    expect((await debug(page)).drawingsPainted).toBe(0);
  }
  // One step past it, inside the same forming bar: the note shows.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => cutOf(page)).toBe(bucket + 3 * H);
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

const cutOf = async (page: Page) => Number(await page.getByTestId("replay-bar").getAttribute("data-cut"));
const tfButton = (page: Page, tf: string) => page.locator(".timeframes").getByRole("button", { name: tf, exact: true });

test("replay_keeps_its_session_across_timeframes", async ({ page }) => {
  const plot = await openChart(page);
  const start = await startAt(page, plot, plot.width * 0.4);
  // Up to the last hour of a 4h bucket: the next step opens a new 4h bar.
  await stepUntil(page, async () => ((await lastBar(page)) + H) % (4 * H) === 0, 8);
  await page.getByTestId("replay-buy").click();
  await expect(stat(page, "open-r")).not.toHaveText("—");
  const hour = await lastBar(page);
  expect(hour).toBeGreaterThanOrEqual(start);
  // The entry shows when it filled: the close of the hour bar, in one format on every timeframe.
  const entry = page.getByTestId("replay-trade-entry");
  await expect(entry).toHaveAttribute("data-time", String(hour + H));
  const entryText = (await entry.textContent())!;
  expect(entryText).toMatch(/^\d{1,2} \w{3} \d{4} \d{2}:\d{2}$/);

  // 4h: built from the revealed hours, no reset; the forming bar grows with each step.
  await tfButton(page, "4h").click();
  await expect.poll(() => lastBar(page)).toBe(hour - 3 * H);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect(page.getByTestId("replay-interval")).toHaveText("1h");
  await expect(stat(page, "open-r")).not.toHaveText("—");
  await expect(entry).toHaveText(entryText);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => cutOf(page)).toBe(hour + 2 * H);
  await expect.poll(() => lastBar(page)).toBe(hour + H);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => cutOf(page)).toBe(hour + 3 * H);
  expect(await lastBar(page)).toBe(hour + H);

  // 15m: the session re-bases to it; the trade stays (its outcome may differ on 15m candles).
  await tfButton(page, "15m").click();
  await expect(page.getByTestId("replay-interval")).toHaveText("15m");
  await expect.poll(() => lastBar(page)).toBe(hour + 3 * H - H / 4);
  expect(await cutOf(page)).toBe(hour + 3 * H);
  await expect(page.getByTestId("replay-trade")).toHaveCount(1);
  await expect(entry).toHaveText(entryText);
  await expect(entry).toHaveAttribute("data-time", String(hour + H));
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => cutOf(page)).toBe(hour + 3 * H + H / 4);

  // Back on 1h the update interval stays 15m; 1h is offered again once the cut is on the hour.
  await tfButton(page, "1h").click();
  await expect.poll(() => lastBar(page)).toBe(hour + 3 * H);
  await page.getByTestId("replay-interval").click();
  await expect(page.getByTestId("replay-interval-menu-1h")).toBeDisabled();
  await expect(page.getByTestId("replay-interval-menu-15m")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("replay-interval-menu")).toHaveCount(0);
  for (let i = 1; i <= 3; i++) {
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => cutOf(page)).toBe(hour + 3 * H + (i + 1) * (H / 4));
  }
  await page.getByTestId("replay-interval").click();
  await page.getByTestId("replay-interval-menu-1h").click();
  await expect(page.getByTestId("replay-interval")).toHaveText("1h");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => cutOf(page)).toBe(hour + 5 * H);
  await expect(page.getByTestId("replay-trade")).toHaveCount(1);

  // Another pair ends the replay, once its trades may go.
  await page.locator('[data-testid="watchlist-row"][data-symbol="ETHUSDT"]').click();
  await page.getByTestId("replay-confirm-ok").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");
});

test("replay_exit_and_pair_switch_ask_before_dropping_trades", async ({ page }) => {
  const plot = await openChart(page);
  await startAt(page, plot, plot.width * 0.5);
  await page.getByTestId("replay-buy").click();
  await expect(page.getByTestId("replay-trade")).toHaveCount(1);
  const ask = page.getByTestId("replay-confirm");

  // X asks; Cancel keeps the replay and its trade.
  await page.getByTestId("replay-exit").click();
  await expect(ask).toHaveAttribute("data-kind", "exit");
  await expect(ask).toContainText("Exit the replay?");
  await page.getByTestId("replay-confirm-cancel").click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect(page.getByTestId("replay-trade")).toHaveCount(1);

  // Another pair waits for the answer; Cancel keeps the old pair and the replay.
  const eth = page.locator('[data-testid="watchlist-row"][data-symbol="ETHUSDT"]');
  await eth.click();
  await expect(ask).toHaveAttribute("data-kind", "switch");
  await expect(page.getByTestId("symbol-button")).toContainText("BTCUSDT");
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId("symbol-button")).toContainText("BTCUSDT");
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");

  // Save first: the file is written, then the pair opens and the replay ends.
  await eth.click();
  await page.getByTestId("replay-confirm-save").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");
  await expect(page.getByTestId("symbol-button")).toContainText("ETHUSDT");
  const saved = await page.evaluate(() => (window as unknown as { __sandchartMock: { replayFile(): string | null } }).__sandchartMock.replayFile());
  expect(saved).toContain('"kind":"open"');

  // Discard on X ends it without a file.
  const now = await plotOf(page);
  await startAt(page, now, now.width * 0.5);
  await page.getByTestId("replay-sell").click();
  await expect(page.getByTestId("replay-trade")).toHaveCount(1);
  await page.getByTestId("replay-exit").click();
  await page.getByTestId("replay-confirm-ok").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");
});

test("replay_jumps_to_real_time_and_ends_the_backtest_there", async ({ page }) => {
  const plot = await openChart(page);
  const live = await lastBar(page);
  // A few bars before the newest one.
  await startAt(page, plot, plot.width - 100);
  // Disabled controls say why; the status has its own room, so the bar does not move.
  await expect(page.getByTestId("replay-close")).toHaveAttribute("title", "No open trade to close");
  await expect(page.getByTestId("replay-save")).toHaveAttribute("title", "Save the replay as a .replay file");
  const controls = page.locator(".replay-controls");
  const boxBefore = (await controls.boundingBox())!;
  await page.getByTestId("replay-buy").click();
  await expect(stat(page, "open-r")).not.toHaveText("—");
  await expect(page.getByTestId("replay-buy")).toHaveAttribute("title", "One trade at a time: close the open trade first");
  await expect(page.getByTestId("replay-sell")).toHaveAttribute("title", "One trade at a time: close the open trade first");
  await page.getByTestId("replay-jump").click();
  const bar = page.getByTestId("replay-bar");
  await expect(bar).toHaveAttribute("data-finished", "true");
  await expect(page.getByTestId("replay-real-time")).toBeVisible();
  const boxAfter = (await controls.boundingBox())!;
  expect([boxAfter.x, boxAfter.width]).toEqual([boxBefore.x, boxBefore.width]);
  await expect.poll(() => lastBar(page)).toBe(live);
  // The backtest is over: the pair's live quote gives nothing away any more.
  await expect(page.locator('[data-testid="watchlist-row"][data-symbol="BTCUSDT"]')).toContainText("%");
  for (const id of ["replay-step", "replay-play", "replay-jump", "replay-buy", "replay-sell", "replay-close"]) {
    await expect(page.getByTestId(id)).toBeDisabled();
  }
  await expect(page.getByTestId("replay-step")).toHaveAttribute("title", /backtest is finished/);
  await expect(page.getByTestId("replay-select")).toBeEnabled();
  await expect(page.getByTestId("replay-exit")).toBeEnabled();
  // The trade is closed or left unfinished at real time; an unfinished one does not count.
  const row = page.getByTestId("replay-trade");
  await expect(row).toHaveCount(1);
  await expect(stat(page, "open-r")).toHaveText("—");
  const reason = await row.getAttribute("data-reason");
  expect(["take", "stop", "unfinished"]).toContain(reason);
  await expect(stat(page, "trades")).toHaveText(reason === "unfinished" ? "0" : "1");
  const stats = await stat(page, "total-r").textContent();

  // A live candle shows on the chart, but the backtest stays at its cut.
  const cut = await cutOf(page);
  await page.keyboard.press("ArrowRight");
  await page.evaluate(
    (t) =>
      (window as unknown as { __sandchartMock: { emitLive(e: unknown): void } }).__sandchartMock.emitLive({
        kind: "candle",
        time: t,
        open: 1_000_000,
        high: 1_010_000,
        low: 990_000,
        close: 1_005_000,
        volume: 10,
        closed: true,
      }),
    live + H,
  );
  await expect.poll(() => lastBar(page)).toBe(live + H);
  expect(await cutOf(page)).toBe(cut);
  await expect(stat(page, "total-r")).toHaveText(stats!);
  await expect(page.getByTestId("replay-trade")).toHaveAttribute("data-reason", reason!);

  await page.getByTestId("replay-exit").click();
  await page.getByTestId("replay-confirm-ok").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "off");
});

test("replay_select_bar_asks_before_dropping_trades", async ({ page }) => {
  const plot = await openChart(page);
  const live = await lastBar(page);
  await startAt(page, plot, plot.width * 0.5);
  await page.getByTestId("replay-buy").click();
  await expect(stat(page, "open-r")).not.toHaveText("—");
  await page.getByTestId("replay-select").click();
  await page.getByTestId("replay-select-menu-chart").click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("will be lost");
  await page.getByTestId("replay-confirm-cancel").click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect(stat(page, "open-r")).not.toHaveText("—");

  // Esc says no too; then yes: back to the live chart to pick a new start.
  await page.getByTestId("replay-select").click();
  await page.getByTestId("replay-select-menu-date").click();
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await page.getByTestId("replay-select").click();
  await page.getByTestId("replay-select-menu-chart").click();
  await page.getByTestId("replay-confirm-ok").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "picking");
  await expect(page.getByTestId("replay-hint")).toBeVisible();
  // The live chart is back, with every bar to pick from.
  await expect.poll(() => lastBar(page)).toBe(live);
  const now = await plotOf(page);
  await page.mouse.move(now.left + now.width * 0.3, now.top + now.height / 2);
  await nextFrame(page);
  await page.mouse.click(now.left + now.width * 0.3, now.top + now.height / 2);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "on");
  await expect(stat(page, "trades")).toHaveText("0");
  await expect(stat(page, "open-r")).toHaveText("—");

  // Without trades it starts picking at once.
  await page.getByTestId("replay-select").click();
  await page.getByTestId("replay-select-menu-date").click();
  await expect(page.getByTestId("chart")).toHaveAttribute("data-replay", "picking");
  await expect(page.getByTestId("replay-date")).toBeFocused();
});

test("replay_results_sit_under_the_bar_collapse_and_scroll", async ({ page }) => {
  const plot = await openChart(page);
  await startAt(page, plot, plot.width * 0.3);
  const panel = page.getByTestId("replay-stats");
  const barBox = (await page.getByTestId("replay-bar").boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
  expect(panelBox.width).toBeGreaterThan(barBox.width - 2);
  // Folded until the first trade.
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("replay-results-toggle")).toBeDisabled();
  // Eight trades, closed by hand: more than the list shows at once.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+B");
    await expect(page.getByTestId("replay-close")).toBeEnabled();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+C");
    await expect(page.getByTestId("replay-trade")).toHaveCount(i + 1);
    await expect(page.getByTestId("replay-buy")).toBeEnabled();
  }
  await expect(panel).toHaveAttribute("data-collapsed", "false");
  const list = page.getByTestId("replay-trades");
  // Entry, stop and exit prices; the columns keep their widths as rows come and go.
  const row = page.getByTestId("replay-trade").first();
  for (const id of ["entry-price", "stop", "exit-price"]) await expect(row.getByTestId(`replay-trade-${id}`)).toHaveText(/^\d[\d\u2009]*\.\d{2}$/);
  const widths = () => list.locator("th").evaluateAll((ths) => ths.map((th) => Math.round(th.getBoundingClientRect().width)));
  const before = await widths();
  await page.keyboard.press("Shift+B");
  await expect(page.getByTestId("replay-trade")).toHaveCount(9);
  expect(await widths()).toEqual(before);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+C");
  await expect(page.getByTestId("replay-buy")).toBeEnabled();
  expect(await widths()).toEqual(before);
  const sizes = await list.evaluate((el) => [el.scrollHeight, el.clientHeight]);
  expect(sizes[0]).toBeGreaterThan(sizes[1]!);
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // R is coloured by its sign only.
  for (const cell of await page.locator('[data-testid="replay-trade"] td.num').all()) {
    const text = (await cell.textContent())!;
    const cls = (await cell.getAttribute("class"))!;
    expect(cls.includes("up")).toBe(text.startsWith("+"));
    expect(cls.includes("down")).toBe(text.startsWith("−"));
  }

  await page.getByTestId("replay-results-toggle").click();
  await expect(list).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await expect(stat(page, "trades")).toHaveText("9");
  expect(await page.evaluate(() => localStorage.getItem("sandchart.replay.resultsCollapsed"))).toBe("1");
  // Remembered across a reload, also once there is a trade.
  await page.reload();
  await expect(page.getByTestId("legend")).toHaveAttribute("data-time", /^\d+$/);
  await startAt(page, await plotOf(page), plot.width * 0.3);
  await page.keyboard.press("Shift+B");
  await expect(stat(page, "open-r")).not.toHaveText("—");
  await expect(panel).toHaveAttribute("data-collapsed", "true");
  await page.getByTestId("replay-results-toggle").click();
  await expect(page.getByTestId("replay-trades")).toBeVisible();
});

test("replay_plus_menu_buys_sells_and_draws_but_sets_no_alert", async ({ page }) => {
  const plot = await openChart(page);
  await startAt(page, plot, plot.width - 100);
  const plusAt = async (y: number) => {
    await page.mouse.move(plot.left + plot.width / 2, y);
    await nextFrame(page);
    const b = (await debug(page)).plusButton!;
    await page.mouse.move(plot.left + b.x, plot.top + b.y);
    await nextFrame(page);
    await page.mouse.click(plot.left + b.x, plot.top + b.y);
    await expect(page.getByTestId("price-menu")).toBeVisible();
  };
  const y = Math.round(plot.top + plot.height * 0.45);
  await plusAt(y);
  await expect(page.getByTestId("price-menu-alert")).toHaveCount(0);
  const buy = page.getByTestId("price-menu-buy");
  const sell = page.getByTestId("price-menu-sell");
  await expect(buy).toContainText(/Buy\s*⇧B/);
  await expect(sell).toContainText(/Sell\s*⇧S/);
  await expect(page.getByTestId("price-menu-hline")).toContainText("Draw horizontal line at");
  await buy.click();
  await expect(page.getByTestId("price-menu")).toHaveCount(0);
  await expect(stat(page, "open-r")).not.toHaveText("—");

  // One trade at a time: Buy and Sell are off while it is open, as in the replay bar.
  await plusAt(y);
  await expect(buy).toBeDisabled();
  await expect(sell).toBeDisabled();
  await page.getByTestId("price-menu-hline").click();
  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("sandchart.mock.drawings") ?? "[]").length))
    .toBe(1);

  // Caught up with real time: off with the reason.
  await page.getByTestId("replay-close").click();
  await page.getByTestId("replay-jump").click();
  await expect(page.getByTestId("replay-bar")).toHaveAttribute("data-finished", "true");
  await plusAt(Math.round(plot.top + plot.height * 0.3));
  await expect(buy).toBeDisabled();
  await expect(sell).toBeDisabled();
  await expect(buy).toHaveAttribute("title", /backtest is finished/);
  await expect(page.getByTestId("price-menu-alert")).toHaveCount(0);
  // Focus skips the items that are off.
  await expect(page.getByTestId("price-menu-hline")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("price-menu")).toHaveCount(0);
});
