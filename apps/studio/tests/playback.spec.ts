import { expect, type Page, test } from "@playwright/test";
import { SENT } from "./emulator-fixtures";
import { mockApi, WS } from "./mock-api";

/**
 * Task 6.9 acceptance (build plan): playback of a recorded three-step turn highlights cards in
 * order. The turn is the conversation scenario's second turn on the typical canvas, as the mock API
 * records it: Ask (card 2) → Condition (card 3) → Shipping FAQ's Say (card 4).
 * `pnpm --filter @wakeel/studio exec playwright test --project=flows`.
 */
const ROUTE = `/w/${WS}/b/bot_01m7a256m0a13warwhczsjhx9b`;
const card = (n: number) => `card_${String(n).padStart(10, "0")}`;

test.use({ viewport: { width: 1440, height: 900 } });

async function recordedTurn(page: Page, reducedMotion: "reduce" | "no-preference") {
  await page.emulateMedia({ reducedMotion });
  await mockApi(page, "default", "typical", "conversation");
  await page.goto(ROUTE);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Emulator" });
  const box = panel.getByRole("textbox", { name: "Message the bot" });
  for (const [i, text] of [...SENT.conversation, "5678"].entries()) {
    await box.fill(text);
    await box.press("Enter");
    await expect(panel.locator("p", { hasText: / s$|Waiting for the user/ })).toHaveCount(i + 1);
  }
  await panel.getByTitle("Open this turn's trace").last().click();
  // Every card that becomes the replay's current card, in order, with the time it did.
  await page.evaluate(() => {
    const w = window as unknown as { __active: { id: string; t: number }[] };
    w.__active = [];
    const t0 = performance.now();
    const seen = () => {
      const id = document.querySelector("[data-active]")?.closest("[data-card]")?.getAttribute("data-card");
      if (id && w.__active.at(-1)?.id !== id) w.__active.push({ id, t: Math.round(performance.now() - t0) });
    };
    new MutationObserver(seen).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-active"],
    });
  });
  return panel;
}

const active = (page: Page) =>
  page.evaluate(() => (window as unknown as { __active: { id: string; t: number }[] }).__active);

for (const mode of ["no-preference", "reduce"] as const) {
  test(`playback highlights the cards in order (${mode === "reduce" ? "reduced motion" : "normal motion"})`, async ({
    page,
  }) => {
    const panel = await recordedTurn(page, mode);
    await panel.getByRole("button", { name: "Play this turn" }).click();
    await expect(panel.getByRole("button", { name: "Pause" })).toBeVisible();
    // The list reveals steps as the replay reaches them; it ends back on Play after about 4 s.
    await expect(panel.getByRole("button", { name: "Play this turn" })).toBeVisible({ timeout: 8_000 });
    const order = await active(page);
    expect(order.map((a) => a.id)).toEqual([card(2), card(3), card(4)]);
    // Spaced by the recorded durations (20, 190 and 700 ms scaled to 4 s): the say comes last, late.
    const say = order[2]?.t ?? 0;
    const branch = order[1]?.t ?? 0;
    expect(say - branch).toBeGreaterThan(400);
    // The last card stays current; the steps list shows every step again.
    await expect(page.locator(`[data-card="${card(4)}"] [data-active]`)).toBeVisible();
    await expect(panel.getByRole("list", { name: "Steps" }).getByRole("listitem")).toHaveCount(6);
  });
}

test("2× halves the replay; the step button walks one card at a time and pauses", async ({ page }) => {
  const panel = await recordedTurn(page, "no-preference");
  await panel.getByRole("button", { name: /^Speed 1×/ }).click();
  await expect(panel.getByRole("button", { name: /^Speed 2×/ })).toBeVisible();
  const started = Date.now();
  await panel.getByRole("button", { name: "Play this turn" }).click();
  await expect(panel.getByRole("button", { name: "Play this turn" })).toBeVisible({ timeout: 6_000 });
  expect(Date.now() - started).toBeLessThan(3_500);

  await page.reload();
  const again = await recordedTurn(page, "no-preference");
  const next = again.getByRole("button", { name: "Next step" });
  await next.click(); // the Greeting node
  await next.click();
  await expect(page.locator(`[data-card="${card(2)}"] [data-active]`)).toBeVisible();
  await next.click();
  await expect(page.locator(`[data-card="${card(3)}"] [data-active]`)).toBeVisible();
  await expect(page.locator("[data-active]")).toHaveCount(1);
  await expect(again.getByRole("button", { name: "Play this turn" })).toBeVisible();
});
