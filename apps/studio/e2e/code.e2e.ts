import { expect, type Locator, type Page, test } from "@playwright/test";
import { openNewBot, stored } from "./helpers";

/**
 * Task 2.9 acceptance: the Run code drawer's autocomplete shows `workflow.email` with its type,
 * from typings generated from the bot. Also: the code is saved to the card when the drawer
 * closes, `Esc` closes it and returns focus, and `⌘Enter` says running arrives with the emulator.
 */

const inspector = (page: Page): Locator => page.getByRole("complementary", { name: /^Inspector: / });
const drawer = (page: Page) => page.getByRole("region", { name: /^Code of Run code in / });

async function openCard(page: Page, title: string) {
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  await inspector(page)
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .click();
  await expect(inspector(page)).toHaveAccessibleName(`Inspector: ${title}`);
}

async function addCard(page: Page, name: string) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("c");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("autocomplete shows workflow.email with its type, and the code is saved", async ({ page }) => {
  test.setTimeout(180_000);
  const { ws, bot } = await openNewBot(page, "code");

  // A workflow variable `email`: an Ask card stores the answer into it (string).
  await page.locator(".react-flow__pane").click();
  await page.keyboard.press("n");
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  await addCard(page, "Ask");
  await openCard(page, "Ask");
  await inspector(page).getByLabel("Save the answer to").click();
  await page.getByRole("combobox", { name: "Search variables" }).fill("email");
  await page.keyboard.press("Enter");
  await expect(inspector(page).getByLabel("Save the answer to")).toContainText("workflow.email");

  // Run code: the inspector shows the empty card and opens the drawer.
  await addCard(page, "Run code");
  await openCard(page, "Run code");
  await expect(inspector(page)).toContainText("No code yet.");
  const edit = inspector(page).getByRole("button", { name: "Edit code" });
  await edit.click();
  await expect(drawer(page)).toBeVisible();
  const editor = drawer(page).locator("[data-code-editor] .monaco-editor");
  await expect(editor).toBeVisible({ timeout: 30_000 });

  // Autocomplete after `workflow.em`: the email row, with its type inline.
  await expect(editor.getByRole("textbox", { name: /^Code of Run code in / })).toBeFocused();
  await page.keyboard.type("const to = workflow.em");
  const suggest = page.locator(".suggest-widget.visible");
  await expect(suggest).toBeVisible();
  const row = suggest.locator(".monaco-list-row.focused");
  await expect(row).toContainText("email");
  await expect(row).toContainText("string");
  await page.keyboard.press("Enter");
  await page.keyboard.type(";");

  // ⌘Enter does not insert a line; it says running arrives with the emulator.
  // Monaco reads the platform from the user agent, which the "Desktop Chrome" preset sets to
  // Windows, while Playwright's ControlOrMeta follows the host. Press what the editor expects.
  const mac = await page.evaluate(() => /Mac/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+Enter" : "Control+Enter");
  await expect(drawer(page).getByRole("status")).toHaveText(
    "Running code arrives with the emulator. Your code is saved.",
  );
  // Still one line: the shortcut was taken, not typed. (The saved text is checked below.)
  await expect(editor.locator(".view-line")).toHaveCount(1);

  // Esc closes the drawer, gives focus back to "Edit code", and the code is on the card.
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(edit).toBeFocused();
  await expect(inspector(page).locator("[data-code-preview]")).toHaveText("const to = workflow.email;");
  const wf = await stored(page, ws, bot);
  const card = wf.nodes.flatMap((n) => n.cards ?? []).find((c) => c.type === "code") as
    | { type: "code"; source: string }
    | undefined;
  expect(card?.source).toBe("const to = workflow.email;");

  // The handle resizes by keyboard: up grows, within the limits.
  await edit.click();
  const handle = drawer(page).getByRole("separator", { name: "Resize the code editor" });
  await expect(handle).toHaveAttribute("aria-valuenow", "60");
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "65");
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "90");
});
