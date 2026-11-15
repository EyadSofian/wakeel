import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockApi, WS } from "./mock-api";

const table = {
  id: "tbl_01m7a256m0a13warwhczsjhx9b",
  name: "orders",
  rowCount: 2,
  revision: '"table"',
  columns: [{ id: "col_Title00000", type: "string", name: "title", unique: true }],
};
const path = `/v1/workspaces/${WS}/bots/${BOT}`;

for (const theme of ["light", "dark"] as const) {
  test(`configures a table card with Arabic data in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: theme === "light" ? 1440 : 1280, height: 900 });
    await mockApi(page, "rtl");
    await page.route(`**${path}/tables?*`, (route) => route.fulfill({ json: { data: [table], nextCursor: null } }));
    await page.goto(`/w/${WS}/b/${BOT}`);
    await page.getByRole("button", { name: "Add card", exact: true }).first().click();
    const picker = page.getByRole("dialog", { name: "Add card" });
    await picker.getByRole("combobox").fill("Table");
    const option = picker.getByRole("option", { name: /^Table / });
    await expect(option).not.toHaveAttribute("aria-disabled", "true");
    await picker.getByRole("combobox").press("Enter");
    const operation = page.getByLabel("Operation", { exact: true });
    await expect(operation).toHaveValue("find");
    await operation.selectOption("upsert");
    await page.getByLabel("Unique column", { exact: true }).selectOption("title");
    const values = page.getByLabel("Values", { exact: true });
    await values.fill('{"title":"\\"فاتورة ORD-12\\""}');
    const saved = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        request.url().includes("/docs/workflow/") &&
        (request.postData() ?? "").includes("فاتورة ORD-12"),
    );
    await values.press("Tab");
    expect((await saved).postDataJSON().doc.nodes.flatMap((n: { cards?: unknown[] }) => n.cards ?? [])).toContainEqual(
      expect.objectContaining({
        type: "table",
        tableId: table.id,
        operation: "upsert",
        upsertOn: "title",
        values: { title: '"فاتورة ORD-12"' },
      }),
    );
    await expect(page).toHaveScreenshot(`table-card-rtl-${theme}.png`);
    const inspector = page.getByRole("complementary", { name: /^Inspector: / });
    await inspector.getByRole("button", { name: "Close inspector" }).click();
    await page.locator(".react-flow__node").filter({ hasText: "مساعد الطلبات" }).locator("header").click();
    await inspector.getByRole("button", { name: "Add table tool", exact: true }).click();
    const operations = inspector.getByRole("group", { name: "Allowed operations" });
    const toolSave = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        request.url().includes("/docs/workflow/") &&
        (request.postData() ?? "").includes('"operations":["find","get"]'),
    );
    await expect(operations.getByRole("checkbox", { name: "Find" })).toBeDisabled();
    const get = operations.getByRole("checkbox", { name: "Get", exact: true });
    await get.focus();
    await get.press("Space");
    await expect(get).toBeChecked();
    expect(
      (await toolSave).postDataJSON().doc.nodes.flatMap((n: { tools?: unknown[] }) => n.tools ?? []),
    ).toContainEqual(expect.objectContaining({ type: "table", tableId: table.id, operations: ["find", "get"] }));
    await expect(page).toHaveScreenshot(`table-tool-rtl-${theme}.png`);
  });
}
