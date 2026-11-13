import { randomBytes } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * Task 2.4 acceptance: add nodes, connect, reconnect, delete, undo on the canvas against the real
 * api. What the canvas shows is checked against what autosave stored.
 */
const run = randomBytes(4).toString("hex");

async function openNewBot(page: Page): Promise<{ ws: string; bot: string }> {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Canvas builder");
  await page.getByLabel("Email").fill(`canvas-${run}@example.test`);
  await page.getByLabel("Password").fill(`e2e only ${run} pw`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "New workspace" })).toBeVisible();
  await page.getByLabel("Name").fill(`Canvas ${run}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("مساعد المتجر");
  await page.getByRole("dialog").getByRole("button", { name: "Create bot" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  const [, , ws, , bot] = new URL(page.url()).pathname.split("/");
  return { ws: ws ?? "", bot: bot ?? "" };
}

/** The Main workflow as autosave stored it, after the top bar says "Saved". */
async function stored(page: Page, ws: string, bot: string) {
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 5_000 });
  const detail = await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}`)).json();
  const mainId = detail.docs.find((d: { kind: string }) => d.kind === "workflow").docId;
  const doc = (await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}/docs/workflow/${mainId}`)).json()).doc;
  return doc as {
    nodes: { id: string; name: string }[];
    edges: { id: string; from: { nodeId: string; port: string }; to: { nodeId: string } }[];
  };
}

const node = (page: Page, name: string): Locator => page.locator(".react-flow__node").filter({ hasText: name });

async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("element not visible");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 12, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("add a node, connect, reconnect, delete and undo; autosave keeps up", async ({ page }) => {
  test.setTimeout(120_000);
  const { ws, bot } = await openNewBot(page);
  const before = await stored(page, ws, bot);
  const [start, assistant] = before.nodes;

  // Add: double-click on empty canvas.
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.8);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const added = (await stored(page, ws, bot)).nodes.find((n) => n.name === "Standard node");
  expect(added).toBeDefined();
  // A new node is selected and opens the inspector; Esc closes it and gives the canvas its width back.
  await expect(page.getByRole("complementary", { name: "Inspector: Standard node" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: /^Inspector/ })).toHaveCount(0);

  // Connect Start's output to the new node: the existing transition moves (one per output).
  await drag(
    page,
    node(page, "Start").locator('.react-flow__handle[data-handleid="next"]'),
    node(page, "Standard node"),
  );
  let doc = await stored(page, ws, bot);
  expect(doc.edges).toHaveLength(1);
  expect(doc.edges[0]?.to.nodeId).toBe(added?.id);

  // Connect the new node's output to the Assistant.
  await drag(
    page,
    node(page, "Standard node").locator('.react-flow__handle[data-handleid="next"]'),
    node(page, "Assistant"),
  );
  doc = await stored(page, ws, bot);
  expect(doc.edges.map((e) => `${e.from.nodeId}>${e.to.nodeId}`).sort()).toEqual(
    [`${start?.id}>${added?.id}`, `${added?.id}>${assistant?.id}`].sort(),
  );

  // Reconnect: drag the arrowhead of Start's transition back to the Assistant.
  const startEdge = doc.edges.find((e) => e.from.nodeId === start?.id);
  const updater = page.locator(`[data-id="${startEdge?.id}"] .react-flow__edgeupdater-target`);
  await drag(page, updater, node(page, "Assistant"));
  doc = await stored(page, ws, bot);
  expect(doc.edges.find((e) => e.id === startEdge?.id)?.to.nodeId).toBe(assistant?.id);

  // Delete the new node with Backspace: its transitions go with it.
  await node(page, "Standard node").locator("header").click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  doc = await stored(page, ws, bot);
  expect(doc.nodes.map((n) => n.id)).toEqual([start?.id, assistant?.id]);
  expect(doc.edges).toHaveLength(1);

  // Undo brings it back, transitions included, and autosave stores that too.
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  doc = await stored(page, ws, bot);
  expect(doc.nodes.map((n) => n.id)).toContain(added?.id);
  expect(doc.edges).toHaveLength(2);

  // Start cannot be deleted.
  await node(page, "Start").locator("header").click();
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  // A reload shows what was stored.
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
});
