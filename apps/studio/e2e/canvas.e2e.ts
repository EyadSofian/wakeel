import { expect, test } from "@playwright/test";
import { drag, node, openNewBot, stored } from "./helpers";

/**
 * Task 2.4 acceptance: add nodes, connect, reconnect, delete, undo on the canvas against the real
 * api. What the canvas shows is checked against what autosave stored.
 */
test("add a node, connect, reconnect, delete and undo; autosave keeps up", async ({ page }) => {
  test.setTimeout(120_000);
  const { ws, bot } = await openNewBot(page, "canvas");
  const before = await stored(page, ws, bot);
  const [start, assistant] = before.nodes;

  // Add: double-click on empty canvas.
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.8);
  // Double-click opens the add-node menu; typing filters and Enter adds.
  const menu = page.getByRole("dialog", { name: "Add node" });
  await expect(menu).toBeVisible();
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  // A new node is selected and opens the inspector; Esc closes it and gives the canvas its width back
  // (with the inspector open, nodes pushed off-screen are not rendered).
  await expect(page.getByRole("complementary", { name: "Inspector: Standard node" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: /^Inspector/ })).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const added = (await stored(page, ws, bot)).nodes.find((n) => n.name === "Standard node");
  expect(added).toBeDefined();

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
