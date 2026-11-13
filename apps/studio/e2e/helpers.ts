import { randomBytes } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

/** Shared by the canvas end-to-end tests: a fresh account, workspace and bot on the real api. */
export async function openNewBot(page: Page, label: string): Promise<{ ws: string; bot: string }> {
  const run = randomBytes(4).toString("hex");
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Canvas builder");
  await page.getByLabel("Email").fill(`${label}-${run}@example.test`);
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

export interface StoredWorkflow {
  nodes: { id: string; name: string; type: string; cards?: { id: string; type: string }[] }[];
  edges: { id: string; from: { nodeId: string; port: string }; to: { nodeId: string } }[];
  layout: Record<string, { x: number; y: number }>;
  variables: { id: string; name: string }[];
}

/** The Main workflow as autosave stored it, after the top bar says "Saved". */
export async function stored(page: Page, ws: string, bot: string): Promise<StoredWorkflow> {
  await expect(page.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 5_000 });
  const detail = await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}`)).json();
  const mainId = detail.docs.find((d: { kind: string }) => d.kind === "workflow").docId;
  const doc = (await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}/docs/workflow/${mainId}`)).json()).doc;
  return doc as StoredWorkflow;
}

export const node = (page: Page, name: string): Locator => page.locator(".react-flow__node").filter({ hasText: name });

export async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("element not visible");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 12, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}
