import { expect, type Locator, type Page, test } from "@playwright/test";
import { node, openNewBot, stored } from "./helpers";

/**
 * Node and card editing by pointer, as a builder does it: a node added from the library lands in
 * free space and in view; the node menu and the inspector duplicate and delete it; the AI cards
 * can be added and their forms save. Checked against what autosave stored.
 */
const inspector = (page: Page): Locator => page.getByRole("complementary", { name: /^Inspector: / });

/** True when `inner` lies wholly inside `outer`. */
async function within(inner: Locator, outer: Locator): Promise<boolean> {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  if (!a || !b) return false;
  return a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
}

test("add, duplicate and delete nodes; add and edit an AI card", async ({ page }) => {
  test.setTimeout(120_000);
  const { ws, bot } = await openNewBot(page, "node-editing");

  // From the library: the new node does not cover another one and ends up in view beside the inspector.
  await page
    .getByRole("complementary", { name: "Library" })
    .getByRole("button", { name: /^Standard node/ })
    .click();
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  const added = node(page, "Standard node");
  await expect.poll(() => within(added, page.locator(".wk-canvas"))).toBe(true);
  let wf = await stored(page, ws, bot);
  const boxes = await page.locator(".react-flow__node").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1))
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);

  // The node menu duplicates, and the inspector deletes the copy; Start offers neither.
  await page.getByRole("button", { name: "Actions for Standard node" }).first().click();
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await inspector(page).getByRole("button", { name: "Delete node" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.getByRole("button", { name: "Actions for Start" }).click();
  await expect(page.getByRole("menuitem", { name: /^Rename/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Delete/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Generate text from the card menu, then an edit in Arabic that autosave keeps.
  await added.locator("header").click();
  await added.getByRole("button", { name: "Add card" }).click();
  await expect(page.getByRole("dialog", { name: "Add card" })).toBeVisible();
  await page.keyboard.type("Generate");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Generate text");
  const instructions = inspector(page).getByLabel("Instructions");
  await instructions.fill("اكتب رد قصير بالعامية المصرية");
  await instructions.blur();
  await inspector(page)
    .getByRole("switch", { name: /Also send it to the user/ })
    .click();
  wf = await stored(page, ws, bot);
  const card = wf.nodes.find((n) => n.type === "standard")?.cards?.[0] as unknown as {
    type: string;
    instructions: string;
    send: boolean;
    into: string;
  };
  expect(card.type).toBe("ai_generate");
  expect(card.instructions).toBe("اكتب رد قصير بالعامية المصرية");
  expect(card.send).toBe(true);
  expect(wf.variables.map((v) => v.id)).toContain(card.into);

  // Delete from the node menu removes the node and its card.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Actions for Standard node" }).click();
  await page.getByRole("menuitem", { name: /^Delete/ }).click();
  wf = await stored(page, ws, bot);
  expect(wf.nodes.some((n) => n.type === "standard")).toBe(false);
});
