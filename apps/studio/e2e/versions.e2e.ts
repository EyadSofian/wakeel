import { expect, type Page, test } from "@playwright/test";
import { node, openNewBot } from "./helpers";

/**
 * Task 7.5 acceptance on the real api: publish, change the draft, compare, roll back; then a secret
 * config value is set and never shown again.
 */
const inspector = (page: Page) => page.getByRole("complementary", { name: /^Inspector: / });

async function publish(page: Page, label: string) {
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Publish v/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Label").fill(label);
  await dialog.getByRole("button", { name: "Publish" }).click();
  await expect(dialog).toBeHidden();
}

test("publish, change, compare and roll back", async ({ page }) => {
  test.setTimeout(120_000);
  const { ws, bot } = await openNewBot(page, "versions");

  // The seeded bot cannot be published until its Autonomous node has instructions.
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const blocked = page.getByRole("dialog", { name: "Publish v1" });
  await expect(blocked.getByText("1 problem blocks publishing")).toBeVisible();
  await expect(blocked.getByRole("button", { name: "Publish" })).toBeDisabled();
  await blocked.getByRole("button", { name: "Cancel" }).click();

  await node(page, "Assistant").locator("header").click();
  const instructions = inspector(page).getByLabel("Instructions");
  await instructions.fill("ساعد العميل في متابعة طلبه.");
  await instructions.blur();
  await publish(page, "First release");

  // Change the draft, then see the change since the live version and publish it.
  await instructions.fill("ساعد العميل في متابعة طلبه واسترجاعه.");
  await instructions.blur();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const second = page.getByRole("dialog", { name: "Publish v2" });
  await expect(second.getByText("Changes since v1, the live version")).toBeVisible();
  await expect(second.getByText("1 changed").first()).toBeVisible();
  await second.getByLabel("Label").fill("Refunds");
  await second.getByRole("button", { name: "Publish" }).click();
  await expect(second).toBeHidden();

  // The versions list, then Compare v1 with the draft (the instruction change).
  await page.goto(`/w/${ws}/b/${bot}/versions`);
  const rows = page.getByRole("table", { name: "Versions" }).getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("v2");
  await expect(rows.nth(1)).toContainText("Live");
  await page.getByRole("link", { name: "Compare v1 with the draft" }).click();
  const changes = page.getByRole("table", { name: "Changes" });
  await expect(changes).toContainText("instructions");
  await expect(changes).toContainText("ساعد العميل في متابعة طلبه واسترجاعه.");

  // Roll back to v1: it becomes live; nothing else changes.
  await page.getByRole("main").getByRole("link", { name: "Versions" }).click();
  await page.getByRole("button", { name: "Roll back to v1" }).click();
  await page.getByRole("dialog", { name: "Roll back to v1?" }).getByRole("button", { name: "Roll back" }).click();
  await expect(rows.nth(2)).toContainText("Live");
  await expect(rows.nth(1)).not.toContainText("Live");
  const live = (await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}`)).json()).publishedVersionId;
  const versions = (await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}/versions`)).json()).data;
  expect(live).toBe(versions.find((v: { number: number }) => v.number === 1).id);
});

test("a secret config value is set per environment and never shown again", async ({ page }) => {
  test.setTimeout(90_000);
  const { ws, bot } = await openNewBot(page, "secrets");
  await page.goto(`/w/${ws}/b/${bot}/variables`);
  await page.getByRole("tab", { name: "Secrets and settings" }).click();
  await expect(page.getByText("No config variables yet")).toBeVisible();
  await page.getByRole("button", { name: "Add config variable" }).click();
  const declare = page.getByRole("dialog", { name: "Add config variable" });
  await declare.getByLabel("Key").fill("shop_token");
  await declare.getByRole("button", { name: "Add config variable" }).click();
  await page.getByRole("button", { name: "Set SHOP_TOKEN for Production" }).click();
  const set = page.getByRole("dialog", { name: "Set SHOP_TOKEN for Production" });
  await set.getByLabel("Value").fill("e2e-secret-token-7d1c");
  await set.getByRole("button", { name: "Set value" }).click();
  await expect(set).toBeHidden();
  await expect(page.getByRole("table", { name: "Config variables" })).toContainText("Set");
  const listed = await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}/config`)).text();
  expect(listed).not.toContain("e2e-secret-token-7d1c");
  await expect(page.locator("body")).not.toContainText("e2e-secret-token-7d1c");
});
