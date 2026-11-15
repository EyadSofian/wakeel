import { expect, type Locator, type Page, test } from "@playwright/test";
import { openNewBot, stored } from "./helpers";

/**
 * Task 2.7 acceptance: create a variable on the Variables screen; rename it and every reference
 * follows; deleting is blocked while it is used and lists where; the VariablePicker in the
 * inspector creates a workflow variable. Checked against what autosave stored.
 */

const inspector = (page: Page): Locator => page.getByRole("complementary", { name: /^Inspector: / });

interface Manifest {
  variables: { id: string; name: string; scope: string }[];
}

async function storedManifest(page: Page, ws: string, bot: string): Promise<Manifest> {
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 5_000 });
  return (await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}/docs/manifest/manifest`)).json()).doc;
}

async function openCard(page: Page, title: string) {
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  await inspector(page)
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .click();
  await expect(inspector(page)).toHaveAccessibleName(`Inspector: ${title}`);
}

test("create, rename with references, delete blocked while used", async ({ page }) => {
  test.setTimeout(180_000);
  const { ws, bot } = await openNewBot(page, "variables");

  // Create: a conversation variable from the Variables screen.
  await page.getByRole("link", { name: "Variables" }).click();
  await expect(page.getByRole("heading", { name: "Variables", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Add conversation variable" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("order number");
  await dialog.getByRole("button", { name: "Add variable" }).click();
  await expect(dialog).toContainText("Use letters, digits and underscores");
  await dialog.getByLabel("Name").fill("orderNumber");
  await dialog.getByRole("button", { name: "Add variable" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("table", { name: "Conversation variables" })).toContainText("conversation.orderNumber");
  let manifest = await storedManifest(page, ws, bot);
  const orderVar = manifest.variables.find((v) => v.name === "orderNumber");
  expect(orderVar?.scope).toBe("conversation");

  // Use it: a message that names it, and an Ask that stores into it. The picker also creates.
  await page.getByRole("link", { name: "Workflows" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.locator(".react-flow__pane").click();
  await page.keyboard.press("n");
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  for (const name of ["Send message", "Ask"]) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("c");
    await page.keyboard.type(name);
    await page.keyboard.press("Enter");
  }

  await openCard(page, "Send message");
  const text = inspector(page).getByLabel("Text", { exact: true });
  await text.fill("رقم طلبك {{ conversation.orderNumber }}، شكراً");
  await text.blur();

  await openCard(page, "Ask");
  const saveTo = inspector(page).getByLabel("Save the answer to");
  await expect(saveTo).toContainText("workflow.answer");
  await saveTo.click();
  await page.getByRole("combobox", { name: "Search variables" }).fill("city");
  await page.keyboard.press("Enter");
  await expect(saveTo).toContainText("workflow.city");
  let wf = await stored(page, ws, bot);
  const city = wf.variables.find((v) => v.name === "city");
  expect(city, "the picker created a workflow variable").toBeDefined();

  await saveTo.click();
  await page.getByRole("combobox", { name: "Search variables" }).fill("orderN");
  await page.keyboard.press("Enter");
  await expect(saveTo).toContainText("conversation.orderNumber");

  // "Used in" counts both: the message names it, the Ask stores into it.
  await page.getByRole("link", { name: "Variables" }).click();
  const used = page.getByRole("button", { name: /^conversation\.orderNumber: 2 uses/ });
  await expect(used).toBeVisible();

  // Rename: the reference inside the Arabic message changes; the text around it does not.
  await page.getByRole("button", { name: "Edit conversation.orderNumber" }).click();
  await dialog.getByLabel("Name").fill("orderId");
  await expect(dialog).toContainText("References to conversation.orderNumber will change to conversation.orderId.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /^conversation\.orderId: 2 uses/ })).toBeVisible();
  manifest = await storedManifest(page, ws, bot);
  expect(manifest.variables.find((v) => v.id === orderVar?.id)?.name).toBe("orderId");
  wf = await stored(page, ws, bot);
  const doc = JSON.stringify(wf);
  expect(doc).toContain("رقم طلبك {{ conversation.orderId }}، شكراً");
  expect(doc).not.toContain("orderNumber");

  // Delete is blocked while used: the dialog lists the places and offers no Delete.
  await page.getByRole("button", { name: "Delete conversation.orderId" }).click();
  await expect(page.getByRole("dialog", { name: "conversation.orderId is in use" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(dialog.getByRole("listitem")).toHaveCount(2);

  // A listed place opens on the canvas with that card in the inspector.
  await dialog
    .getByRole("button", { name: /^Open / })
    .first()
    .click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(inspector(page)).toHaveAccessibleName(/^Inspector: (Send message|Ask)$/);

  // An unused variable deletes.
  await page.getByRole("link", { name: "Variables" }).click();
  await expect(page.getByText("workflow.answer")).toBeVisible();
  await page.getByRole("button", { name: "Delete workflow.answer" }).click();
  await expect(page.getByRole("dialog", { name: "Delete workflow.answer?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("workflow.answer")).toHaveCount(0);
  wf = await stored(page, ws, bot);
  expect(wf.variables.map((v) => v.name).sort()).toEqual(["city"]);
});
