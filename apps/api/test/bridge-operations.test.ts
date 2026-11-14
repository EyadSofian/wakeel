import { randomBytes } from "node:crypto";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { generateKey } from "@wakeel/auth";
import { type SendResult, verifySignature, type WebhookRequest } from "@wakeel/bridge";
import { type BridgeEvent, newId } from "@wakeel/contracts";
import {
  createBot,
  createBridgeConnection,
  createDatabase,
  createWorkspace,
  type Database,
  insertApiKey,
  setSigningSecrets,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import { createLogger } from "@wakeel/telemetry";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type App, buildApp } from "../src/app";
import { TEST_CONVERSATION, TEST_USER } from "../src/routes/bridge/operations";
import { Signals } from "../src/routes/bridge/signals";
import { expectConforms, operation, spec } from "./contract";
import { REDIS_IMAGE } from "./stack";
import { standInWorker } from "./stand-in-worker";

/**
 * Task 5.3 (ADR-029): listConversationEvents, endConversation, submitToolResult, listDeliveries,
 * replayDelivery, getConnection and testWebhook. Acceptance (build plan): contract tests for every
 * operation in the OpenAPI file now pass. releaseHandoff is task 5.4; receiveBridgeEvent is the
 * receiver's side.
 */

let pg: StartedTestDatabase;
let redisContainer: StartedRedisContainer;
let db: Database;
let app: App;
let publisher: Redis;
let subscriber: Redis;
const keyring = { current: { version: 1, key: new Uint8Array(randomBytes(32)) } };
const SECRET = "whsec_test_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const turns: string[] = [];
const webhookJobs: string[] = [];
const sent: WebhookRequest[] = [];
let answer: SendResult = { kind: "response", status: 200 };
let work: (conversationId: string) => Promise<void>;

const BUILT_IN_4_5 = ["sendMessage", "sendEvent", "updateUser", "getConversation", "listMessages", "getTurn"];
const BUILT = [
  "listConversationEvents",
  "endConversation",
  "submitToolResult",
  "listDeliveries",
  "replayDelivery",
  "getConnection",
  "testWebhook",
] as const;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([startTestDatabase(), new RedisContainer(REDIS_IMAGE).start()]);
  db = createDatabase({ url: pg.urls.rw, maxConnections: 8 });
  publisher = new Redis(redisContainer.getConnectionUrl());
  subscriber = new Redis(redisContainer.getConnectionUrl());
  work = standInWorker(db, publisher);
  app = buildApp({
    role: "bridge",
    logger: createLogger({ service: "api", level: (process.env["TEST_LOG"] as "error" | undefined) ?? "silent" }),
    bridge: {
      db,
      signals: new Signals(subscriber),
      // Every enqueued turn runs at once, so endConversation's wait ends by the turn-done signal.
      enqueueTurn: async (conversationId) => {
        turns.push(conversationId);
        setImmediate(() => void work(conversationId));
      },
      sleep: () => new Promise<void>(() => {}),
      enqueueWebhook: async (conversationId) => {
        webhookJobs.push(conversationId);
      },
      sender: {
        send: async (request) => {
          sent.push(request);
          return answer;
        },
      },
      keyring,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await Promise.allSettled([db?.close(), publisher?.quit(), subscriber?.quit()]);
  await Promise.allSettled([pg?.stop(), redisContainer?.stop()]);
});

beforeEach(() => {
  turns.length = 0;
  webhookJobs.length = 0;
  sent.length = 0;
  answer = { kind: "response", status: 200 };
});

const su = (q: string, params: unknown[] = []) => superuserQuery(pg.urls, q, params);

/** A workspace and bot with two connections; A has a webhook and a signing secret. */
async function tenant() {
  const userId = newId("usr");
  await su("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Bridge ops",
    slug: `o-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  const connection = async (name: string, webhookUrl?: string) => {
    const conn = await db.withWorkspace(ws, (tx) =>
      createBridgeConnection(tx, { botId: bot.id, name, target: "production", ...(webhookUrl ? { webhookUrl } : {}) }),
    );
    const { key, prefix, secretHash } = generateKey("bridge");
    await db.withWorkspace(ws, (tx) =>
      insertApiKey(tx, { kind: "bridge", name, prefix, secretHash, scopes: [], botId: bot.id, connectionId: conn.id }),
    );
    return { id: conn.id, key };
  };
  const a = await connection("Chatwoot", "https://receiver.example.test/hook");
  const b = await connection("WhatsApp");
  await su(
    "update bridge_connections set subscribed_events = array['message.created', 'turn.completed'] where id = $1",
    [a.id],
  );
  await db.withWorkspace(ws, (tx) =>
    setSigningSecrets(tx, keyring, { workspaceId: ws, connectionId: a.id, secrets: [SECRET] }),
  );
  return { ws, botId: bot.id, a, b };
}

let t: Awaited<ReturnType<typeof tenant>>;
beforeAll(async () => {
  t = await tenant();
});

const ext = () => `chat-${randomBytes(4).toString("hex")}`;

function call(key: string, method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url: `/v1/bridge${url}`,
    headers: { authorization: `Bearer ${key}`, ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

/** Sends a message and waits for the stand-in turn, so the conversation and its events exist. */
async function converse(key: string, conv = ext()) {
  const res = await call(key, "POST", `/conversations/${conv}/messages?wait=5`, {
    userId: "cw_contact_812",
    message: { type: "text", text: "عايز أعرف حالة الطلب" },
  });
  expect(res.statusCode).toBe(200);
  return conv;
}

const conversationId = async (connectionId: string, externalId: string) =>
  (
    (await su("select id from conversations where connection_id = $1 and external_id = $2", [
      connectionId,
      externalId,
    ])) as { id: string }[]
  )[0]?.id as string;

/** Marks every pending delivery of a conversation as dead (as if its retries ran out). */
const killDeliveries = (convId: string) =>
  su(
    `update webhook_deliveries set status = 'dead', attempted_at = now(), response_status = 500,
       error = '{"code":"webhook_rejected"}'::jsonb where conversation_id = $1 and status = 'pending'`,
    [convId],
  );

/** Puts a conversation in waiting_external for tool call `call-1`, as an Autonomous Node would. */
async function waitForTool(convId: string) {
  const state = {
    v: 1,
    status: "waiting_external",
    stack: [],
    conversationVars: {},
    autonomy: {},
    started: true,
    wait: {
      kind: "tool",
      nodeId: "node_AAAAAAAAAA",
      toolId: "tool_AAAAAAAAAA",
      toolCallId: "call-1",
      since: new Date().toISOString(),
    },
  };
  await su("update conversations set state = $2::jsonb, status = 'waiting_external' where id = $1", [
    convId,
    JSON.stringify(state),
  ]);
}

describe("contract: every operation in the OpenAPI file", () => {
  test("is served, except releaseHandoff (task 5.4) and the receiver's webhook", () => {
    const all = Object.values(spec.paths).flatMap((item) =>
      Object.values(item)
        .map((op) => (typeof op === "object" && op && "operationId" in op ? op.operationId : undefined))
        .filter((id): id is string => typeof id === "string"),
    );
    expect([...all].sort()).toEqual([...BUILT_IN_4_5, ...BUILT, "releaseHandoff"].sort());
    const served: Record<(typeof BUILT)[number], string> = {
      listConversationEvents: "get /conversations/{externalConversationId}/events",
      endConversation: "post /conversations/{externalConversationId}/end",
      submitToolResult: "post /conversations/{externalConversationId}/tool-results",
      listDeliveries: "get /deliveries",
      replayDelivery: "post /deliveries/{eventId}/replay",
      getConnection: "get /connection",
      testWebhook: "post /connection/test",
    };
    for (const id of BUILT) {
      const { method, path } = operation(id);
      expect(`${method} ${path}`).toBe(served[id]);
    }
  });

  test.each(BUILT)("%s: success and failure responses conform", async (operationId) => {
    const responses: Awaited<ReturnType<App["inject"]>>[] = [];
    switch (operationId) {
      case "listConversationEvents": {
        const conv = await converse(t.a.key);
        responses.push(await call(t.a.key, "GET", `/conversations/${conv}/events?after=0`));
        responses.push(await call(t.a.key, "GET", `/conversations/${ext()}/events`));
        break;
      }
      case "endConversation": {
        const conv = await converse(t.a.key);
        responses.push(await call(t.a.key, "POST", `/conversations/${conv}/end`));
        responses.push(await call(t.a.key, "POST", `/conversations/${ext()}/end`));
        break;
      }
      case "submitToolResult": {
        const conv = await converse(t.a.key);
        responses.push(await call(t.a.key, "POST", `/conversations/${conv}/tool-results`, { toolCallId: "call-1" }));
        await waitForTool(await conversationId(t.a.id, conv));
        responses.push(
          await call(t.a.key, "POST", `/conversations/${conv}/tool-results`, {
            toolCallId: "call-1",
            result: { ok: 1 },
          }),
        );
        responses.push(await call(t.a.key, "POST", `/conversations/${ext()}/tool-results`, { toolCallId: "call-1" }));
        break;
      }
      case "listDeliveries":
        await converse(t.a.key);
        responses.push(await call(t.a.key, "GET", "/deliveries?limit=2"));
        responses.push(await call("wk_bridge_nope_nope", "GET", "/deliveries"));
        break;
      case "replayDelivery": {
        const conv = await converse(t.a.key);
        await killDeliveries(await conversationId(t.a.id, conv));
        const dead = (await call(t.a.key, "GET", "/deliveries?status=dead&limit=1")).json().data[0];
        responses.push(await call(t.a.key, "POST", `/deliveries/${dead.eventId}/replay`));
        responses.push(await call(t.a.key, "POST", `/deliveries/${dead.eventId}/replay`));
        responses.push(await call(t.a.key, "POST", `/deliveries/evt_${"0".repeat(26)}/replay`));
        break;
      }
      case "getConnection":
        responses.push(await call(t.a.key, "GET", "/connection"));
        responses.push(await call("wk_bridge_nope_nope", "GET", "/connection"));
        break;
      case "testWebhook":
        responses.push(await call(t.a.key, "POST", "/connection/test"));
        answer = { kind: "response", status: 503 };
        responses.push(await call(t.a.key, "POST", "/connection/test"));
        responses.push(await call("wk_bridge_nope_nope", "POST", "/connection/test"));
        break;
    }
    expect(responses.length).toBeGreaterThanOrEqual(2);
    for (const res of responses) expectConforms(operationId, res);
  });
});

describe("listConversationEvents", () => {
  test("returns ordered events after a seq as Bridge events, never typing, and only for the key's connection", async () => {
    const conv = await converse(t.a.key);
    await converse(t.a.key, conv);
    const all = (await call(t.a.key, "GET", `/conversations/${conv}/events`)).json().data as BridgeEvent[];
    expect(all.map((e) => [e.seq, e.type])).toEqual([
      [1, "message.created"],
      [2, "turn.completed"],
      [3, "message.created"],
      [4, "turn.completed"],
    ]);
    expect(all[0]).toMatchObject({ connectionId: t.a.id, conversation: { externalId: conv }, ephemeral: false });
    const after = (await call(t.a.key, "GET", `/conversations/${conv}/events?after=2&limit=1`)).json().data;
    expect(after.map((e: BridgeEvent) => e.seq)).toEqual([3]);
    expect((await call(t.b.key, "GET", `/conversations/${conv}/events`)).statusCode).toBe(404);
  });
});

describe("endConversation", () => {
  test("ends through the inbox and answers with the ended conversation; the next message starts again", async () => {
    const conv = await converse(t.a.key);
    const res = await call(t.a.key, "POST", `/conversations/${conv}/end`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ externalId: conv, status: "ended", endedReason: "manual" });
    const events = (await call(t.a.key, "GET", `/conversations/${conv}/events?after=2`)).json().data as BridgeEvent[];
    expect(events.map((e) => e.type)).toEqual(["conversation.ended", "turn.completed"]);
    expect(events[0]).toMatchObject({ data: { reason: "manual" } });
    const [inbound] = (await su(
      "select kind from inbound_events where conversation_id = $1 order by seq desc limit 1",
      [await conversationId(t.a.id, conv)],
    )) as { kind: string }[];
    expect(inbound?.kind).toBe("end");
  });

  test("a key for connection B cannot end connection A's conversation", async () => {
    const conv = await converse(t.a.key);
    expect((await call(t.b.key, "POST", `/conversations/${conv}/end`)).statusCode).toBe(404);
  });
});

describe("submitToolResult", () => {
  test("is refused unless the conversation waits for that tool call", async () => {
    const conv = await converse(t.a.key);
    const idle = await call(t.a.key, "POST", `/conversations/${conv}/tool-results`, { toolCallId: "call-1" });
    expect(idle.statusCode).toBe(409);
    expect(idle.json().code).toBe("tool_call_not_pending");
    await waitForTool(await conversationId(t.a.id, conv));
    const other = await call(t.a.key, "POST", `/conversations/${conv}/tool-results`, { toolCallId: "call-2" });
    expect(other.json().code).toBe("tool_call_not_pending");
  });

  test("stores a tool_result event, queues the turn, and replays the first answer for a repeated key", async () => {
    const conv = await converse(t.a.key);
    const convId = await conversationId(t.a.id, conv);
    await waitForTool(convId);
    turns.length = 0;
    const body = { toolCallId: "call-1", result: { orderStatus: "اتشحن" } };
    const first = await call(t.a.key, "POST", `/conversations/${conv}/tool-results`, body, {
      "idempotency-key": "k-1",
    });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ conversationId: convId, status: "queued" });
    expect(turns).toEqual([convId]);
    const [event] = (await su(
      "select kind, payload->>'toolCallId' as call, payload->'result' as result from inbound_events where conversation_id = $1 and kind = 'tool_result'",
      [convId],
    )) as { kind: string; call: string; result: unknown }[];
    expect(event).toEqual({ kind: "tool_result", call: "call-1", result: { orderStatus: "اتشحن" } });
    const again = await call(t.a.key, "POST", `/conversations/${conv}/tool-results`, body, {
      "idempotency-key": "k-1",
    });
    expect(again.json()).toEqual(first.json());
    const changed = await call(
      t.a.key,
      "POST",
      `/conversations/${conv}/tool-results`,
      { toolCallId: "call-1", result: 2 },
      { "idempotency-key": "k-1" },
    );
    expect(changed.json().code).toBe("idempotency_mismatch");
  });
});

describe("deliveries", () => {
  test("lists one item per event from its latest attempt, newest first, with a working cursor and filter", async () => {
    const conv = await converse(t.a.key);
    const convId = await conversationId(t.a.id, conv);
    const page = (await call(t.a.key, "GET", "/deliveries?limit=1")).json();
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      conversationId: convId,
      eventType: "turn.completed",
      status: "pending",
      attempt: 1,
    });
    const next = (await call(t.a.key, "GET", `/deliveries?limit=1&cursor=${page.nextCursor}`)).json();
    expect(next.data[0]).toMatchObject({ conversationId: convId, eventType: "message.created" });
    expect((await call(t.a.key, "GET", "/deliveries?cursor=bm9wZQ")).statusCode).toBe(400);
    // B has no webhook: nothing to list, and A's deliveries never show under B's key.
    expect((await call(t.b.key, "GET", "/deliveries")).json().data).toEqual([]);
  });

  test("replay re-queues a dead event once and wakes its stream; other connections cannot see it", async () => {
    const conv = await converse(t.a.key);
    const convId = await conversationId(t.a.id, conv);
    await killDeliveries(convId);
    const dead = (await call(t.a.key, "GET", "/deliveries?status=dead"))
      .json()
      .data.find(
        (d: { conversationId: string; eventType: string }) =>
          d.conversationId === convId && d.eventType === "message.created",
      );
    expect(dead).toMatchObject({ status: "dead", attempt: 1, responseStatus: 500, error: "webhook_rejected" });

    expect((await call(t.b.key, "POST", `/deliveries/${dead.eventId}/replay`)).statusCode).toBe(404);
    const replayed = await call(t.a.key, "POST", `/deliveries/${dead.eventId}/replay`);
    expect(replayed.statusCode).toBe(202);
    expect(webhookJobs).toEqual([convId]);
    const twice = await call(t.a.key, "POST", `/deliveries/${dead.eventId}/replay`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("delivery_not_replayable");
    const rows = (await su(
      "select attempt, status, replay from webhook_deliveries where conversation_id = $1 and seq = 1 order by attempt",
      [convId],
    )) as unknown[];
    expect(rows).toEqual([
      { attempt: 1, status: "dead", replay: false },
      { attempt: 2, status: "pending", replay: true },
    ]);
  });
});

describe("getConnection", () => {
  test("returns the key's connection and never its secrets", async () => {
    const res = await call(t.a.key, "GET", "/connection");
    expect(res.json()).toEqual({
      id: t.a.id,
      botId: t.botId,
      name: "Chatwoot",
      target: "production",
      status: "active",
      webhookUrl: "https://receiver.example.test/hook",
      subscribedEvents: ["message.created", "turn.completed"],
    });
    expect(res.body).not.toContain("whsec_");
    expect(res.body).not.toContain("ciphertext");
  });
});

describe("testWebhook", () => {
  test("sends a signed ephemeral turn.completed for the test conversation and reports the answer", async () => {
    const res = await call(t.a.key, "POST", "/connection/test");
    expect(res.json()).toMatchObject({ delivered: true, statusCode: 200 });
    const request = sent[0] as WebhookRequest;
    expect(request).toMatchObject({ workspaceId: t.ws, url: "https://receiver.example.test/hook" });
    const event = JSON.parse(request.body) as BridgeEvent;
    expect(event).toMatchObject({
      type: "turn.completed",
      ephemeral: true,
      connectionId: t.a.id,
      conversation: TEST_CONVERSATION,
      user: TEST_USER,
      data: { status: "completed", messageCount: 0, durationMs: 0 },
    });
    expect(event.seq).toBeUndefined();
    expect(request.headers["X-Wakeel-Event-Id"]).toBe(event.id);
    expect(
      verifySignature({
        header: request.headers["X-Wakeel-Signature"] as string,
        rawBody: request.body,
        secrets: [SECRET],
        nowSeconds: Date.now() / 1000,
      }),
    ).toEqual({ ok: true });
    // Not stored: the test leaves no delivery behind.
    expect(await su("select 1 from outbox_events where id = $1", [`out_${event.id.slice(4)}`])).toEqual([]);
  });

  test.each([
    [{ kind: "response", status: 503 } as SendResult, { delivered: false, statusCode: 503, error: "webhook_rejected" }],
    [
      { kind: "response", status: 301 } as SendResult,
      { delivered: false, statusCode: 301, error: "webhook_redirected" },
    ],
    [{ kind: "refused", code: "fetch_blocked" } as SendResult, { delivered: false, error: "fetch_blocked" }],
  ])("reports a failed attempt: %o", async (result, expected) => {
    answer = result;
    expect((await call(t.a.key, "POST", "/connection/test")).json()).toMatchObject(expected);
  });

  test("a connection with no webhook or secret sends nothing and says so", async () => {
    const res = await call(t.b.key, "POST", "/connection/test");
    expect(res.json()).toEqual({ delivered: false, durationMs: 0, error: "webhook_secret_missing" });
    expect(sent).toEqual([]);
  });
});
