import { mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { selectedScreens } from "./screens";

/**
 * `pnpm studio:motion [--screen <id>]` (design system §8.1, step 6). For each scripted interaction,
 * at normal and reduced motion:
 *  - frames at 0, 25, 50, 75 and 100% of the interaction's real duration. Motion runs opacity and
 *    transform as Web Animations (springs become linear() curves), which a fake page clock does not
 *    drive, so the spec pauses those animations and seeks them: exact, repeatable frames;
 *  - the measured duration of each animated property, written next to the frames;
 *  - a real-time video of the same interaction.
 * Output: apps/studio/.motion/<screen>/<interaction>-<mode>-<pct>.png, -timing.json and .webm.
 */
const MOTION_DIR = fileURLToPath(new URL("../.motion", import.meta.url));
const MODES = [
  { id: "normal", reducedMotion: "no-preference" },
  { id: "reduced", reducedMotion: "reduce" },
] as const;
const PERCENTS = [0, 25, 50, 75, 100];

for (const screen of selectedScreens()) {
  for (const interaction of screen.interactions) {
    for (const mode of MODES) {
      const prefix = `${MOTION_DIR}/${screen.id}/${interaction.id}-${mode.id}`;

      test(`${screen.id} ${interaction.id} ${mode.id} frames`, async ({ page }) => {
        mkdirSync(`${MOTION_DIR}/${screen.id}`, { recursive: true });
        await page.emulateMedia({ reducedMotion: mode.reducedMotion });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(screen.route);
        await page.evaluate(() => document.fonts.ready);
        const target = page.locator(interaction.target);
        await target.scrollIntoViewIfNeeded();

        await page.locator(interaction.trigger).click();
        // Wait for the animations the click started, then freeze them all at their start.
        await page.waitForFunction(
          (sel) => (document.querySelector(sel)?.getAnimations({ subtree: true }).length ?? 0) > 0,
          interaction.target,
        );
        const timing = await page.evaluate((sel) => {
          const animations = document.querySelector(sel)?.getAnimations({ subtree: true }) ?? [];
          for (const a of animations) a.pause();
          return animations.map((a) => {
            const effect = a.effect as KeyframeEffect;
            const props = [
              ...new Set(
                effect
                  .getKeyframes()
                  .flatMap((k) => Object.keys(k))
                  .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
              ),
            ];
            return { props, durationMs: Math.round(Number(effect.getComputedTiming().endTime)) };
          });
        }, interaction.target);
        expect(timing.length).toBeGreaterThan(0);
        const total = Math.max(...timing.map((t) => t.durationMs));
        await import("node:fs").then((fs) =>
          fs.writeFileSync(
            `${prefix}-timing.json`,
            `${JSON.stringify({ totalMs: total, animations: timing }, null, 2)}\n`,
          ),
        );

        for (const pct of PERCENTS) {
          const at = (total * pct) / 100;
          await page.evaluate(
            ({ sel, at }) => {
              for (const a of document.querySelector(sel)?.getAnimations({ subtree: true }) ?? []) {
                const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
                a.currentTime = Math.min(at, end);
              }
            },
            { sel: interaction.target, at },
          );
          await target.screenshot({ path: `${prefix}-${String(pct).padStart(3, "0")}.png` });
        }
      });

      test(`${screen.id} ${interaction.id} ${mode.id} video`, async ({ browser }) => {
        mkdirSync(`${MOTION_DIR}/${screen.id}`, { recursive: true });
        const context = await browser.newContext({
          reducedMotion: mode.reducedMotion,
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
          recordVideo: { dir: `${MOTION_DIR}/${screen.id}/raw`, size: { width: 1440, height: 900 } },
        });
        const page = await context.newPage();
        await page.goto(screen.route);
        await page.evaluate(() => document.fonts.ready);
        await page.locator(interaction.target).scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await page.locator(interaction.trigger).click();
        await page.waitForTimeout(interaction.durationMs + 600);
        await page.locator(interaction.trigger).click();
        await page.waitForTimeout(interaction.durationMs + 600);
        const video = page.video();
        await context.close();
        if (video) renameSync(await video.path(), `${prefix}.webm`);
      });
    }
  }
}
