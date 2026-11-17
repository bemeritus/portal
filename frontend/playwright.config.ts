/**
 * End-to-end checks in a real browser (`just e2e`). They drive the running
 * dev servers (`just dev`) against the seeded server room (`just seed-dc`);
 * E2E_USER / E2E_PASSWORD name an account with `dc_room` access.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
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
