import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockApi, WS } from "./mock-api";

const table = {
  id: "tbl_01m7a256m0a13warwhczsjhx9b",
  name: "orders",
  revision: '"table"',
  columns: [
    { id: "col_Number0000", type: "number", name: "number" },
    { id: "col_Title00000", type: "string", name: "title", searchable: true },
    { id: "col_Status0000", type: "enum", name: "status", enumValues: ["جديد", "مكتمل"] },
  ],
};
const root = `/v1/workspaces/${WS}/bots/${BOT}/tables`;
const path = `${root}/${table.id}`;
const values = ["الفاتورة ORD-12", "مرتجع ORD-21", "شحنة من فرع الرياض"];
const data = values.map((title, i) => ({
  id: `row_01m7a256m0a13warwhczsjhx9${i}`,
  revision: '"row"',
  data: { col_Number0000: i + 1, col_Title00000: title, col_Status0000: "جديد" },
}));

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 1440]) {
    test(`Tables with Arabic data and keyboard focus in ${theme} at ${width}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, "rtl");
      await page.route(`**${root}**`, (route) => {
        const url = new URL(route.request().url()).pathname;
        if (url === root) return route.fulfill({ json: { data: [table], nextCursor: null } });
        if (url === path) return route.fulfill({ json: table });
        if (url === `${path}/rows/find`) return route.fulfill({ json: { data, nextCursor: null, rowCount: 3 } });
        return route.fallback();
      });
      await page.goto(`/w/${WS}/b/${BOT}/tables`);
      await page.getByRole("link", { name: table.name }).click();
      const cell = page.getByRole("button", { name: "Edit title: الفاتورة ORD-12" });
      await expect(cell).toHaveCSS("direction", "rtl");
      await page.getByRole("button", { name: "Edit number: 1", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(cell).toBeFocused();
      await expect(page).toHaveScreenshot(`tables-rtl-${theme}-${width}.png`);
      await cell.press("Enter");
      await expect(page.getByRole("textbox", { name: "title" })).toBeFocused();
    });
  }
}
