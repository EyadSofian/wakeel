import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * Task 6.2 acceptance: add a key (write-only), pick defaults; the key is never returned by the api.
 * Every api response the page receives is checked for the key.
 */
test("add a provider key, pick defaults, and the key never comes back", async ({ page }) => {
  const run = randomBytes(4).toString("hex");
  const key = `sk-ant-e2e-${randomBytes(16).toString("hex")}`;
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (res.url().includes("/v1/")) bodies.push(await res.text().catch(() => ""));
  });

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Models owner");
  await page.getByLabel("Email").fill(`models-${run}@example.test`);
  await page.getByLabel("Password").fill(`e2e only ${run} pw`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "New workspace" })).toBeVisible();
  await page.getByLabel("Name").fill(`Models ${run}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("button", { name: "New bot" })).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Models" }).click();
  await page.getByRole("button", { name: "Add the Anthropic key" }).click();
  await page.getByRole("dialog").getByLabel("API key").fill(key);
  await page.getByRole("dialog").getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: "Anthropic" });
  await expect(row).toContainText(`…${key.slice(-4)}`);

  await page.getByLabel("Default model").selectOption("claude-sonnet-5-5");
  await page.getByLabel("Utility model").selectOption("claude-haiku-5-5");
  await page.getByRole("button", { name: "Save defaults" }).click();
  await page.reload();
  await expect(page.getByLabel("Default model")).toHaveValue("claude-sonnet-5-5");
  await expect(page.getByLabel("Utility model")).toHaveValue("claude-haiku-5-5");

  expect(bodies.length).toBeGreaterThan(5);
  for (const body of bodies) expect(body).not.toContain(key);
});
