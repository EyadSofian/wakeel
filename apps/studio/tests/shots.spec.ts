import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { type ScreenState, selectedScreens, THEMES } from "./screens";

/**
 * `pnpm studio:shots [--screen <id>] [--update]` (design system §8.1). Writes
 * apps/studio/.shots/<screen>/<state>-<theme>-<width>.png for review, and compares each against its
 * committed baseline (0.1% threshold). Reduced motion is on so frames are stable.
 */
const SHOTS_DIR = fileURLToPath(new URL("../.shots", import.meta.url));

async function prepare(page: Page, state: ScreenState): Promise<void> {
  if (state === "focus") {
    // Keyboard focus on the first control, to review the focus ring (checklist 18).
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toHaveCount(1);
  }
}

for (const screen of selectedScreens()) {
  for (const theme of THEMES) {
    for (const [width, height] of screen.sizes) {
      for (const state of screen.states) {
        const name = `${state}-${theme}-${width}`;
        test(`${screen.id} ${name}`, async ({ page }) => {
          await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
          await page.setViewportSize({ width, height });
          await page.goto(screen.route);
          await page.evaluate(() => document.fonts.ready);
          // The shell scrolls inside <main>, so fullPage alone would stop at the viewport. Grow the
          // viewport by the hidden content height so the shot shows the whole screen.
          const hidden = await page.evaluate(() => {
            const main = document.querySelector("main");
            return main ? main.scrollHeight - main.clientHeight : 0;
          });
          if (hidden > 0) await page.setViewportSize({ width, height: height + hidden });
          await prepare(page, state);

          mkdirSync(`${SHOTS_DIR}/${screen.id}`, { recursive: true });
          await page.screenshot({ path: `${SHOTS_DIR}/${screen.id}/${name}.png`, fullPage: true });
          await expect(page).toHaveScreenshot(`${screen.id}/${name}.png`, { fullPage: true });
        });
      }
    }
  }
}
