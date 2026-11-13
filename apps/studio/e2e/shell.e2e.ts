import { expect, type Locator, type Page, test } from "@playwright/test";
import { node, openNewBot } from "./helpers";

/**
 * Task 2.8 acceptance: the command palette runs every registered action, and `F8` / `⇧F8` cycle
 * through the issues. Also the Workflows panel: create, rename, duplicate, and delete with the
 * warning that lists who calls the workflow. Runs against the real api.
 */

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const inspector = (page: Page): Locator => page.getByRole("complementary", { name: /^Inspector: / });
const crumb = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" }).locator("span[aria-current=page]");
const nodes = (page: Page) => page.locator(".react-flow__node");
const zoom = (page: Page) => page.getByRole("toolbar", { name: "Zoom" }).locator("span[aria-live]");
const viewport = (page: Page) => page.locator(".react-flow__viewport").getAttribute("style");

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("combobox", { name: "Search commands and places" })).toBeFocused();
}

/** Runs an action by typing its name and choosing it, as a builder would. */
async function run(page: Page, label: string) {
  await openPalette(page);
  await page.keyboard.type(label);
  await palette(page).getByRole("group", { name: "Actions" }).getByRole("option", { name: label, exact: true }).click();
  await expect(palette(page)).toHaveCount(0);
}

/** Every action id the palette lists right now, available or not. */
async function registered(page: Page): Promise<string[]> {
  await openPalette(page);
  const ids = await palette(page)
    .locator('[data-row^="a:"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute("data-row") ?? "").slice(2)));
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  return ids.sort();
}

/** The actions this test runs. A new action that is not here fails the first assertion. */
const COVERED = [
  "canvas.add-card",
  "canvas.add-node",
  "canvas.delete",
  "canvas.duplicate",
  "canvas.fit",
  "canvas.minimap",
  "canvas.redo",
  "canvas.rename",
  "canvas.shortcuts",
  "canvas.tidy",
  "canvas.tool-pan",
  "canvas.tool-select",
  "canvas.undo",
  "canvas.zoom-100",
  "canvas.zoom-in",
  "canvas.zoom-out",
  "shell.delete-workflow",
  "shell.duplicate-workflow",
  "shell.issues",
  "shell.new-workflow",
  "shell.next-issue",
  "shell.previous-issue",
  "shell.rename-workflow",
];

test("the palette runs every registered action", async ({ page }) => {
  test.setTimeout(240_000);
  await openNewBot(page, "palette");
  expect(await registered(page)).toEqual(COVERED);

  // New workflow: the dialog creates a sub-workflow and opens it.
  await run(page, "New workflow");
  const dialog = page.getByRole("dialog", { name: "New workflow" });
  await dialog.getByRole("button", { name: "Create workflow" }).click();
  await expect(dialog).toContainText("Give the workflow a name.");
  await dialog.getByLabel("Name").fill("Refunds");
  await dialog.getByRole("button", { name: "Create workflow" }).click();
  await expect(crumb(page)).toHaveText("Refunds");
  await expect(nodes(page)).toHaveCount(2);

  // Add node, then Add card on it.
  await run(page, "Add node");
  await expect(page.getByRole("dialog", { name: "Add node" })).toBeVisible();
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  await expect(nodes(page)).toHaveCount(3);
  await run(page, "Add card");
  await expect(page.getByRole("dialog", { name: "Add card" })).toBeVisible();
  await page.keyboard.type("send message");
  await page.keyboard.press("Enter");
  await expect(node(page, "Standard node").locator("[data-card]")).toHaveCount(1);

  // Duplicate selects the copy; Delete removes it; Undo and Redo walk that back and forth.
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  await run(page, "Duplicate");
  await expect(nodes(page)).toHaveCount(4);
  await run(page, "Delete");
  await expect(nodes(page)).toHaveCount(3);
  await run(page, "Undo");
  await expect(nodes(page)).toHaveCount(4);
  await run(page, "Redo");
  await expect(nodes(page)).toHaveCount(3);

  // Rename node opens the name in place.
  await node(page, "Exit").locator("header").click();
  await run(page, "Rename node");
  await expect(page.getByRole("textbox", { name: "Node name" })).toBeFocused();
  await page.keyboard.press("Escape");

  // Tidy layout puts a node that was nudged out of line back in the layout.
  await page.keyboard.press("Escape");
  await node(page, "Exit").locator("header").click();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowDown");
  const nudged = await node(page, "Exit").boundingBox();
  await run(page, "Tidy layout");
  await expect.poll(async () => (await node(page, "Exit").boundingBox())?.y).not.toBe(nudged?.y);

  // Zoom and fit.
  await run(page, "Zoom to 100%");
  await expect(zoom(page)).toHaveText("100%");
  await run(page, "Zoom in");
  await expect.poll(async () => Number.parseInt((await zoom(page).textContent()) ?? "0", 10)).toBeGreaterThan(100);
  await run(page, "Zoom out");
  await expect(zoom(page)).toHaveText("100%");
  await run(page, "Zoom in");
  await run(page, "Zoom in");
  const zoomed = await viewport(page);
  await run(page, "Fit the workflow");
  await expect.poll(() => viewport(page)).not.toBe(zoomed);

  // Tools, minimap and the shortcut sheet.
  const tools = page.getByRole("toolbar", { name: "Canvas" });
  await run(page, "Select tool");
  await expect(tools.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
  await run(page, "Pan tool");
  await expect(tools.getByRole("button", { name: "Pan" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".react-flow__minimap")).toHaveCount(1);
  await run(page, "Show or hide the minimap");
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
  await run(page, "Show keyboard shortcuts");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Issues: the panel, then next and previous (Main's Assistant has no instructions yet).
  await run(page, "Show issues");
  await expect(page.getByRole("dialog", { name: "Issues" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Issues" })).toHaveCount(0);
  await run(page, "Next issue");
  await expect(inspector(page)).toBeVisible();
  const first = await inspector(page).getAttribute("aria-label");
  await run(page, "Previous issue");
  await expect(inspector(page)).toBeVisible();
  expect(first).toMatch(/^Inspector: /);

  // Workflow actions on Refunds: rename, duplicate (opens the copy), delete the copy.
  await page.getByRole("tab", { name: "Workflows" }).click();
  await page
    .getByRole("list", { name: "Workflows" })
    .getByRole("button", { name: /^Refunds/ })
    .click();
  await expect(crumb(page)).toHaveText("Refunds");
  await run(page, "Rename workflow");
  const rename = page.getByRole("dialog", { name: "Rename workflow" });
  await rename.getByLabel("Name").fill("طلبات الاسترجاع");
  await rename.getByRole("button", { name: "Rename workflow" }).click();
  await expect(crumb(page)).toHaveText("طلبات الاسترجاع");
  await run(page, "Duplicate workflow");
  await expect(crumb(page)).toHaveText("طلبات الاسترجاع copy");
  await expect(nodes(page)).toHaveCount(3);
  await run(page, "Delete workflow");
  const remove = page.getByRole("dialog", { name: 'Delete workflow "طلبات الاسترجاع copy"?' });
  await expect(remove).toContainText("Nothing calls it.");
  await remove.getByRole("button", { name: "Delete workflow" }).click();
  await expect(crumb(page)).toHaveText("Main");
  await expect(page.getByRole("list", { name: "Workflows" })).not.toContainText("copy");
});

test("deleting a workflow that is called warns and lists the callers", async ({ page }) => {
  test.setTimeout(180_000);
  const { ws, bot } = await openNewBot(page, "wf-delete");
  await page.getByRole("tab", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByRole("dialog", { name: "New workflow" }).getByLabel("Name").fill("Track order");
  await page.keyboard.press("Enter");
  await expect(crumb(page)).toHaveText("Track order");

  // Main calls it from a Run workflow card.
  await page.getByRole("list", { name: "Workflows" }).getByRole("button", { name: /^Main/ }).click();
  await expect(crumb(page)).toHaveText("Main");
  await page.locator(".react-flow__pane").click();
  await page.keyboard.press("n");
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await page.keyboard.press("c");
  await page.keyboard.type("run workflow");
  await page.keyboard.press("Enter");
  await expect(node(page, "Standard node")).toContainText("Track order");

  // The row menu: Main says why it cannot be deleted; Track order warns and lists the caller.
  await page.getByRole("button", { name: "More for Main" }).click();
  await expect(page.getByRole("menuitem", { name: /Delete workflow/ })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More for Track order" }).click();
  await page.getByRole("menuitem", { name: "Delete workflow" }).click();
  const dialog = page.getByRole("dialog", { name: 'Delete workflow "Track order"?' });
  await expect(dialog).toContainText("1 place calls it and will stop working.");
  await expect(dialog.getByRole("list", { name: "Places that call it" })).toContainText("Main / Standard node");
  await expect(dialog).toContainText("Run workflow card");
  await dialog.getByRole("button", { name: "Delete workflow" }).click();
  await expect(dialog).toHaveCount(0);

  // Gone from the server too, and the card that called it is now an issue.
  const detail = await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}`)).json();
  expect(detail.docs.filter((d: { kind: string }) => d.kind === "workflow")).toHaveLength(1);
  await page.getByRole("button", { name: /Show issues$/ }).click();
  await expect(page.getByRole("dialog", { name: "Issues" })).toContainText("Main › Standard node › Run workflow");
});

test("F8 and ⇧F8 cycle through every issue and focus where it is", async ({ page }) => {
  test.setTimeout(180_000);
  await openNewBot(page, "f8");
  // A second autonomous node without instructions: two errors on two nodes.
  await page.locator(".react-flow__pane").click();
  await page.keyboard.press("n");
  await page.keyboard.type("autonomous");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Autonomous node");
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__pane").click();

  // The order F8 follows is the panel's: read it there.
  await page.getByRole("button", { name: /Show issues$/ }).click();
  const panel = page.getByRole("dialog", { name: "Issues" });
  const rows = panel.getByRole("button", { name: /›/ });
  await expect(rows.first()).toBeVisible();
  const places = (await rows.allTextContents()).map((t) => t.slice(t.lastIndexOf("Main ›")));
  expect(places.length).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");

  const nodeOf = (place: string) => place.split(" › ")[1] ?? "";
  const expectAt = async (place: string) => {
    await expect(inspector(page)).toHaveAccessibleName(`Inspector: ${nodeOf(place)}`);
    // The field the issue is about, or the node's first field, has focus.
    await expect(inspector(page).locator(":focus")).toHaveCount(1);
  };
  for (const place of places) {
    await page.keyboard.press("F8");
    await expectAt(place);
  }
  // Wraps to the first, then ⇧F8 goes back to the last.
  await page.keyboard.press("F8");
  await expectAt(places[0] ?? "");
  await page.keyboard.press("Shift+F8");
  await expectAt(places[places.length - 1] ?? "");
});
