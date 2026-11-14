import { defineConfig, devices } from "@playwright/test";

/**
 * Screenshot and motion review (design system §8). Not part of `pnpm check`: run through
 * `pnpm studio:shots` and `pnpm studio:motion`, which build the Studio and serve it with vite preview.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__baselines__/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: [["list"]],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: "disabled" } },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    deviceScaleFactor: 2,
  },
  projects: [
    { name: "shots", testMatch: /(shots|content)\.spec\.ts/, use: { contextOptions: { reducedMotion: "reduce" } } },
    { name: "motion", testMatch: /motion(-canvas|-emulator)?\.spec\.ts/ },
    // Canvas performance budget (design system §5.1), `pnpm studio:perf`. Device scale 1: a
    // mid-range laptop, not a retina review shot.
    { name: "perf", testMatch: /perf\.spec\.ts/, use: { deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: "pnpm exec vite build && pnpm exec vite preview",
    url: "http://127.0.0.1:4173/__gallery",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
