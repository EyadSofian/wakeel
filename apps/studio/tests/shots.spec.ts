import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { CanvasFixture } from "./canvas-fixtures";
import { type EmulatorScenario, SENT } from "./emulator-fixtures";
import { type MockState, mockApi } from "./mock-api";
import { type Screen, type ScreenState, selectedScreens, THEMES } from "./screens";

/**
 * `pnpm studio:shots [--screen <id>] [--update]` (design system §8.1). Writes
 * apps/studio/.shots/<screen>/<state>-<theme>-<width>.png for review, and compares each against its
 * committed baseline (0.1% threshold). Reduced motion is on so frames are stable.
 */
const SHOTS_DIR = fileURLToPath(new URL("../.shots", import.meta.url));
/** The moment every shot is taken at: the mock bots then read "10 hours ago", "yesterday", "3 days ago". */
const SHOT_TIME = new Date("2026-11-13T18:40:00.000Z");

const MOCK_STATES: readonly MockState[] = ["default", "empty", "loading", "error", "rtl", "signed-out"];

/** Screen states that only change what is on screen use the default data. */
const mockStateFor = (screen: Screen, state: ScreenState): MockState => {
  if (screen.id === "sign-in") return "signed-out";
  // The emulator's states are its own; the canvas behind it always loads.
  if (screen.id === "emulator") return "default";
  if (state === "empty" && screen.id === "canvas") return "default";
  if (state === "card-rtl") return "rtl";
  return MOCK_STATES.find((m) => m === state) ?? "default";
};

const canvasFor = (screen: Screen, state: ScreenState): CanvasFixture | "variables" =>
  screen.id === "variables"
    ? "variables"
    : state === "dense-300" || state === "issues" || state === "empty"
      ? state
      : "typical";

/** Which card row of the first standard node each inspector state opens. */
const CARD_ROW: Partial<Record<ScreenState, number>> = {
  "card-say": 0,
  "card-ask": 1,
  "card-condition": 2,
  "card-invalid": 0,
  "card-rtl": 0,
  picker: 1,
};

const EMULATOR_SCENARIO: Partial<Record<ScreenState, EmulatorScenario>> = {
  loading: "running",
  error: "error",
  rtl: "rtl",
  bubbles: "bubbles",
};
const emulatorScenario = (state: ScreenState): EmulatorScenario => EMULATOR_SCENARIO[state] ?? "conversation";

/** Opens the emulator and plays the state's scenario (task 4.6), then lets entrances finish. */
async function prepareEmulator(page: Page, state: ScreenState): Promise<void> {
  await playEmulator(page, state);
  // Choice buttons fade in and the typing dots appear after 300 ms (§5.3): shoot the settled frame.
  // The typing loop never settles, so it is left out.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== "running" || (a.effect?.getTiming().iterations ?? 1) === Number.POSITIVE_INFINITY),
  );
}

async function playEmulator(page: Page, state: ScreenState): Promise<void> {
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Emulator" });
  if (state === "run-from") {
    await page
      .getByRole("button", { name: /^Actions for / })
      .nth(1)
      .click();
    await page.getByRole("menuitem", { name: /Run from here/ }).click();
    await expect(panel.getByText("Waiting for the user")).toBeVisible();
    return;
  }
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(panel).toBeVisible();
  if (state === "empty") return;
  if (state === "user-form") {
    await panel.getByRole("button", { name: /Test user/ }).click();
    await expect(panel.getByRole("form", { name: "Test user" })).toBeVisible();
    return;
  }
  const scenario = emulatorScenario(state);
  const texts = state === "variables" || state === "trace" ? [...SENT.conversation, "5678"] : SENT[scenario];
  const box = panel.getByRole("textbox", { name: "Message the bot" });
  for (const [i, text] of texts.entries()) {
    await box.fill(text);
    await box.press("Enter");
    if (scenario === "running") await expect(panel.getByRole("status", { name: "Typing…" })).toBeVisible();
    else await expect(panel.locator("p", { hasText: / s$|Waiting for the user/ })).toHaveCount(i + 1);
  }
  if (state === "trace") {
    // The second turn's trace, with its branch step selected: details below, card selected on the canvas.
    await panel.getByTitle("Open this turn's trace").last().click();
    await panel
      .getByRole("list", { name: "Steps" })
      .getByRole("button", { name: /Condition|Branch/ })
      .click();
    await expect(panel.getByRole("region", { name: "Step details" })).toBeVisible();
    // Park the pointer so no row shows its hover background in the shot.
    await page.mouse.move(0, 0);
  }
  if (state === "variables") {
    await panel.getByRole("tab", { name: "Variables" }).click();
    await expect(panel.getByText("2 changed")).toBeVisible();
  }
  if (state === "focus") {
    // Keyboard focus on a choice button, to review the focus ring (checklist 18).
    await box.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(":focus-visible")).toHaveCount(1);
  }
}

async function prepare(page: Page, screen: Screen, state: ScreenState): Promise<void> {
  if (screen.id === "emulator") return prepareEmulator(page, state);
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
  if (state === "picker") {
    // The Ask card's "Save the answer to" picker, open, with a new name typed.
    const picker = page.getByRole("complementary").getByLabel("Save the answer to");
    await picker.click();
    await page.getByRole("combobox", { name: "Search variables" }).fill("order");
    await expect(page.getByRole("listbox", { name: "Variables" }).getByRole("option").first()).toBeVisible();
  }
  if (screen.id === "variables" && !["loading", "error"].includes(state)) {
    await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
  }
  if (state === "usages") {
    await page.getByRole("button", { name: /^conversation\.topic: / }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  if (screen.id === "settings-models" && state === "edit") {
    await page.getByRole("button", { name: "Add the OpenAI key" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByLabel("API key").fill("sk-not-a-real-key-000000");
  }
  if (state === "edit" && screen.id !== "settings-models") {
    await page.getByRole("button", { name: "Edit user.plan" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("tier");
    await expect(page.getByRole("dialog")).toContainText("will change to user.tier");
  }
  if (state === "delete-blocked") {
    await page.getByRole("button", { name: "Delete conversation.topic" }).click();
    await expect(page.getByRole("dialog", { name: "conversation.topic is in use" })).toBeVisible();
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
  if (screen.id.startsWith("connection") && !["loading", "error"].includes(state)) {
    await expect(page.locator("main h1").first()).not.toBeEmpty();
    await expect(page.locator('main [aria-hidden="true"].bg-muted')).toHaveCount(0);
  }
  if (screen.id === "connection-test" && (state === "tested" || state === "rtl")) {
    // A test event the receiver refused, and one message with the bot's reply.
    await page.getByRole("button", { name: "Send test event" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page
      .getByLabel("Message", { exact: true })
      .fill(state === "rtl" ? "عايز أعرف حالة طلبي 5678" : "Where is my order 5678?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("list", { name: "Replies" })).toBeVisible();
    await page.mouse.move(0, 0);
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
          if (screen.mock) {
            await mockApi(page, mockStateFor(screen, state), canvasFor(screen, state), emulatorScenario(state));
          }
          // Relative dates ("3 days ago") follow the clock; a fixed one keeps shots the same every day.
          await page.clock.setFixedTime(SHOT_TIME);
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
