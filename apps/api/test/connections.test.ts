import { randomBytes } from "node:crypto";
import { verifySignature } from "@wakeel/bridge";
import { type BridgeEvent, StudioConnection, TurnResult } from "@wakeel/contracts";
import { superuserQuery } from "@wakeel/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type Browser, type Stack, signUp, startStack } from "./stack";

/**
 * Task 5.5 (ADR-030): the Studio's routes behind the Connections screens. The builder's session,
 * `connection.read` / `connection.manage`, audit entries, secrets shown once, the shared webhook
 * tools, and the Test tab as emulator traffic.
 */
let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ bridge: true });
});

afterAll(async () => {
  await stack?.stop();
});

beforeEach(() => {
  stack.autoWork.on = false;
  stack.jobs.length = 0;
  stack.webhook.sent.length = 0;
  stack.webhook.jobs.length = 0;
  stack.webhook.answer = { kind: "response", status: 200 };
});

const slug = () => `c-${randomBytes(4).toString("hex")}`;
const su = (q: string, params: unknown[] = []) => superuserQuery(stack.pg.urls, q, params);

async function botOf(owner: Browser) {
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Connections", slug: slug() })).json().id as string;
  const bot = (await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name: "النور", slug: slug() })).json()
    .id as string;
  return { ws, bot, base: `/v1/workspaces/${ws}/bots/${bot}/connections` };
}

async function created(owner: Browser, base: string, body: Record<string, unknown> = {}) {
  const res = await owner.send("POST", base, {
    name: "Chatwoot",
    target: "production",
    webhookUrl: "https://receiver.example.test/hook",
    subscribedEvents: ["message.created", "turn.completed"],
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as StudioConnection & { signingSecret: string };
}

const actions = async (ws: string) =>
  (
    (await su("select action from audit_log where workspace_id = $1 order by at, id", [ws])) as { action: string }[]
  ).map((r) => r.action);

describe("connections", () => {
  test("create shows the signing secret once; list and get show only its last four characters", async () => {
    const owner = await signUp(stack.app);
    const { ws, base } = await botOf(owner);
    const conn = await created(owner, base);
    expect(conn.signingSecret).toMatch(/^whsec_/);
    expect(conn).toMatchObject({
      name: "Chatwoot",
      target: "production",
      status: "active",
      webhookUrl: "https://receiver.example.test/hook",
      subscribedEvents: ["message.created", "turn.completed"],
      signingSecrets: [{ last4: conn.signingSecret.slice(-4) }],
      consecutiveDead: 0,
      lastDelivery: null,
    });
    const list = await owner.get(base);
    expect(list.json().data.map((c: StudioConnection) => c.id)).toEqual([conn.id]);
    expect(list.body).not.toContain(conn.signingSecret);
    const one = await owner.get(`${base}/${conn.id}`);
    StudioConnection.parse(one.json());
    expect(one.body).not.toContain(conn.signingSecret);
    expect(await actions(ws)).toContain("connection.created");
  });

  test("the emulator's own connections are not listed", async () => {
    const owner = await signUp(stack.app);
    const { ws, bot, base } = await botOf(owner);
    stack.autoWork.on = true;
    await owner.send("POST", `/v1/workspaces/${ws}/bots/${bot}/emulator/conversations/emu-1/messages?wait=5`, {
      userId: "builder",
      message: { type: "text", text: "أهلاً" },
    });
    expect((await owner.get(base)).json().data).toEqual([]);
  });

  test.each([
    ["http://receiver.example.test/hook", "Use an https address"],
    ["https://127.0.0.1/hook", "Use a public address, not a private or local one"],
    ["https://localhost:3000/hook", "Use a public address, not localhost"],
  ])("refuses the webhook URL %s with webhook_url_blocked", async (webhookUrl, message) => {
    const owner = await signUp(stack.app);
    const { base } = await botOf(owner);
    const res = await owner.send("POST", base, { name: "x", target: "draft", webhookUrl });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: "webhook_url_blocked",
      errors: [{ path: "webhookUrl", code: "blocked", message }],
    });
  });

  test("update: rename, remove the webhook, pause, and turn a disabled connection back on", async () => {
    const owner = await signUp(stack.app);
    const { ws, base } = await botOf(owner);
    const conn = await created(owner, base);
    const renamed = await owner.send("PATCH", `${base}/${conn.id}`, { name: "Chatwoot prod", webhookUrl: null });
    expect(renamed.json()).toMatchObject({ name: "Chatwoot prod", webhookUrl: null });
    expect((await owner.send("PATCH", `${base}/${conn.id}`, { status: "paused" })).json().status).toBe("paused");

    await su("update bridge_connections set status = 'disabled', consecutive_dead = 20 where id = $1", [conn.id]);
    const back = await owner.send("PATCH", `${base}/${conn.id}`, { status: "active" });
    expect(back.json()).toMatchObject({ status: "active", consecutiveDead: 0 });
    expect((await owner.send("PATCH", `${base}/${conn.id}`, {})).statusCode).toBe(400);
    expect((await actions(ws)).filter((a) => a === "connection.updated")).toHaveLength(3);
  });

  test("keys: created once, listed by prefix, usable on the Bridge API, revoked; another connection's key is not_found", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botOf(owner);
    const a = await created(owner, base);
    const b = await created(owner, base, { name: "WhatsApp" });
    const made = await owner.send("POST", `${base}/${a.id}/keys`, { name: "Production bridge" });
    expect(made.statusCode).toBe(201);
    const key = made.json().key as string;
    expect(key).toMatch(/^wk_bridge_/);
    const listed = (await owner.get(`${base}/${a.id}/keys`)).json().data;
    expect(listed).toMatchObject([{ name: "Production bridge", revokedAt: null }]);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect((await owner.get(`${base}/${b.id}/keys`)).json().data).toEqual([]);

    const bridge = await stack.app.inject({
      method: "GET",
      url: "/v1/bridge/connection",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(bridge.json().id).toBe(a.id);

    expect((await owner.send("DELETE", `${base}/${b.id}/keys/${made.json().id}`)).statusCode).toBe(404);
    expect((await owner.send("DELETE", `${base}/${a.id}/keys/${made.json().id}`)).statusCode).toBe(204);
    const after = await stack.app.inject({
      method: "GET",
      url: "/v1/bridge/connection",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(after.statusCode).toBe(401);
  });

  test("rotation keeps the previous secret until it is finished; both sign meanwhile", async () => {
    const owner = await signUp(stack.app);
    const { ws, base } = await botOf(owner);
    const conn = await created(owner, base);
    const rotated = await owner.send("POST", `${base}/${conn.id}/signing-secrets/rotate`);
    const next = rotated.json().signingSecret as string;
    expect(next).not.toBe(conn.signingSecret);
    expect(rotated.json().signingSecrets).toEqual([{ last4: next.slice(-4) }, { last4: conn.signingSecret.slice(-4) }]);

    await owner.send("POST", `${base}/${conn.id}/test`);
    const sent = stack.webhook.sent[0];
    for (const secret of [next, conn.signingSecret]) {
      expect(
        verifySignature({
          header: sent?.headers["X-Wakeel-Signature"] as string,
          rawBody: sent?.body as string,
          secrets: [secret],
          nowSeconds: Date.now() / 1000,
        }),
      ).toEqual({ ok: true });
    }

    const finished = await owner.send("POST", `${base}/${conn.id}/signing-secrets/finish-rotation`);
    expect(finished.json().signingSecrets).toEqual([{ last4: next.slice(-4) }]);
    expect((await actions(ws)).filter((a) => a === "connection.secret_rotated")).toHaveLength(2);
  });

  test("the test event reports the receiver's answer", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botOf(owner);
    const conn = await created(owner, base);
    expect((await owner.send("POST", `${base}/${conn.id}/test`)).json()).toMatchObject({
      delivered: true,
      statusCode: 200,
    });
    stack.webhook.answer = { kind: "refused", code: "fetch_blocked" };
    expect((await owner.send("POST", `${base}/${conn.id}/test`)).json()).toMatchObject({
      delivered: false,
      error: "fetch_blocked",
    });
    const event = JSON.parse(stack.webhook.sent[0]?.body as string) as BridgeEvent;
    expect(event).toMatchObject({ type: "turn.completed", ephemeral: true, connectionId: conn.id });
  });

  test("the Test tab's message runs as emulator traffic and its deliveries can be listed and replayed", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botOf(owner);
    const conn = await created(owner, base);
    stack.autoWork.on = true;
    const res = await owner.send("POST", `${base}/${conn.id}/test/messages?wait=5`, { text: "عايز أعرف حالة طلبي" });
    expect(res.statusCode, res.body).toBe(200);
    expect(TurnResult.parse(res.json()).messages).toHaveLength(1);
    const [conv] = (await su("select id, mode, external_id from conversations where connection_id = $1", [
      conn.id,
    ])) as {
      id: string;
      mode: string;
      external_id: string;
    }[];
    expect(conv).toMatchObject({ mode: "emulator", external_id: expect.stringMatching(/^studio-test-/) });

    const deliveries = (await owner.get(`${base}/${conn.id}/deliveries`)).json().data;
    expect(deliveries.map((d: { eventType: string }) => d.eventType)).toEqual(["turn.completed", "message.created"]);
    await su(
      `update webhook_deliveries set status = 'dead', attempted_at = now(), error = '{"code":"webhook_rejected"}'::jsonb
        where conversation_id = $1 and status = 'pending'`,
      [conv?.id],
    );
    const dead = (await owner.get(`${base}/${conn.id}/deliveries?status=dead`)).json().data[0];
    expect((await owner.send("POST", `${base}/${conn.id}/deliveries/${dead.eventId}/replay`)).statusCode).toBe(202);
    expect(stack.webhook.jobs).toEqual([conv?.id]);
    const again = await owner.send("POST", `${base}/${conn.id}/deliveries/${dead.eventId}/replay`);
    expect(again.json().code).toBe("delivery_not_replayable");
    // The list shows the last delivery once an attempt has finished.
    const listed = (await owner.get(base)).json().data[0] as StudioConnection;
    expect(listed.lastDelivery?.status).toBe("dead");
  });
});

describe("two workspaces", () => {
  test("a member of another workspace cannot read or change these connections", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botOf(owner);
    const conn = await created(owner, base);
    const stranger = await signUp(stack.app);
    await botOf(stranger);
    // Another workspace is not_found, so its existence does not leak (task 1.3).
    expect((await stranger.get(base)).statusCode).toBe(404);
    expect((await stranger.send("PATCH", `${base}/${conn.id}`, { name: "x" })).statusCode).toBe(404);
    // A connection id under another bot of one's own workspace is not_found.
    const mine = await botOf(owner);
    expect((await owner.get(`${mine.base}/${conn.id}`)).statusCode).toBe(404);
  });
});
