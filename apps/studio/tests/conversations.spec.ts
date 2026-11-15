import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockApi, WS } from "./mock-api";

const path = `/v1/workspaces/${WS}/bots/${BOT}/conversations`;
const conversation = {
  id: "conv_01m7a256m0a13warwhczsjhx9b",
  connectionId: "conn_01m7a256m0a13warwhczsjhx01",
  connectionName: "المتجر",
  status: "idle",
  lastActivityAt: "2026-11-15T13:20:00.000Z",
  hasError: false,
  user: { id: "eu_01m7a256m0a13warwhczsjhx9b", externalId: "E-12", name: "منى" },
};
const turnId = "turn_01m7a256m0a13warwhczsjhx9b";
const text = "اتفضل فاتورة ORD-12";
const response = {
  id: "msg_01m7a256m0a13warwhczsjhx9b",
  seq: 1,
  conversationId: conversation.id,
  direction: "out",
  payload: { type: "text", text, format: "plain" },
  turnId,
  createdAt: conversation.lastActivityAt,
};

for (const theme of ["light", "dark"] as const) {
  test(`browses Arabic transcript and a trace in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: theme === "light" ? 1440 : 1280, height: 900 });
    await mockApi(page, "rtl");
    await page.route(`**${path}**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === path) {
        const q = url.searchParams.get("search");
        return route.fulfill({ json: { data: q && q !== "منى" ? [] : [conversation], nextCursor: null } });
      }
      return route.fulfill({ json: { conversation, messages: [response], nextCursor: null } });
    });
    await page.route(`**/turns/${turnId}/trace`, (route) =>
      route.fulfill({
        json: {
          turnId,
          conversationId: conversation.id,
          spans: [
            {
              id: "span_01m7a256m0a13warwhczsjhx9b",
              workspaceId: WS,
              botId: BOT,
              conversationId: conversation.id,
              turnId,
              seq: 0,
              name: "Run code",
              status: "ok",
              startedAt: response.createdAt,
              durationMs: 25,
              kind: "code.exec",
              attrs: { kind: "card", source: { inline: true, value: "return 12;" } },
            },
          ],
        },
      }),
    );
    await page.goto(`/w/${WS}/b/${BOT}/conversations`);
    await page.getByRole("textbox", { name: "Search conversations" }).fill("منى");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.getByRole("button", { name: /منى/ }).click();
    await expect(page.getByText(text)).toHaveCSS("direction", "rtl");
    await expect(page.getByRole("button", { name: "Add eval case" })).toBeDisabled();
    await expect(page).toHaveScreenshot(`conversations-list-${theme}.png`);
    await page.getByRole("button", { name: "Open trace" }).click();
    const sheet = page.getByRole("dialog", { name: "Turn trace" });
    await sheet.getByRole("button", { name: /Run code/ }).click();
    await expect(sheet.getByText("return 12;")).toBeVisible();
    await expect(page).toHaveScreenshot(`conversations-trace-${theme}.png`);
    await page.route("**/emulator/replay/**", (route) => {
      if (route.request().method() === "POST") {
        expect(route.request().postDataJSON()).toMatchObject({ allowSideEffects: false });
        return route.fulfill({
          status: 202,
          json: { conversationId: conversation.id, turnId, externalId: "replay-fixture" },
        });
      }
      return route.fulfill({ json: { status: "completed", messages: [response], trace: null } });
    });
    await sheet.getByRole("button", { name: "Replay on draft", exact: true }).click();
    await expect(sheet.getByRole("status")).toHaveText("Completed");
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("button", { name: "Open trace" })).toBeFocused();
  });
}
