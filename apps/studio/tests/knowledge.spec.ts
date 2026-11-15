import { expect, test } from "@playwright/test";
import { BOT } from "./canvas-fixtures";
import { mockApi, WS } from "./mock-api";

const KB = "kb_01m7a256m0a13warwhczsjhx9b";
const DOC = "doc_01m7a256m0a13warwhczsjhx9b";
const CHUNK = "chk_01m7a256m0a13warwhczsjhx9b";
const root = `/v1/workspaces/${WS}/bots/${BOT}/knowledge-bases`;
const path = `${root}/${KB}`;
const base = {
  id: KB,
  botId: BOT,
  name: "سياسة الاسترجاع",
  description: "",
  embeddingModel: "openai:text-embedding-3-large",
  settings: {},
  revision: '"fixture"',
};
const passage = "تقدر ترجع الطلب ORD-12 خلال ١٤ يومًا";

for (const theme of ["light", "dark"] as const) {
  test(`Knowledge RTL document and trace in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: theme === "light" ? 1440 : 1280, height: 900 });
    await mockApi(page, "rtl");
    let sourceAdded = false;
    await page.route(`**${root}**`, async (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      if (endpoint === path) return route.fulfill({ json: base });
      if (endpoint === root) return route.fulfill({ json: { data: [base], nextCursor: null } });
      if (endpoint === `${path}/sources`) {
        const source = {
          id: "src_01m7a256m0a13warwhczsjhx9b",
          label: "دليل المرتجعات",
          kind: "file",
          status: "syncing",
          lastSyncedAt: null,
          revision: '"fixture"',
          documents: 3,
          ready: 1,
          stages: [{ stage: "parse", done: 1, running: 1 }],
        };
        return route.fulfill({ json: { data: sourceAdded ? [source] : [], nextCursor: null } });
      }
      const document = {
        id: DOC,
        title: "دليل المرتجعات",
        language: "ar",
        status: "ready",
        tokenCount: 12,
        quality: 0.9,
      };
      if (endpoint === `${path}/documents`) return route.fulfill({ json: { data: [document], nextCursor: null } });
      if (endpoint === `${path}/documents/${DOC}`) return route.fulfill({ json: { ...document, markdown: passage } });
      if (endpoint === `${path}/documents/${DOC}/chunks`)
        return route.fulfill({
          json: { data: [{ id: CHUNK, ordinal: 0, text: passage, headingPath: ["الاسترجاع"] }], nextCursor: null },
        });
      if (endpoint === `${path}/test-search`) {
        expect(route.request().postDataJSON()).toEqual({ query: "إزاي أرجع ORD-12؟" });
        const hit = { chunkId: CHUNK, score: 0.9 };
        return route.fulfill({
          json: {
            passages: [
              {
                chunkId: CHUNK,
                documentId: DOC,
                title: document.title,
                headingPath: [],
                text: passage,
                score: 0.9,
                cite: "[[c1]]",
                meta: {},
              },
            ],
            trace: {
              query: "إزاي أرجع ORD-12؟",
              queryNormalised: "ازاي ارجع ord 12",
              kbIds: [KB],
              dense: [hit],
              lexical: [hit],
              fused: [hit],
              reranked: [hit],
              returned: 1,
              startedAt: "2026-11-15T00:00:00.000Z",
              durationMs: 20,
            },
          },
        });
      }
      return route.fallback();
    });
    await page.goto(`/w/${WS}/b/${BOT}/knowledge`);
    await page.getByRole("link", { name: base.name }).click();
    await expect(page.getByText("No sources yet", { exact: true })).toBeVisible();
    sourceAdded = true;
    await page.reload();
    await expect(page.getByText("Parsing 1 of 3")).toBeVisible();
    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "دليل المرتجعات" }).click();
    const preview = page.getByRole("region", { name: "Document preview" });
    await expect(preview.getByText(passage).first()).toHaveCSS("direction", "rtl");
    await expect(page).toHaveScreenshot(`knowledge-documents-${theme}.png`);
    await page.getByRole("button", { name: "Test search", exact: true }).click();
    await page.getByRole("textbox", { name: "Search query" }).fill("إزاي أرجع ORD-12؟");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Why", exact: true }).click();
    const trace = page.getByRole("region", { name: "Retrieval trace" });
    await expect(trace.getByRole("row")).toHaveCount(5);
    await expect(page).toHaveScreenshot(`knowledge-search-${theme}.png`);
  });
}
