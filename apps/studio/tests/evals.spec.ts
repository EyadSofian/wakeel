import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockApi, WS } from "./mock-api";

const suite = { id: "es_01m7a256m0a13warwhczsjhx9b", name: "طلبات المتجر", revision: 1 };
const assertion = { type: "contains", text: "فاتورة ORD-12" };
const item = {
  id: "ec_01m7a256m0a13warwhczsjhx9b",
  revision: 1,
  script: {
    name: "الفاتورة ORD-12",
    tags: ["ar-EG"],
    turns: [{ user: "وين الـinvoice؟", assert: [assertion] }],
  },
};
const run = {
  id: "er_01m7a256m0a13warwhczsjhx9b",
  suiteId: suite.id,
  target: { kind: "draft" },
  status: "passed",
  createdAt: "2026-11-15T12:00:00Z",
};
const root = `/v1/workspaces/${WS}/bots/${BOT}/evals`;
for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 1440]) {
    test(`runs and reviews an Arabic case in ${theme} at ${width}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, "rtl");
      let kicked = false;
      await page.route(`**${root}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === `${root}/suites`) return route.fulfill({ json: { data: [suite], nextCursor: null } });
        if (path === `${root}/suites/${suite.id}`) return route.fulfill({ json: { ...suite, cases: [item] } });
        if (path === `${root}/suites/${suite.id}/cases/${item.id}`) {
          expect(route.request().headers()["if-match"]).toBe('"1"');
          return route.fulfill({ json: { ...item, script: route.request().postDataJSON(), revision: 2 } });
        }
        if (path === `${root}/suites/${suite.id}/runs`) {
          if (route.request().method() === "POST") {
            expect(route.request().postDataJSON()).toEqual({ kind: "draft" });
            kicked = true;
            return route.fulfill({ status: 202, json: { ...run, status: "queued" } });
          }
          return route.fulfill({ json: { data: kicked ? [run] : [], nextCursor: null } });
        }
        return route.fulfill({
          json: {
            ...run,
            cases: [item],
            results: [
              {
                caseId: item.id,
                result: {
                  status: "passed",
                  durationMs: 120,
                  turns: [{ index: 0, assertions: [{ assertion, passed: true }] }],
                },
              },
            ],
          },
        });
      });
      await page.goto(`/w/${WS}/b/${BOT}/evals`);
      await page.getByRole("button", { name: item.script.name }).click();
      const editor = page.getByRole("dialog", { name: "Edit case" });
      await editor.getByLabel("Case script").fill("{");
      await editor.getByRole("button", { name: "Save case" }).click();
      await expect(editor.getByText("Enter valid JSON.", { exact: false })).toBeVisible();
      await editor.getByLabel("Case script").fill(JSON.stringify(item.script));
      await editor.getByRole("button", { name: "Save case" }).click();
      await expect(editor).toBeHidden();
      await page.getByRole("button", { name: "Run all" }).click();
      const results = page.getByRole("region", { name: "Run results" });
      await expect(results.getByRole("status")).toHaveText("Passed · 1/1 cases");
      await expect(results.getByText("ar-EG 1/1")).toBeVisible();
      await results.getByText(item.script.name).click();
      await expect(results.getByText("contains")).toBeVisible();
      await expect(page).toHaveScreenshot(`evals-rtl-${theme}-${width}.png`);
    });
  }
}
