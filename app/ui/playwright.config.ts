import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

// The e2e suite runs against the production build served by `vite preview`; outside
// Tauri the app talks to the mock backend (src/backend/index.ts).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  projects: [
    { name: "chart", grepInvert: /@perf/ },
    // Draw time depends on the runner: two retries absorb a noisy run, then it gates (ruling R6).
    { name: "perf", grep: /@perf/, retries: 2 },
  ],
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
