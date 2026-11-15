import { expect, type Page, test } from "@playwright/test";
import { openNewBot, type StoredWorkflow, stored } from "./helpers";

/**
 * Task 2.5 acceptance: the canvas shortcut table (design system §5.1) driven by the keyboard
 * alone, after the bot is created. Every row of src/canvas/interaction/shortcuts.ts is exercised;
 * results are checked against what autosave stored, or against what the canvas shows when the row
 * changes only the view.
 */
const said = (page: Page) => page.locator(".wk-canvas > p[role='status']");
const viewport = (page: Page) => page.locator(".react-flow__viewport").getAttribute("style");
const byName = (wf: StoredWorkflow, name: string) => wf.nodes.find((n) => n.name === name);

test("every canvas shortcut, by keyboard only", async ({ page }) => {
  test.setTimeout(180_000);
  const { ws, bot } = await openNewBot(page, "keys");
  const key = (k: string) => page.keyboard.press(k);
  const save = () => stored(page, ws, bot);

  // ? shows the sheet; Esc closes it.
  await key("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await key("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);

  // Tab cycles nodes; an arrow selects the nearest node that way.
  await key("Tab");
  await expect(said(page)).toHaveText("Start selected");
  await key("Tab");
  await expect(said(page)).toHaveText("Assistant selected");
  await key("ArrowLeft");
  await expect(said(page)).toHaveText("Start selected");
  await key("Shift+Tab");
  await expect(said(page)).toHaveText("Assistant selected");

  // Esc clears the selection; then arrows pan.
  await key("Escape");
  const before = await viewport(page);
  await key("ArrowRight");
  await expect.poll(() => viewport(page)).not.toBe(before);

  // N: the add-node menu; typing filters, Enter adds and selects the node.
  await key("n");
  await expect(page.getByRole("dialog", { name: "Add node" })).toBeVisible();
  await page.keyboard.type("standard");
  await key("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector: Standard node" })).toBeVisible();
  let wf = await save();
  expect(wf.nodes.map((n) => n.type)).toEqual(["start", "autonomous", "standard"]);
  const standardId = byName(wf, "Standard node")?.id;

  // C and / open the card menu on the selected node.
  await key("c");
  await expect(page.getByRole("dialog", { name: "Add card" })).toBeVisible();
  await page.keyboard.type("send message");
  await key("Enter");
  await key("/");
  await page.keyboard.type("ask");
  await key("Enter");
  wf = await save();
  expect(byName(wf, "Standard node")?.cards?.map((c) => c.type)).toEqual(["say", "capture"]);
  expect(wf.variables.map((v) => v.name)).toEqual(["answer"]);

  // Enter goes inside the node; ↓ moves the cursor; ⌥↑ moves the card up.
  await key("Enter");
  await expect(said(page)).toHaveText("Inside Standard node");
  await key("ArrowDown");
  await key("Alt+ArrowUp");
  await expect(said(page)).toHaveText("Moved to position 1");
  wf = await save();
  expect(byName(wf, "Standard node")?.cards?.map((c) => c.type)).toEqual(["capture", "say"]);

  // Rows are now: Ask, its "failed" output, Send message, next. ⌫ deletes the card under the cursor.
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Backspace");
  await expect(said(page)).toHaveText("Card deleted");
  wf = await save();
  expect(byName(wf, "Standard node")?.cards?.map((c) => c.type)).toEqual(["capture"]);

  // On an output, Enter starts connecting; arrows choose the node; Enter connects.
  await key("ArrowDown");
  await expect(said(page)).toHaveText("Output next");
  await key("Enter");
  for (const dir of ["ArrowUp", "ArrowRight", "ArrowLeft", "ArrowDown"]) {
    if ((await said(page).textContent()) === "Connect to Assistant") break;
    await key(dir);
  }
  await expect(said(page)).toHaveText("Connect to Assistant");
  await key("Enter");
  wf = await save();
  const assistantId = byName(wf, "Assistant")?.id;
  expect(
    wf.edges.some((e) => e.from.nodeId === standardId && e.from.port === "next" && e.to.nodeId === assistantId),
  ).toBe(true);

  // Esc goes up to the node; F2 renames it in place.
  await key("Escape");
  await expect(said(page)).toHaveText("Standard node selected");
  await key("F2");
  await page.keyboard.type("Greeting");
  await key("Enter");
  wf = await save();
  expect(byName(wf, "Greeting")?.id).toBe(standardId);

  // ⇧ arrows move 8 px, ⇧⌥ arrows 1 px; ⌘Z undoes, ⇧⌘Z redoes.
  const at = wf.layout[standardId ?? ""] ?? { x: 0, y: 0 };
  await key("Shift+ArrowRight");
  await key("Shift+Alt+ArrowDown");
  wf = await save();
  expect(wf.layout[standardId ?? ""]).toEqual({ x: at.x + 8, y: at.y + 1 });
  await key("ControlOrMeta+z");
  wf = await save();
  expect(wf.layout[standardId ?? ""]).toEqual({ x: at.x + 8, y: at.y });
  await key("ControlOrMeta+Shift+z");
  wf = await save();
  expect(wf.layout[standardId ?? ""]).toEqual({ x: at.x + 8, y: at.y + 1 });

  // ⌘D duplicates and selects the copy; ⌫ deletes it.
  await key("ControlOrMeta+d");
  wf = await save();
  expect(wf.nodes.filter((n) => n.name === "Greeting")).toHaveLength(2);
  await key("Backspace");
  wf = await save();
  expect(wf.nodes.filter((n) => n.name === "Greeting")).toHaveLength(1);

  // ⌘C, ⌘V: paste a copy with new ids; the copy is selected, ⌫ removes it.
  await key("Tab");
  await key("Tab");
  await key("Tab");
  await expect(said(page)).toHaveText("Greeting selected");
  await key("ControlOrMeta+c");
  await expect(said(page)).toHaveText("Copied 1 node");
  await key("ControlOrMeta+v");
  await expect(said(page)).toHaveText("Pasted 1 node");
  wf = await save();
  const greetings = wf.nodes.filter((n) => n.name === "Greeting");
  expect(greetings).toHaveLength(2);
  expect(new Set(greetings.map((n) => n.id)).size).toBe(2);
  await key("Backspace");

  // Enter on a node's only output that already has a transition re-points it (the R path).
  await key("Tab");
  await expect(said(page)).toHaveText("Start selected");
  await key("Enter");
  await key("Enter");
  for (const dir of ["ArrowRight", "ArrowDown", "ArrowUp", "ArrowLeft"]) {
    if ((await said(page).textContent()) === "Connect to Greeting") break;
    await key(dir);
  }
  await expect(said(page)).toHaveText("Connect to Greeting");
  await key("Enter");
  await key("Escape");
  wf = await save();
  const startId = byName(wf, "Start")?.id;
  expect(wf.edges.find((e) => e.from.nodeId === startId)?.to.nodeId).toBe(standardId);

  // ⇧⌘L tidies: Start first, then the nodes it leads to.
  await key("ControlOrMeta+Shift+l");
  wf = await save();
  expect(wf.layout[startId ?? ""]).toEqual({ x: 0, y: 0 });
  expect(wf.layout[standardId ?? ""]?.x ?? 0).toBeGreaterThan(0);

  // Zoom: ⌘1 is 100%; ⌘+ and ⌘− step; ⌘0 fits.
  const level = page.getByRole("toolbar", { name: "Zoom" });
  await key("ControlOrMeta+1");
  await expect(level).toContainText("100%");
  await key("ControlOrMeta+=");
  // xyflow steps by 1.2; wait for the 160 ms zoom to land before the next step.
  await expect(level).toContainText("120%");
  await key("ControlOrMeta+-");
  await expect(level).toContainText("100%");
  await key("ControlOrMeta+0");
  await expect(level).not.toContainText("100%");

  // M hides the minimap; V and H switch tools.
  await expect(page.locator(".wk-minimap")).toHaveCount(1);
  await key("m");
  await expect(page.locator(".wk-minimap")).toHaveCount(0);
  await key("v");
  await expect(page.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
  await key("h");
  await expect(page.getByRole("button", { name: "Pan" })).toHaveAttribute("aria-pressed", "true");
});
