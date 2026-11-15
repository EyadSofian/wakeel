import { expect, type Locator, type Page, test } from "@playwright/test";
import { openNewBot, stored } from "./helpers";

/**
 * Task 6.8 acceptance: build the node of design system §5.2 in the inspector (instructions, a tool,
 * a variable it writes, two exits, the advanced settings) and check what autosave stored. Esc goes
 * back from a tool or exit to the node. Knowledge, table and workflow tools wait for their phases.
 */

const inspector = (page: Page): Locator => page.getByRole("complementary", { name: /^Inspector: / });

async function edit(field: Locator, text: string) {
  await field.fill(text);
  await field.blur();
}

interface StoredAgent {
  type: string;
  instructions: string;
  tools: { name: string; type: string; description: string; input: unknown; source: string; sideEffects: boolean }[];
  variableAccess: { variableId: string; mode: string }[];
  exits: { name: string; description: string; schema?: unknown }[];
  maxIterations: number;
  allowHandoff: boolean;
}

async function agent(page: Page, ws: string, bot: string) {
  const wf = await stored(page, ws, bot);
  return {
    // A new bot already has an "Assistant" agent; the one built here keeps its default name.
    node: wf.nodes.find((n) => n.type === "autonomous" && n.name === "Autonomous node") as unknown as StoredAgent,
    variables: wf.variables,
  };
}

test("builds the §5.2 node: instructions, a code tool, a variable, two exits and advanced settings", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { ws, bot } = await openNewBot(page, "autonomous");

  // An Ask card first, which creates the workflow variable `answer` for the agent to write.
  await page.keyboard.press("n");
  await page.keyboard.type("standard");
  await page.keyboard.press("Enter");
  await page.keyboard.press("c");
  await page.keyboard.type("Ask");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.keyboard.press("n");
  await page.keyboard.type("autonomous");
  await page.keyboard.press("Enter");
  await expect(inspector(page)).toHaveAccessibleName("Inspector: Autonomous node");
  const panel = inspector(page);

  await edit(panel.getByLabel("Instructions", { exact: true }), "ساعد الطلاب يحجزوا درس. Ask for their email first.");

  // A code tool, renamed, with an input schema and code; then Esc back to the node.
  await panel.getByRole("button", { name: "Add a code tool" }).click();
  await edit(panel.getByLabel("Function name"), "bookLesson");
  await edit(panel.getByLabel("When to use it"), "Books a lesson once the email is known.");
  await edit(
    panel.getByLabel("Input", { exact: true }),
    JSON.stringify({ type: "object", properties: { email: { type: "string" } }, required: ["email"] }),
  );
  await edit(panel.getByLabel("Code", { exact: true }), "return { booked: true, email: input.email };");
  // A name that is not an identifier shows the fix and is not saved.
  await panel.getByLabel("Function name").fill("book lesson");
  await expect(panel.getByRole("alert")).toContainText("Use letters, digits and underscores");
  await panel.getByLabel("Function name").fill("bookLesson");
  await panel.getByLabel("Function name").press("Escape");
  await expect(panel.getByRole("button", { name: /^bookLesson/ })).toBeVisible();

  // The variable it writes.
  await panel.getByLabel("Give access to").selectOption({ label: "workflow.answer" });
  await panel.getByLabel("Access to workflow.answer").selectOption("write");

  // Two exits; the second with a data schema.
  await panel.getByRole("button", { name: "Add an exit" }).click();
  await edit(panel.getByLabel("Name", { exact: true }), "resolved");
  await edit(panel.getByLabel("When to leave"), "The lesson is booked.");
  await panel.getByRole("button", { name: "Back to the node" }).click();
  await panel.getByRole("button", { name: "Add an exit" }).click();
  await edit(panel.getByLabel("Name", { exact: true }), "needs_refund");
  await edit(panel.getByLabel("When to leave"), "The student asks for a refund.");
  await edit(
    panel.getByLabel("Data", { exact: true }),
    JSON.stringify({ type: "object", properties: { reason: { type: "string" } } }),
  );
  await panel.getByLabel("When to leave").press("Escape");

  // Advanced.
  await edit(panel.getByLabel("Steps per turn"), "8");
  await panel.getByRole("switch", { name: /Can hand off to a person/ }).click();

  const { node, variables } = await agent(page, ws, bot);
  expect(node.instructions).toBe("ساعد الطلاب يحجزوا درس. Ask for their email first.");
  expect(node.tools).toEqual([
    expect.objectContaining({
      name: "bookLesson",
      type: "code",
      description: "Books a lesson once the email is known.",
      input: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
      source: "return { booked: true, email: input.email };",
      sideEffects: true,
    }),
  ]);
  const answer = variables.find((v) => v.name === "answer");
  expect(node.variableAccess).toEqual([{ variableId: answer?.id, mode: "write" }]);
  expect(node.exits.map((e) => e.name)).toEqual(["resolved", "needs_refund"]);
  expect(node.exits[1]?.schema).toEqual({ type: "object", properties: { reason: { type: "string" } } });
  expect(node.maxIterations).toBe(8);
  expect(node.allowHandoff).toBe(true);

  // The exits are outputs on the canvas.
  const onCanvas = page.locator(".react-flow__node").filter({ hasText: /^Autonomous node/ });
  await expect(onCanvas).toContainText("resolved");
  await expect(onCanvas).toContainText("needs_refund");
});
