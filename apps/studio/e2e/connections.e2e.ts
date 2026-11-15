import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { verifySignature } from "@wakeel/bridge";
import { createDatabase, sql } from "@wakeel/db";
import { openNewBot } from "./helpers";

/**
 * Task 5.5 acceptance: create a connection, send a test event to a local receiver, replay a dead
 * event. Runs against the real api and turn worker. Webhooks reach the local receiver through the
 * test-only egress stand-in (ADR-030 §5): the api and the worker run with EGRESS_URL pointing at it.
 */
const ORIGIN = "http://127.0.0.1:5173";
const RECEIVER = "http://127.0.0.1:4497";
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../../../.env", import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("base64url").replace(/[-_]/g, "x").slice(0, 10)}`;

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
}
const received = async (): Promise<Received[]> => (await fetch(`${RECEIVER}/__received`)).json();
const answerWith = (status: number) =>
  fetch(`${RECEIVER}/__answer`, { method: "POST", body: JSON.stringify({ status }) });

/** Start → one node that says a fixed line, written through the api (the seeded bot has an Autonomous node). */
async function sayingBot(page: Page, ws: string, bot: string) {
  const session = await (await page.request.get("/v1/auth/session")).json();
  const headers = { origin: ORIGIN, "x-csrf-token": session.csrfToken as string };
  const detail = await (await page.request.get(`/v1/workspaces/${ws}/bots/${bot}`)).json();
  const mainId = detail.docs.find((d: { kind: string }) => d.kind === "workflow").docId as string;
  const url = `/v1/workspaces/${ws}/bots/${bot}/docs/workflow/${mainId}`;
  const current = await (await page.request.get(url)).json();
  const start = current.doc.nodes.find((n: { type: string }) => n.type === "start").id as string;
  const reply = id("node");
  const doc = {
    ...current.doc,
    nodes: [
      { id: start, type: "start", name: "Start" },
      {
        id: reply,
        type: "standard",
        name: "Reply",
        cards: [{ id: id("card"), type: "say", message: { type: "text", text: "طلبك اتشحن امبارح" } }],
      },
    ],
    edges: [{ id: id("edge"), from: { nodeId: start, port: "next" }, to: { nodeId: reply } }],
    layout: {},
  };
  const res = await page.request.put(url, { data: { doc }, headers: { ...headers, "if-match": `"${current.rev}"` } });
  expect(res.ok(), await res.text()).toBe(true);
}

test("create a connection, send a test event to a local receiver, and replay a dead event", async ({ page }) => {
  test.setTimeout(120_000);
  const { ws, bot } = await openNewBot(page, "connections");
  await sayingBot(page, ws, bot);
  await answerWith(200);

  // Create, from the rail.
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByText("No connections yet")).toBeVisible();
  await page.getByRole("button", { name: "New connection" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Chatwoot");
  await dialog.getByLabel("Webhook URL").fill("https://receiver.e2e.test/hook");
  await dialog.getByRole("button", { name: "Create connection" }).click();
  const secret = await page.getByTestId("shown-once").inputValue();
  expect(secret).toMatch(/^whsec_/);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("link", { name: "Chatwoot" }).click();
  await expect(page.getByText(`whsec_…${secret.slice(-4)}`)).toBeVisible();

  // Test event: signed, received, verified with the secret shown once.
  await page.getByRole("link", { name: "Test" }).click();
  const before = (await received()).length;
  await page.getByRole("button", { name: "Send test event" }).click();
  await expect(page.getByText("The webhook accepted the test event")).toBeVisible();
  const testEvents = (await received()).slice(before);
  expect(testEvents).toHaveLength(1);
  const event = JSON.parse(testEvents[0]?.body ?? "{}");
  expect(event).toMatchObject({ type: "turn.completed", ephemeral: true });
  expect(
    verifySignature({
      header: testEvents[0]?.headers["x-wakeel-signature"] ?? "",
      rawBody: testEvents[0]?.body ?? "",
      secrets: [secret],
      nowSeconds: Date.now() / 1000,
    }),
  ).toEqual({ ok: true });

  // A message while the receiver is down: its events fail, and are then made dead (ADR-030 §5).
  await answerWith(500);
  await page.getByLabel("Message", { exact: true }).fill("فين طلبي؟");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("list", { name: "Replies" })).toContainText("طلبك اتشحن امبارح");
  await expect
    .poll(async () => (await received()).filter((r) => JSON.parse(r.body).type === "message.created").length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  const db = createDatabase({ url: env["DATABASE_URL"] ?? "" });
  try {
    await db.withWorkspace(ws, (tx) =>
      tx.execute(sql`update webhook_deliveries set status = 'dead', attempted_at = now(),
        error = '{"code":"webhook_rejected"}'::jsonb, response_status = 500 where status in ('pending', 'failed')`),
    );
  } finally {
    await db.close();
  }

  // Replay the dead message from the Deliveries tab once the receiver is back.
  await answerWith(200);
  await page.getByRole("link", { name: "Deliveries" }).click();
  await page.getByRole("tab", { name: "Failed" }).click();
  const row = page.getByRole("row").filter({ hasText: "message.created" });
  await expect(row.getByText("Failed")).toBeVisible();
  const replayFrom = (await received()).length;
  await row.getByRole("button", { name: "Send again" }).click();
  await expect
    .poll(
      async () =>
        (await received())
          .slice(replayFrom)
          .filter(
            (r) => JSON.parse(r.body).type === "message.created" && r.headers["x-wakeel-delivery-attempt"] !== "1",
          ).length,
      { timeout: 20_000 },
    )
    .toBe(1);
  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByRole("row").filter({ hasText: "message.created" }).getByText("Delivered")).toBeVisible({
    timeout: 10_000,
  });
});
