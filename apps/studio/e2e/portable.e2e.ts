import { expect, test } from "@playwright/test";
import { openNewBot } from "./helpers";

/** Task 7.6 on the real api: export a bot, import the file from the home page, open the copy. */
test("export a bot and import it as a new one", async ({ page }) => {
  test.setTimeout(90_000);
  const { ws, bot } = await openNewBot(page, "portable");
  // The palette's Export bot downloads the file.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("Export bot");
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  expect(download.suggestedFilename()).toMatch(/\.wakeel\.json$/);
  const exported = await page.request.get(`/v1/workspaces/${ws}/bots/${bot}/export`);
  expect(exported.ok()).toBe(true);
  const body = await exported.body();

  await page.goto(`/w/${ws}`);
  await page.getByRole("button", { name: "Import bot" }).click();
  const dialog = page.getByRole("dialog", { name: "Import bot" });
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: "store.wakeel.json", mimeType: "application/json", buffer: body });
  await expect(dialog.getByText("store.wakeel.json")).toBeVisible();
  // The name comes from the file; give the copy its own.
  await expect(dialog.getByLabel("Name")).toHaveValue("مساعد المتجر");
  await dialog.getByLabel("Name").fill("نسخة المتجر");
  await dialog.getByLabel("Address").fill(`copy-${Date.now()}`);
  await dialog.getByRole("button", { name: "Import bot" }).click();
  const done = page.getByRole("dialog", { name: "Bot imported" });
  await expect(done).toBeVisible();
  await done.getByRole("button", { name: "Open bot" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByText("نسخة المتجر").first()).toBeVisible();
});
