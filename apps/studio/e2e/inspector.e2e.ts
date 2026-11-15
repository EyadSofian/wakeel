import { expect, type Locator, type Page, test } from "@playwright/test";
import { SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { openNewBot, stored } from "./helpers";

/**
 * Task 2.6 acceptance: configure each card the inspector has a form for (Send message, Ask,
 * Condition, Set variable, Log, End conversation); an invalid field shows its fix sentence and is
 * not saved; the RTL fixture set goes through TemplateInput byte for byte; `{{` autocompletes a
 * variable; Esc goes back from a card to its node. Results are checked against what autosave stored.
 */
interface StoredCard {
  id: string;
  type: string;
  [key: string]: unknown;
}

/** A field of the card at `index`, for assertions; the test fails clearly if the card is missing. */
function field<T>(list: StoredCard[], index: number, key: string): T {
  const card = list[index];
  if (!card) throw new Error(`no card at ${index}`);
  return card[key] as T;
}

const inspector = (page: Page): Locator => page.getByRole("complementary", { name: /^Inspector: / });

async function cards(page: Page, ws: string, bot: string): Promise<StoredCard[]> {
  const wf = await stored(page, ws, bot);
  const node = wf.nodes.find((n) => n.type === "standard") as unknown as { cards: StoredCard[] };
  return node.cards;
}

/** Types into a field and leaves it, which commits the edit. */
async function edit(field: Locator, text: string) {
  await field.fill(text);
  await field.blur();
}

test("each card's form saves; invalid input shows the fix and is not saved", async ({ page }) => {
  test.setTimeout(180_000);
  const { ws, bot } = await openNewBot(page, "inspector");

  // A standard node, then six cards from the card menu.
  await page.keyboard.press("n");
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
  for (const name of ["Send message", "Ask", "Condition", "Set variable", "Log", "End conversation"]) {
    await page.keyboard.press("Escape"); // back to the node if a card view is open
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("c");
    await page.keyboard.type(name);
    await page.keyboard.press("Enter");
  }
  let list = await cards(page, ws, bot);
  expect(list.map((c) => c.type)).toEqual(["say", "capture", "branch", "set_variable", "log", "end"]);

  const open = async (title: string) => {
    await page.keyboard.press("Escape");
    await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
    await inspector(page)
      .getByRole("button", { name: new RegExp(`^${title}`) })
      .click();
    await expect(inspector(page)).toHaveAccessibleName(`Inspector: ${title}`);
  };

  // Send message: text, then an invalid placeholder that shows the fix and is not saved.
  await open("Send message");
  const text = inspector(page).getByLabel("Text", { exact: true });
  await edit(text, "Welcome to the store");
  await text.fill("Welcome {{user.name");
  await expect(inspector(page).getByRole("alert")).toContainText(
    "Check that every {{ has a matching }} with an expression between them.",
  );
  await text.blur();
  list = await cards(page, ws, bot);
  expect(field<{ text: string }>(list, 0, "message").text).toBe("Welcome to the store");

  // `{{` opens variable autocomplete; Enter inserts the variable.
  await text.fill("Your answer was ");
  await text.press("End");
  await text.pressSequentially("{{work");
  await expect(inspector(page).getByRole("option", { name: /workflow\.answer/ })).toBeVisible();
  await text.press("Enter");
  await expect(text).toHaveValue("Your answer was {{workflow.answer}}");
  await text.blur();

  // The preview follows the message; switching to Choices keeps the text and adds options.
  await expect(inspector(page).getByRole("figure", { name: "Message preview" })).toContainText("Your answer was");
  await inspector(page).getByLabel("Message type").selectOption("choice");
  list = await cards(page, ws, bot);
  const choice = list[0]?.["message"] as { type: string; text: string; options: { label: string }[] };
  expect(choice.type).toBe("choice");
  expect(choice.text).toBe("Your answer was {{workflow.answer}}");
  expect(choice.options.map((o) => o.label)).toEqual(["Yes", "No"]);

  // RTL fixtures go through TemplateInput unchanged, and Arabic resolves to right-to-left.
  await inspector(page).getByLabel("Message type").selectOption("text");
  const rtlText = inspector(page).getByLabel("Text", { exact: true });
  for (const fixture of SCREENSHOT_FIXTURES) {
    await edit(rtlText, fixture.text);
    list = await cards(page, ws, bot);
    expect(field<{ text: string }>(list, 0, "message").text, fixture.id).toBe(fixture.text);
  }
  await edit(rtlText, "مرحبا بك في متجر النور");
  expect(await rtlText.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");

  // Ask: answer type, a check whose invalid expression shows the fix, then a valid one.
  await open("Ask");
  await inspector(page).getByLabel("Answer type").selectOption("number");
  await inspector(page).getByRole("switch", { name: "Check the answer" }).click();
  const check = inspector(page).getByLabel("Check", { exact: true });
  // A number answer into a string variable: the validator's issue shows under the field it is about.
  await expect(inspector(page).getByRole("alert").filter({ hasText: '"answer" is a string variable' })).toBeVisible();
  await check.fill("value >");
  await expect(inspector(page).getByRole("alert").filter({ hasText: "Correct the expression" })).toContainText(
    "Correct the expression `value >`.",
  );
  await edit(check, "value > 0");
  list = await cards(page, ws, bot);
  expect(list[1]?.["kind"]).toBe("number");
  expect(field<{ expression: string }>(list, 1, "validate").expression).toBe("value > 0");

  // Condition: name and rule, and a second condition.
  await open("Condition");
  await edit(inspector(page).getByLabel("Name").first(), "Big order");
  await edit(inspector(page).getByLabel("When").first(), "workflow.answer > 10");
  await inspector(page).getByRole("button", { name: "Add condition" }).click();
  list = await cards(page, ws, bot);
  const branches = list[2]?.["branches"] as { label: string; when: string }[];
  expect(branches).toHaveLength(2);
  expect(branches[0]).toMatchObject({ label: "Big order", when: "workflow.answer > 10" });

  // Set variable: the value expression.
  await open("Set variable");
  await edit(inspector(page).getByLabel("Value"), "workflow.answer + 1");
  list = await cards(page, ws, bot);
  expect(field<{ value: string }[]>(list, 3, "assignments")[0]?.value).toBe("workflow.answer + 1");

  // Log: level and message.
  await open("Log");
  await inspector(page).getByRole("radio", { name: "Warning" }).click();
  await edit(inspector(page).getByLabel("Message", { exact: true }), "Order total checked");
  list = await cards(page, ws, bot);
  expect(list[4]).toMatchObject({ level: "warn", message: "Order total checked" });

  // End conversation: the reason.
  await open("End conversation");
  await edit(inspector(page).getByLabel("Reason"), "order_done");
  list = await cards(page, ws, bot);
  expect(list[5]?.["reason"]).toBe("order_done");

  // Esc goes back from the card to its node.
  await inspector(page).getByLabel("Reason").focus();
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Standard node");
});
