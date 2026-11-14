import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { SCREENSHOT_FIXTURES } from "@wakeel/testing";
import { openNewBot } from "./helpers";

/**
 * Task 4.6 acceptance: a three-node scripted bot runs in the emulator, choice buttons work, the RTL
 * fixtures render as sent, and Run from here starts at the chosen node. Runs against the real api
 * and turn worker (`node apps/worker/src/main.ts`) with no model calls.
 */
const ORIGIN = "http://127.0.0.1:5173";
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("base64url").replace(/[-_]/g, "x").slice(0, 10)}`;

/** Start → Greet (a choice: track or other) → Track | Other, written through the api. */
async function scriptedBot(page: Page, ws: string, bot: string) {
  const session = await (await page.request.get("/v1/auth/session")).json();
  const headers = { origin: ORIGIN, "x-csrf-token": session.csrfToken as string };
  const detail = await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}`)).json();
  const mainId = detail.docs.find((d: { kind: string }) => d.kind === "workflow").docId as string;
  const url = `/v1/workspaces/${ws}/bots/${bot}/docs/workflow/${mainId}`;
  const current = await (await page.request.get(url)).json();
  const start = current.doc.nodes.find((n: { type: string }) => n.type === "start").id as string;
  const [greet, track, other] = [id("node"), id("node"), id("node")];
  const [hello, ask, tracked, otherwise] = [id("card"), id("card"), id("card"), id("card")];
  const choice = id("var");
  const doc = {
    ...current.doc,
    variables: [{ id: choice, name: "choice", scope: "workflow", type: "string", sensitive: false }],
    nodes: [
      { id: start, type: "start", name: "Start" },
      {
        id: greet,
        type: "standard",
        name: "Greet",
        cards: [
          { id: hello, type: "say", message: { type: "text", text: "أهلاً بيك في متجر النور" } },
          {
            id: ask,
            type: "capture",
            kind: "choice",
            into: choice,
            routeByOption: true,
            prompt: {
              type: "choice",
              text: "تحب تعمل إيه؟",
              options: [
                { label: "تتبع الطلب", value: "track" },
                { label: "حاجة تانية", value: "other" },
              ],
            },
          },
        ],
      },
      {
        id: track,
        type: "standard",
        name: "Track",
        cards: [{ id: tracked, type: "say", message: { type: "text", text: SCREENSHOT_FIXTURES[1]?.text ?? "" } }],
      },
      {
        id: other,
        type: "standard",
        name: "Other",
        cards: [{ id: otherwise, type: "say", message: { type: "text", text: "تمام، اكتب سؤالك." } }],
      },
    ],
    edges: [
      { id: id("edge"), from: { nodeId: start, port: "next" }, to: { nodeId: greet } },
      { id: id("edge"), from: { nodeId: greet, port: `card:${ask}:option:track` }, to: { nodeId: track } },
      { id: id("edge"), from: { nodeId: greet, port: `card:${ask}:option:other` }, to: { nodeId: other } },
    ],
    layout: {
      [start]: { x: 0, y: 0 },
      [greet]: { x: 280, y: 0 },
      [track]: { x: 640, y: -120 },
      [other]: { x: 640, y: 160 },
    },
  };
  const res = await page.request.put(url, { headers: { ...headers, "if-match": `"${current.rev}"` }, data: { doc } });
  expect(res.status(), await res.text()).toBe(200);
}

const emulator = (page: Page) => page.getByRole("complementary", { name: "Emulator" });
const transcript = (page: Page) => emulator(page).getByRole("log", { name: "Test conversation" });

test("a three-node scripted bot runs in the emulator, and its choice buttons work", async ({ page }) => {
  const { ws, bot } = await openNewBot(page, "emulator");
  await scriptedBot(page, ws, bot);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);

  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(emulator(page).getByText("Send a message to test the draft")).toBeVisible();

  const box = emulator(page).getByRole("textbox", { name: "Message the bot" });
  await box.fill("مرحبا");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  await expect(transcript(page).getByText("أهلاً بيك في متجر النور")).toBeVisible();
  await expect(transcript(page).getByText("تحب تعمل إيه؟")).toBeVisible();

  const choices = transcript(page).getByRole("group", { name: "Choices" });
  await choices.getByRole("button", { name: "تتبع الطلب" }).click();
  await expect(transcript(page).getByText(SCREENSHOT_FIXTURES[1]?.text ?? "")).toBeVisible();
  // The answered question's buttons stay, but cannot be pressed again.
  await expect(choices.getByRole("button", { name: "تتبع الطلب" })).toBeDisabled();
  await expect(
    transcript(page)
      .getByText(/s · Waiting for the user|\d+\.\d s/)
      .first(),
  ).toBeVisible();

  // The Variables tab shows what the capture stored... until the workflow returned and cleared it.
  await emulator(page)
    .getByRole("button", { name: /Variables/ })
    .click();
  await expect(emulator(page).getByText(/KB of 256 KB/)).toBeVisible();
});

test("RTL fixtures render as sent, right to left when Arabic comes first", async ({ page }) => {
  const { ws, bot } = await openNewBot(page, "emulator-rtl");
  await scriptedBot(page, ws, bot);
  await page.reload();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const box = emulator(page).getByRole("textbox", { name: "Message the bot" });
  for (const fixture of SCREENSHOT_FIXTURES.filter((f) => f.id !== "long_token")) {
    await box.fill(fixture.text);
    await box.press("Enter");
    const bubble = transcript(page).getByText(fixture.text, { exact: true }).last();
    await expect(bubble).toBeVisible();
    const direction = await bubble.evaluate((el) => getComputedStyle(el).direction);
    expect(direction, fixture.id).toBe(fixture.direction);
  }
  // A long unbroken token wraps inside the panel instead of widening it.
  const long = SCREENSHOT_FIXTURES.find((f) => f.id === "long_token")?.text ?? "";
  await box.fill(long);
  await box.press("Enter");
  const panel = await emulator(page).boundingBox();
  const bubble = await transcript(page).getByText(long, { exact: true }).last().boundingBox();
  expect(bubble && panel && bubble.width <= panel.width).toBe(true);
});

test("Run from here starts a new conversation at the node; reset clears it", async ({ page }) => {
  const { ws, bot } = await openNewBot(page, "emulator-run");
  await scriptedBot(page, ws, bot);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);

  await page.getByRole("button", { name: "Actions for Track" }).click();
  await page.getByRole("menuitem", { name: /Run from here/ }).click();
  await expect(emulator(page).getByText("Started at")).toBeVisible();
  await expect(transcript(page).getByText(SCREENSHOT_FIXTURES[1]?.text ?? "")).toBeVisible();
  await expect(transcript(page).getByText("أهلاً بيك في متجر النور")).toHaveCount(0);

  await emulator(page).getByRole("button", { name: "Reset the conversation" }).click();
  await expect(emulator(page).getByText("Send a message to test the draft")).toBeVisible();

  // ⌘Enter with a node selected does the same. With the emulator open, Other may be off screen
  // (the canvas renders visible nodes only), so it is selected from the keyboard: Greet → Track → Other.
  await page.locator(".react-flow__node").filter({ hasText: "Greet" }).click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(emulator(page).getByText("Started at")).toContainText("Other");
  await expect(transcript(page).getByText("تمام، اكتب سؤالك.")).toBeVisible();
});

test("the test user form sets the user the bot sees", async ({ page }) => {
  const { ws, bot } = await openNewBot(page, "emulator-user");
  await scriptedBot(page, ws, bot);
  await page.reload();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await emulator(page)
    .getByRole("button", { name: /Test user/ })
    .click();
  const form = emulator(page).getByRole("form", { name: "Test user" });
  await form.getByLabel("Name").fill("منى");
  await form.getByLabel("Attributes").fill("not json");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByText(/Attributes must be a JSON object/)).toBeVisible();
  await form.getByLabel("Attributes").fill('{ "plan": "pro" }');
  await form.getByRole("button", { name: "Save" }).click();
  await expect(emulator(page).getByRole("button", { name: /منى/ })).toBeVisible();

  const box = emulator(page).getByRole("textbox", { name: "Message the bot" });
  await box.fill("مرحبا");
  await box.press("Enter");
  await expect(transcript(page).getByText("تحب تعمل إيه؟")).toBeVisible();
  await emulator(page)
    .getByRole("button", { name: /Variables/ })
    .click();
  await expect(emulator(page).getByText("User attributes")).toBeVisible();
  await expect(emulator(page).getByText("pro", { exact: true })).toBeVisible();
});
