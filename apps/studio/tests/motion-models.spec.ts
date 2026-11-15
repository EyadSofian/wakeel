import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { duration } from "@wakeel/ui/motion";
import { mockApi, WS } from "./mock-api";

const DIR = fileURLToPath(new URL("../.motion/settings-models", import.meta.url));
const selected = !process.env["REVIEW_SCREEN"] || process.env["REVIEW_SCREEN"] === "settings-models";

if (selected) {
  test.use({ video: "on" });
  for (const reduced of [false, true]) {
    const mode = reduced ? "reduced" : "normal";
    test(`rerank credential dialog ${mode} frames`, async ({ page }) => {
      mkdirSync(DIR, { recursive: true });
      await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      await mockApi(page, "default");
      await page.goto(`/w/${WS}/settings/models`);
      const trigger = page.getByRole("button", { name: "Add the Rerank server key" });
      await expect(trigger).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.01 });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Rerank server key" });
      await expect(dialog).toBeAttached();
      await page.waitForFunction(() => (document.querySelector('[role="dialog"]')?.getAnimations().length ?? 0) > 0);
      const timing = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
          .map((a) => {
            a.pause();
            const effect = a.effect as KeyframeEffect;
            return { durationMs: Number(effect.getComputedTiming().endTime), frames: effect.getKeyframes() };
          }),
      );
      const total = Math.max(...timing.map((t) => t.durationMs));
      expect(
        timing.some((t) => Math.abs(t.durationMs - (reduced ? duration.instant : duration.slower) * 1000) < 1),
      ).toBe(true);
      writeFileSync(`${DIR}/rerank-key-${mode}-timing.json`, `${JSON.stringify(timing, null, 2)}\n`);
      for (const percent of [0, 25, 50, 75, 100]) {
        await page.evaluate(
          (at) => {
            for (const a of document.getAnimations()) {
              const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
              if (Number.isFinite(end)) a.currentTime = Math.min(at, end);
            }
          },
          (total * percent) / 100,
        );
        await page.screenshot({ path: `${DIR}/rerank-key-${mode}-${percent}.png` });
      }
    });
    test(`rerank credential dialog ${mode} keyboard flow`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
      await mockApi(page, "default");
      await page.goto(`/w/${WS}/settings/models`);
      await page.getByRole("button", { name: "Add the Rerank server key" }).click();
      const dialog = page.getByRole("dialog", { name: "Rerank server key" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("API key").fill("synthetic-key-1234");
      await page.keyboard.press("Tab");
      await expect(dialog.getByLabel("Server address")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    });
  }
}
