import type { Page } from "@playwright/test";
import { Problem } from "@wakeel/contracts";
import { BOT } from "./canvas-fixtures";
import { type MockState, WS } from "./mock-api";

/** Stable eval-only responses let loading and failure keep the surrounding bot shell available. */
export async function mockEvalReview(page: Page, state: MockState): Promise<void> {
  const root = `/v1/workspaces/${WS}/bots/${BOT}/evals`;
  const suite = {
    id: "es_01m7a256m0a13warwhczsjhx9b",
    name: state === "rtl" ? "طلبات المتجر — ORD-12" : "Order replies",
    revision: 1,
  };
  const item = {
    id: "ec_01m7a256m0a13warwhczsjhx9b",
    revision: 1,
    script: {
      name:
        state === "rtl"
          ? "الفاتورة ORD-12 — عايز أعرف تفاصيل الطلب وتاريخ التوصيل للعنوان الجديد"
          : "Invoice and delivery date for an order with an updated address",
      tags: ["ar-EG", "orders"],
      turns: [{ user: "وين الـinvoice؟", assert: [{ type: "contains", text: "فاتورة ORD-12" }] }],
    },
  };
  await page.route(`**${root}/**`, async (route) => {
    if (state === "loading") return;
    if (state === "error")
      return route.fulfill({
        status: 500,
        json: Problem.parse({
          requestId: "req_01m7a256m0a13warwhczsjhx9g",
          type: "https://docs.wakeel.dev/errors/service_unavailable",
          status: 500,
          code: "internal_error",
          title: "Eval suites are unavailable",
          fix: "Try again in a moment.",
        }),
      });
    const path = new URL(route.request().url()).pathname;
    if (path === `${root}/suites`)
      return route.fulfill({ json: { data: state === "empty" ? [] : [suite], nextCursor: null } });
    if (path === `${root}/suites/${suite.id}`) return route.fulfill({ json: { ...suite, cases: [item] } });
    if (path.endsWith("/runs")) return route.fulfill({ json: { data: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: { code: "not_found" } });
  });
}
