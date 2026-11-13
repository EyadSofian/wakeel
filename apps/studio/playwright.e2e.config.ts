import { defineConfig, devices } from "@playwright/test";

/**
 * `pnpm e2e` (CLAUDE.md §5): the Studio against the real api on the dev stack. Needs `pnpm dev:infra`,
 * `pnpm db:migrate` and a `.env`; starts the api and the Studio dev server itself if they are not
 * already running. Not part of `pnpm check`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  outputDir: "./test-results/e2e",
  forbidOnly: !!process.env["CI"],
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5173", viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: "node --import tsx --env-file=../../.env ../api/src/main.ts",
      url: "http://127.0.0.1:3000/health/live",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm exec vite",
      url: "http://127.0.0.1:5173/sign-in",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
