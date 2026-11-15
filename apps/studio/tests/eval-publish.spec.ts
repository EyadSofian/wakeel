import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockApi, WS } from "./mock-api";

test("Publish shows draft evaluation results and stops a publish when the gate is enabled", async ({ page }) => {
  await mockApi(page, "rtl");
  await page.route("**/evals/publish-status", (route) => route.fulfill({ json: { passed: 1, failed: 1, errors: 0 } }));
  await page.goto(`/w/${WS}/b/${BOT}`);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Publish v/ });
  await expect(dialog.getByText("1 passed · 1 failed · 0 errors")).toBeVisible();
  await dialog.getByLabel("Label", { exact: true }).fill("فاتورة ORD-12");
  await dialog.getByRole("switch", { name: "Block publishing on unsuccessful evals" }).click();
  await expect(dialog.getByText("Unsuccessful evals block publishing")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
});
