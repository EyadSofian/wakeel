import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { CanvasFixture } from "./canvas-fixtures";
import { type MockState, mockApi } from "./mock-api";
import { type Screen, type ScreenState, selectedScreens, THEMES } from "./screens";

/**
 * `pnpm studio:shots [--screen <id>] [--update]` (design system §8.1). Writes
 * apps/studio/.shots/<screen>/<state>-<theme>-<width>.png for review, and compares each against its
 * committed baseline (0.1% threshold). Reduced motion is on so frames are stable.
 */
const SHOTS_DIR = fileURLToPath(new URL("../.shots", import.meta.url));

const MOCK_STATES: readonly MockState[] = ["default", "empty", "loading", "error", "rtl", "signed-out"];

/** Screen states that only change what is on screen use the default data. */
const mockStateFor = (screen: Screen, state: ScreenState): MockState => {
  if (screen.id === "sign-in") return "signed-out";
  if (state === "empty" && screen.id === "canvas") return "default";
  if (state === "card-rtl") return "rtl";
  return MOCK_STATES.find((m) => m === state) ?? "default";
};

const canvasFor = (state: ScreenState): CanvasFixture =>
  state === "dense-300" || state === "issues" || state === "empty" ? state : "typical";

/** Which card row of the first standard node each inspector state opens. */
const CARD_ROW: Partial<Record<ScreenState, number>> = {
  "card-say": 0,
  "card-ask": 1,
  "card-condition": 2,
  "card-invalid": 0,
  "card-rtl": 0,
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
  if (screen.id === "canvas" && !["loading", "error"].includes(state)) {
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // Validation runs in a worker; the issue count settles before the shot.
    await expect(page.locator('[data-validated="true"]')).toBeVisible();
  }
  if (state === "node-menu") {
    const pane = await page.locator(".react-flow__pane").boundingBox();
    if (!pane) throw new Error("no canvas");
    await page.mouse.dblclick(pane.x + 60, pane.y + 140);
    await expect(page.getByRole("dialog", { name: "Add node" })).toBeVisible();
  }
  if (state === "card-menu") {
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "Greeting" })
      .getByRole("button", { name: "Add card" })
      .click();
    await expect(page.getByRole("dialog", { name: "Add card" })).toBeVisible();
  }
  if (state === "shortcuts") {
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  }
  if (state === "cursor") {
    // Keyboard: select Greeting, go inside, move to the Condition card's "Order" output, start connecting.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowRight");
  }
  const index = CARD_ROW[state];
  if (index !== undefined) {
    // Open a card of the first standard node in the inspector by clicking its row on the canvas.
    await page.locator(".react-flow__node [data-card] > div:first-child").nth(index).click();
    await expect(page.getByRole("complementary", { name: /^Inspector: / })).toBeVisible();
    if (state === "card-invalid") {
      // A broken placeholder, typed but not yet committed: the field shows what happened and the fix.
      const text = page.getByRole("complementary").getByLabel("Text", { exact: true });
      await text.click();
      await text.press("End");
      await text.pressSequentially(" {{user.name");
      await expect(page.getByRole("complementary").getByRole("alert")).toBeVisible();
    }
  }
  if (state === "selection") {
    // Two nodes: one by click, one by Shift+click (design system §5.1 Selection).
    await page.locator(".react-flow__node").nth(2).locator("header").click();
    await page
      .locator(".react-flow__node")
      .nth(3)
      .locator("header")
      .click({ modifiers: ["Shift"] });
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
          if (screen.mock) await mockApi(page, mockStateFor(screen, state), canvasFor(state));
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
