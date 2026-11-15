import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockEvalReview } from "./eval-review-fixtures";
import { mockApi, WS } from "./mock-api";

const enabled = !process.env["REVIEW_SCREEN"] || process.env["REVIEW_SCREEN"] === "evals";
const directory = fileURLToPath(new URL("../.motion/evals", import.meta.url));
if (enabled)
  for (const reduced of [false, true]) {
    test(`eval case editor ${reduced ? "reduced" : "normal"} motion`, async ({ browser }) => {
      mkdirSync(directory, { recursive: true });
      const prefix = `${directory}/case-editor-${reduced ? "reduced" : "normal"}`;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: reduced ? "reduce" : "no-preference",
        recordVideo: { dir: `${directory}/raw`, size: { width: 1440, height: 900 } },
      });
      const page = await context.newPage();
      await mockApi(page, "rtl");
      await mockEvalReview(page, "rtl");
      await page.goto(`/w/${WS}/b/${BOT}/evals`);
      await page.getByRole("button", { name: "Add case", exact: true }).click();
      await page.waitForFunction(() => (document.querySelector('[role="dialog"]')?.getAnimations().length ?? 0) > 0);
      const timing = await page.evaluate(() =>
        (document.querySelector('[role="dialog"]')?.getAnimations() ?? []).map((a) => {
          a.pause();
          a.currentTime = 0;
          const effect = a.effect as KeyframeEffect;
          return { durationMs: Number(effect.getComputedTiming().endTime), frames: effect.getKeyframes() };
        }),
      );
      expect(timing.length).toBeGreaterThan(0);
      const total = Math.max(...timing.map((a) => a.durationMs));
      if (reduced) expect(total).toBeLessThanOrEqual(81);
      writeFileSync(`${prefix}-timing.json`, JSON.stringify(timing, null, 2));
      for (const percent of [0, 25, 50, 75, 100]) {
        await page.evaluate(
          (at) => {
            for (const a of document.querySelector('[role="dialog"]')?.getAnimations() ?? [])
              a.currentTime = Math.min(at, Number(a.effect?.getComputedTiming().endTime ?? 0));
          },
          (total * percent) / 100,
        );
        await page.screenshot({ path: `${prefix}-${percent}.png` });
      }
      await page.evaluate(() => {
        for (const a of document.querySelector('[role="dialog"]')?.getAnimations() ?? []) a.finish();
      });
      await expect(page.getByRole("dialog", { name: "Add case" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page.getByRole("button", { name: "Add case", exact: true })).toBeFocused();
      const video = page.video();
      await context.close();
      if (video) renameSync(await video.path(), `${prefix}.webm`);
    });
  }
