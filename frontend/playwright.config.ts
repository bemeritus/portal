/**
 * End-to-end checks in a real browser (`just e2e`). They run on a stack of
 * their own — a scratch database, seeded, with its own API and Vite
 * (scripts/e2e-stack.sh), which sets E2E_BASE_URL, E2E_USER, E2E_PASSWORD.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  // One account for every file, and the files change its language and
  // theme: one at a time.
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      name: "chromium",
      // Full Chromium in the new headless mode (WebGL works; some setups ship
      // no separate headless shell).
      use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 1600, height: 1000 } },
    },
  ],
});
