import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { type MockState, mockApi } from "./mock-api";
import { type Screen, type ScreenState, selectedScreens, THEMES } from "./screens";

/**
 * `pnpm studio:shots [--screen <id>] [--update]` (design system §8.1). Writes
 * apps/studio/.shots/<screen>/<state>-<theme>-<width>.png for review, and compares each against its
 * committed baseline (0.1% threshold). Reduced motion is on so frames are stable.
 */
const SHOTS_DIR = fileURLToPath(new URL("../.shots", import.meta.url));

const mockStateFor = (screen: Screen, state: ScreenState): MockState => {
  if (screen.id === "sign-in") return "signed-out";
  return state === "focus" ? "default" : state;
};

async function prepare(page: Page, screen: Screen, state: ScreenState): Promise<void> {
  if (screen.id === "sign-in" && state === "error") {
    // A rejected sign-in: the banner shows what happened and how to fix it.
    await page.getByLabel("Email").fill("eyad@engosoft.test");
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    return;
  }
  if (state === "error") {
    // React Query retries a 500 twice with backoff; the shot waits for the banner it ends in.
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
  }
  if (state === "loading") {
    await expect(page.locator('[aria-hidden="true"].bg-muted, [aria-busy="true"]').first()).toBeVisible();
  }
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
          if (screen.mock) await mockApi(page, mockStateFor(screen, state));
          await page.goto(screen.route);
          if (screen.mock && state !== "loading") await page.waitForLoadState("networkidle");
          await page.evaluate(() => document.fonts.ready);
          // The shell scrolls inside <main>, so fullPage alone would stop at the viewport. Grow the
          // viewport by the hidden content height so the shot shows the whole screen.
          const hidden = await page.evaluate(() => {
            const main = document.querySelector("main");
            return main ? main.scrollHeight - main.clientHeight : 0;
          });
          if (hidden > 0) await page.setViewportSize({ width, height: height + hidden });
          await prepare(page, screen, state);

          mkdirSync(`${SHOTS_DIR}/${screen.id}`, { recursive: true });
          await page.screenshot({ path: `${SHOTS_DIR}/${screen.id}/${name}.png`, fullPage: true });
          await expect(page).toHaveScreenshot(`${screen.id}/${name}.png`, { fullPage: true });
        });
      }
    }
  }
}
