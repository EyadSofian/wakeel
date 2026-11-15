import { expect, test } from "@playwright/test";
import { openNewBot } from "./helpers";

test("creates a table, edits Arabic cells by keyboard, filters and imports CSV", async ({ page }) => {
  await openNewBot(page, "tables");
  await page.getByRole("link", { name: "Tables" }).click();
  await expect(page.getByText("No tables yet")).toBeVisible();
  await page.getByRole("button", { name: "New table" }).click();
  const create = page.getByRole("dialog", { name: "New table" });
  await create.getByLabel("Table name").fill("orders");
  await create.getByLabel("Column name").fill("title");
  await create.getByLabel("Searchable").check();
  await create.getByRole("button", { name: "Create table" }).click();
  await page.getByRole("link", { name: "orders" }).click();

  await page.getByRole("button", { name: "Add row", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "title", exact: true });
  await expect(editor).toBeFocused();
  await editor.fill("فاتورة ORD-10");
  await editor.press("Control+Enter");
  const cell = page.getByRole("button", { name: "Edit title: فاتورة ORD-10" });
  await expect(cell).toHaveCSS("direction", "rtl");
  await cell.focus();
  await cell.press("Enter");
  await expect(editor).toBeFocused();
  await editor.fill("فاتورة ORD-12");
  await editor.press("Enter");

  await expect(page.getByRole("button", { name: "Edit title: فاتورة ORD-12" })).toBeVisible();
  await page.getByLabel("Filter column").selectOption({ label: "title" });
  await page.getByLabel("Operator").selectOption("contains");
  await page.getByLabel("Filter value").fill("ORD-12");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit title: فاتورة ORD-12" })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();

  await page.getByRole("button", { name: "Import CSV" }).click();
  const upload = page.getByRole("dialog", { name: "Import CSV" });
  await upload.getByLabel("CSV file").setInputFiles({
    name: "orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("title\r\nشحنة ORD-02\r\nمرتجع ORD-03"),
  });
  await upload.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit title: مرتجع ORD-03" })).toBeVisible();
  await expect(page.getByText("3 of 100,000 rows")).toBeVisible();
});
