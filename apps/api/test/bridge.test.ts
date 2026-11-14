import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { generateKey } from "@wakeel/auth";
import {
  Accepted,
  BridgeConversation,
  BridgeEvent,
  BridgeUser,
  Message,
  newId,
  Problem,
  TurnResult,
} from "@wakeel/contracts";
import {
  acquireConversationLease,
  appendOutbox,
  createBot,
  createBridgeConnection,
  createDatabase,
  createWorkspace,
  type Database,
  finishTurn,
  getConversation,
  insertApiKey,
  insertBotMessages,
  nextUnprocessedEvent,
  releaseConversationLease,
  revokeApiKey,
  sql,
  startTurn,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import { createLogger } from "@wakeel/telemetry";
import { RTL_FIXTURES } from "@wakeel/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import type { z } from "zod";
import { type App, buildApp } from "../src/app";
import { Signals } from "../src/routes/bridge/signals";
import { REDIS_IMAGE } from "./stack";

/**
 * Task 4.5 🔒: the Bridge API, inbound half, on real Postgres and Redis. Acceptance (build plan):
 * contract tests generated from the OpenAPI file for every operation built so far; a duplicate
 * `Idempotency-Key` returns the original response; `wait` returns the turn's messages; a key for
 * connection A cannot touch connection B.
 *
 * Turns are run by a small stand-in worker built from the same repository calls the real worker
 * (apps/worker, task 4.4) makes: apps never import each other, and 4.4's own tests cover the worker.
 */

let pg: StartedTestDatabase;
let redisContainer: StartedRedisContainer;
let db: Database;
let app: App;
let publisher: Redis;
let subscriber: Redis;
/** Conversation ids the API enqueued, in order. */
const jobs: string[] = [];
/** When true, an enqueued conversation is processed by the stand-in worker at once. */
let autoWork = false;
let sleeps: number[] = [];

const BUILT = ["sendMessage", "sendEvent", "updateUser", "getConversation", "listMessages", "getTurn"] as const;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([startTestDatabase(), new RedisContainer(REDIS_IMAGE).start()]);
  db = createDatabase({ url: pg.urls.rw, maxConnections: 8 });
  publisher = new Redis(redisContainer.getConnectionUrl());
  subscriber = new Redis(redisContainer.getConnectionUrl());
  app = buildApp({
    role: "bridge",
    logger: createLogger({ service: "api", level: (process.env["TEST_LOG"] as "error" | undefined) ?? "silent" }),
    bridge: {
      db,
      signals: new Signals(subscriber),
      enqueueTurn: async (conversationId) => {
        jobs.push(conversationId);
        if (autoWork) setImmediate(() => void work(conversationId));
      },
      // With the stand-in worker on, only the turn-done signal may end a wait: a sleep that never
      // ends makes a lost signal fail the test. With it off, the wait times out at once.
      sleep: (ms) => {
        sleeps.push(ms);
        return autoWork ? new Promise<void>(() => {}) : Promise.resolve();
      },
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
  autoWork = false;
  jobs.length = 0;
  sleeps = [];
});

/** One turn for the oldest unprocessed event, the way apps/worker commits it: reply "رد: <text>". */
async function work(conversationId: string): Promise<void> {
  const ws = await db.lookup.conversationWorkspace(conversationId);
  if (!ws) return;
  const epoch = await db.withWorkspace(ws, (tx) => acquireConversationLease(tx, conversationId, "stand-in", 30_000));
  if (epoch === undefined) return;
  for (;;) {
    const done = await db.withWorkspace(ws, async (tx) => {
      const ev = await nextUnprocessedEvent(tx, conversationId);
      if (!ev) return undefined;
      const conv = await getConversation(tx, conversationId);
      const turn = await startTurn(tx, {
        conversationId,
        botId: conv.botId,
        versionId: null,
        epoch,
        eventIds: [ev.id],
        id: ev.payload["turnId"] as string,
      });
      const message = ev.payload["message"] as { text?: string } | undefined;
      const reply = { type: "text", text: `رد: ${message?.text ?? ev.payload["name"]}`, format: "markdown" };
      const [stored] = await insertBotMessages(tx, conversationId, [
        { id: newId("msg"), type: "text", payload: reply, turnId: turn.id },
      ]);
      if (!stored) throw new Error("no message stored");
      const at = { conversationId, connectionId: ev.connectionId, epoch };
      await appendOutbox(tx, at, [
        { type: "typing", payload: { turnId: turn.id, data: { state: "on" } }, ephemeral: true },
        {
          type: "message.created",
          payload: {
            turnId: turn.id,
            data: {
              message: {
                id: stored.id,
                conversationId,
                seq: stored.seq,
                direction: "out",
                payload: reply,
                citations: [],
                turnId: turn.id,
                createdAt: stored.createdAt.toISOString(),
              },
            },
          },
        },
        {
          type: "turn.completed",
          payload: { turnId: turn.id, data: { status: "completed", messageCount: 1, durationMs: 5 } },
        },
      ]);
      await finishTurn(tx, { turnId: turn.id, status: "completed", stepCount: 1 });
      return ev.seq;
    });
    if (done === undefined) break;
    await publisher.publish(`conversation-events:${conversationId}`, "");
    await publisher.publish(`turn-done:${conversationId}:${done}`, "{}");
  }
  await db.withWorkspace(ws, (tx) => releaseConversationLease(tx, conversationId, epoch));
}

/** A workspace with a bot and two connections, each with its own bridge key. */
async function tenant() {
  const userId = newId("usr");
  await superuserQuery(pg.urls, "insert into users (id, email, name) values ($1, $2, 'Builder')", [
    userId,
    `${userId}@example.test`,
  ]);
  const { workspace } = await createWorkspace(db, {
    name: "Bridge",
    slug: `b-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  const connection = async (name: string, target: "production" | "draft" = "production") => {
    const conn = await db.withWorkspace(ws, (tx) => createBridgeConnection(tx, { botId: bot.id, name, target }));
    const { key, prefix, secretHash } = generateKey("bridge");
    const record = await db.withWorkspace(ws, (tx) =>
      insertApiKey(tx, { kind: "bridge", name, prefix, secretHash, scopes: [], botId: bot.id, connectionId: conn.id }),
    );
    return { id: conn.id, key, keyId: record.id };
  };
  return { ws, botId: bot.id, a: await connection("Chatwoot"), b: await connection("WhatsApp") };
}

let shared: Awaited<ReturnType<typeof tenant>>;
beforeAll(async () => {
  shared = await tenant();
});

const ext = () => `chat-${randomBytes(4).toString("hex")}`;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

function call(
  key: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url: `/v1/bridge${url}`,
    headers: { ...bearer(key), ...headers },
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

const send = (key: string, conv: string, body: unknown, query = "", headers: Record<string, string> = {}) =>
  call(key, "POST", `/conversations/${conv}/messages${query}`, body, headers);

const hello = (text = "عايز أعرف حالة الطلب رقم 5678") => ({
  userId: "cw_contact_812",
  user: { name: "منى", locale: "ar-EG", attributes: { plan: "pro", odooPartnerId: 4411 } },
  message: { type: "text", text },
  externalMessageId: `cw_msg_${randomBytes(3).toString("hex")}`,
});

/* ------------------------------------------------------------------ */
/* Contract tests generated from the OpenAPI file                      */
/* ------------------------------------------------------------------ */

const spec = parse(
  readFileSync(fileURLToPath(new URL("../../../docs/04-contracts/bridge-api.openapi.yaml", import.meta.url)), "utf8"),
) as { paths: Record<string, Record<string, OpenApiOperation>> };

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema: Record<string, unknown> }> }>;
}

/** OpenAPI schema names → the zod schemas `openapi-agreement.test.ts` proves equal to them. */
const ZOD_FOR: Record<string, z.ZodType> = {
  Accepted,
  TurnResult,
  User: BridgeUser,
  Conversation: BridgeConversation,
  Message,
  BridgeEvent,
  Problem,
};

function operation(operationId: string): { method: string; path: string; op: OpenApiOperation } {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === "object" && op && "operationId" in op && op.operationId === operationId)
        return { method, path, op };
    }
  }
  throw new Error(`OpenAPI has no operation ${operationId}`);
}

/** Validates a response against the OpenAPI response for its status: documented, and the body matches. */
function expectConforms(operationId: string, res: Awaited<ReturnType<App["inject"]>>) {
  const { op } = operation(operationId);
  const documented = op.responses?.[String(res.statusCode)];
  expect(documented, `${operationId} does not document ${res.statusCode}: ${res.body}`).toBeDefined();
  if (documented?.$ref) {
    expect(res.headers["content-type"]).toContain("application/problem+json");
    Problem.parse(res.json());
    return;
  }
  const schema = documented?.content?.["application/json"]?.schema;
  if (!schema) return;
  const ref = (s: Record<string, unknown>) => String(s["$ref"]).split("/").at(-1) as string;
  if (schema["$ref"]) {
    const zod = ZOD_FOR[ref(schema)];
    expect(zod, `no zod schema mapped for ${ref(schema)}`).toBeDefined();
    zod?.parse(res.json());
    return;
  }
  // Inline list bodies: `{ data: [<ref>], nextCursor? }`.
  const items = (schema["properties"] as Record<string, { items?: Record<string, unknown> }>)["data"]?.items;
  const zod = items ? ZOD_FOR[ref(items)] : undefined;
  expect(zod, `${operationId}: inline schema not understood`).toBeDefined();
  const body = res.json() as { data: unknown[]; nextCursor?: unknown };
  for (const item of body.data) zod?.parse(item);
}

describe("contract: every operation built so far, as the OpenAPI file describes it", () => {
  test("the operations under test exist in the OpenAPI file with the methods and paths the API serves", () => {
    const served: Record<string, string> = {
      sendMessage: "post /conversations/{externalConversationId}/messages",
      sendEvent: "post /conversations/{externalConversationId}/events",
      updateUser: "put /users/{externalUserId}",
      getConversation: "get /conversations/{externalConversationId}",
      listMessages: "get /conversations/{externalConversationId}/messages",
      getTurn: "get /turns/{turnId}",
    };
    for (const id of BUILT) {
      const { method, path } = operation(id);
      expect(`${method} ${path}`).toBe(served[id]);
    }
  });

  test.each(BUILT)("%s: success and failure responses conform", async (operationId) => {
    const conv = ext();
    const key = shared.a.key;
    const responses: Awaited<ReturnType<App["inject"]>>[] = [];
    switch (operationId) {
      case "sendMessage":
        responses.push(await send(key, conv, hello()));
        autoWork = true;
        responses.push(await send(key, conv, hello("وكمان سؤال"), "?wait=5"));
        responses.push(await send(key, ext(), { message: { type: "text", text: "بدون مستخدم" } }));
        responses.push(await send("wk_bridge_nope_nope", conv, hello()));
        break;
      case "sendEvent":
        responses.push(
          await call(key, "POST", `/conversations/${conv}/events`, {
            userId: "u-1",
            name: "order_shipped",
            payload: { orderNumber: "5678" },
          }),
        );
        responses.push(await call(key, "POST", `/conversations/${conv}/events`, { userId: "u-1" }));
        break;
      case "updateUser":
        responses.push(await call(key, "PUT", "/users/cw_contact_77", { name: "خالد", attributes: { tier: "gold" } }));
        responses.push(await call(key, "PUT", "/users/cw_contact_77", { email: "not-an-email" }));
        break;
      case "getConversation":
        await send(key, conv, hello());
        responses.push(await call(key, "GET", `/conversations/${conv}`));
        responses.push(await call(key, "GET", `/conversations/${ext()}`));
        break;
      case "listMessages":
        await send(key, conv, hello());
        responses.push(await call(key, "GET", `/conversations/${conv}/messages`));
        responses.push(await call(key, "GET", `/conversations/${ext()}/messages`));
        break;
      case "getTurn": {
        const accepted = (await send(key, conv, hello())).json() as Accepted;
        responses.push(await call(key, "GET", `/turns/${accepted.turnId}`));
        responses.push(await call(key, "GET", `/turns/${newId("turn")}`));
        break;
      }
    }
    expect(responses.length).toBeGreaterThanOrEqual(2);
    for (const res of responses) expectConforms(operationId, res);
  });
});

/* ------------------------------------------------------------------ */
/* Behaviour                                                           */
/* ------------------------------------------------------------------ */

describe("sendMessage", () => {
  test("stores the user, the conversation, the message and the inbox event, then enqueues a turn", async () => {
    const conv = ext();
    const res = await send(shared.a.key, conv, hello());
    expect(res.statusCode).toBe(202);
    const accepted = Accepted.parse(res.json());
    expect(accepted.status).toBe("queued");
    expect(jobs).toEqual([accepted.conversationId]);
    const [event] = await superuserQuery(
      pg.urls,
      "select seq, kind, payload->>'turnId' as turn_id, idempotency_key from inbound_events where conversation_id = $1",
      [accepted.conversationId],
    );
    // No Idempotency-Key was sent, so the message is de-duplicated by its externalMessageId (ADR-024).
    expect(event).toMatchObject({ seq: "1", kind: "message", turn_id: accepted.turnId });
    expect(String(event?.["idempotency_key"])).toMatch(/^xmid:/);
    const conversation = (await call(shared.a.key, "GET", `/conversations/${conv}`)).json();
    expect(conversation).toMatchObject({
      externalId: conv,
      status: "idle",
      user: {
        externalId: "cw_contact_812",
        name: "منى",
        locale: "ar-EG",
        attributes: { plan: "pro", odooPartnerId: 4411 },
      },
    });
    const [row] = await superuserQuery(pg.urls, "select mode from conversations where id = $1", [
      accepted.conversationId,
    ]);
    expect(row).toEqual({ mode: "live" });
  });

  test("the first message of a conversation must name its user; later ones need not", async () => {
    const conv = ext();
    const first = await send(shared.a.key, conv, { message: { type: "text", text: "مرحبا" } });
    expect(first.statusCode).toBe(400);
    expect(first.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "userId" }] });
    expect((await send(shared.a.key, conv, hello())).statusCode).toBe(202);
    expect(
      (await send(shared.a.key, conv, { message: { type: "postback", value: "track", label: "تتبع" } })).statusCode,
    ).toBe(202);
    const other = await send(shared.a.key, conv, {
      userId: "someone-else",
      message: { type: "text", text: "أنا مين؟" },
    });
    expect(other.json()).toMatchObject({
      code: "validation_failed",
      errors: [{ path: "userId", code: "user_mismatch" }],
    });
  });

  test("text over 16 KB is payload_too_large; a bad external id is validation_failed", async () => {
    const big = await send(shared.a.key, ext(), hello("ب".repeat(9_000)));
    expect(big.json()).toMatchObject({ status: 413, code: "payload_too_large" });
    const bad = await send(shared.a.key, "has spaces", hello());
    expect(bad.statusCode).toBe(400);
  });

  test("a message to a handed-off conversation is stored and answered handed_off", async () => {
    const conv = ext();
    const first = Accepted.parse((await send(shared.a.key, conv, hello())).json());
    await superuserQuery(pg.urls, "update conversations set status = 'handed_off' where id = $1", [
      first.conversationId,
    ]);
    const res = Accepted.parse((await send(shared.a.key, conv, hello("فين الموظف؟"))).json());
    expect(res.status).toBe("handed_off");
  });

  test("a draft connection's conversations are emulator traffic, never live", async () => {
    const t = await tenant();
    const draft = await db.withWorkspace(t.ws, (tx) =>
      createBridgeConnection(tx, { botId: t.botId, name: "Emulator", target: "draft" }),
    );
    const { key, prefix, secretHash } = generateKey("bridge");
    await db.withWorkspace(t.ws, (tx) =>
      insertApiKey(tx, {
        kind: "bridge",
        name: "emu",
        prefix,
        secretHash,
        scopes: [],
        botId: t.botId,
        connectionId: draft.id,
      }),
    );
    const accepted = Accepted.parse((await send(key, ext(), hello())).json());
    const [row] = await superuserQuery(pg.urls, "select mode from conversations where id = $1", [
      accepted.conversationId,
    ]);
    expect(row).toEqual({ mode: "emulator" });
  });
});

describe("Idempotency-Key", () => {
  test("a duplicate returns the original response and stores nothing twice", async () => {
    const conv = ext();
    const body = hello();
    const key = `idem-${randomBytes(4).toString("hex")}`;
    const first = await send(shared.a.key, conv, body, "", { "idempotency-key": key });
    const again = await send(shared.a.key, conv, { ...body }, "", { "idempotency-key": key });
    expect(first.statusCode).toBe(202);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    const id = (first.json() as Accepted).conversationId;
    const [counts] = await superuserQuery(
      pg.urls,
      `select (select count(*)::int from inbound_events where conversation_id = $1) as events,
              (select count(*)::int from messages where conversation_id = $1) as messages`,
      [id],
    );
    expect(counts).toEqual({ events: 1, messages: 1 });
  });

  test("the same key with a different body is idempotency_mismatch", async () => {
    const conv = ext();
    const key = `idem-${randomBytes(4).toString("hex")}`;
    await send(shared.a.key, conv, hello("الأولى"), "", { "idempotency-key": key });
    const res = await send(shared.a.key, conv, hello("التانية"), "", { "idempotency-key": key });
    expect(res.json()).toMatchObject({ status: 409, code: "idempotency_mismatch" });
  });

  test("two requests with the same new key at once give one event and the same answer", async () => {
    const conv = ext();
    const body = hello();
    await send(shared.a.key, conv, body);
    const key = `idem-${randomBytes(4).toString("hex")}`;
    const [x, y] = await Promise.all([
      send(shared.a.key, conv, body, "", { "idempotency-key": key }),
      send(shared.a.key, conv, body, "", { "idempotency-key": key }),
    ]);
    expect(x.json()).toEqual(y.json());
    const [n] = await superuserQuery(
      pg.urls,
      "select count(*)::int as n from inbound_events where idempotency_key = $1",
      [key],
    );
    expect(n).toEqual({ n: 1 });
  });

  test("keys are per connection: connection B may reuse A's key", async () => {
    const key = `idem-${randomBytes(4).toString("hex")}`;
    const a = await send(shared.a.key, ext(), hello(), "", { "idempotency-key": key });
    const b = await send(shared.b.key, ext(), hello(), "", { "idempotency-key": key });
    expect((a.json() as Accepted).conversationId).not.toBe((b.json() as Accepted).conversationId);
  });
});

describe("externalMessageId without an Idempotency-Key (ADR-024)", () => {
  test("a repeated externalMessageId returns the original response and stores nothing twice", async () => {
    const conv = ext();
    const body = { ...hello(), externalMessageId: `wa-${randomBytes(4).toString("hex")}` };
    const first = await send(shared.a.key, conv, body);
    const again = await send(shared.a.key, conv, { ...body });
    expect(first.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    const [counts] = await superuserQuery(
      pg.urls,
      `select (select count(*)::int from inbound_events where conversation_id = $1) as events,
              (select count(*)::int from messages where conversation_id = $1) as messages`,
      [(first.json() as Accepted).conversationId],
    );
    expect(counts).toEqual({ events: 1, messages: 1 });
  });

  test("the same externalMessageId with different content is idempotency_mismatch", async () => {
    const conv = ext();
    const externalMessageId = `wa-${randomBytes(4).toString("hex")}`;
    await send(shared.a.key, conv, { ...hello("الأولى"), externalMessageId });
    const res = await send(shared.a.key, conv, { ...hello("التانية"), externalMessageId });
    expect(res.json()).toMatchObject({ status: 409, code: "idempotency_mismatch" });
  });

  test("the same externalMessageId in another conversation is a new message", async () => {
    const externalMessageId = `wa-${randomBytes(4).toString("hex")}`;
    const a = await send(shared.a.key, ext(), { ...hello(), externalMessageId });
    const b = await send(shared.a.key, ext(), { ...hello(), externalMessageId });
    expect((a.json() as Accepted).messageId).not.toBe((b.json() as Accepted).messageId);
  });

  test("an explicit Idempotency-Key takes precedence over externalMessageId", async () => {
    const conv = ext();
    const externalMessageId = `wa-${randomBytes(4).toString("hex")}`;
    const a = await send(shared.a.key, conv, { ...hello(), externalMessageId }, "", {
      "idempotency-key": `k-one${externalMessageId}`,
    });
    const b = await send(shared.a.key, conv, { ...hello(), externalMessageId }, "", {
      "idempotency-key": `k-two${externalMessageId}`,
    });
    expect((a.json() as Accepted).messageId).not.toBe((b.json() as Accepted).messageId);
  });
});

describe("wait", () => {
  test("returns the turn's messages and events when it finishes in time", async () => {
    autoWork = true;
    const res = await send(shared.a.key, ext(), hello("عايز أعرف طلبي فين"), "?wait=10");
    expect(res.statusCode).toBe(200);
    const result = TurnResult.parse(res.json());
    expect(result.status).toBe("completed");
    expect(result.messages.map((m) => (m.payload as { text: string }).text)).toEqual(["رد: عايز أعرف طلبي فين"]);
    expect(result.events.map((e) => e.type)).toEqual(["message.created", "turn.completed"]);
    expect(result.events.every((e) => e.turnId === result.turnId && e.id.startsWith("evt_"))).toBe(true);
    expect(sleeps).toEqual([10_000]);
  });

  test("answers 202 with the turn id when the turn does not finish in time; the turn can be polled", async () => {
    const res = await send(shared.a.key, ext(), hello(), "?wait=2");
    expect(res.statusCode).toBe(202);
    const accepted = Accepted.parse(res.json());
    const running = TurnResult.parse((await call(shared.a.key, "GET", `/turns/${accepted.turnId}`)).json());
    expect(running).toEqual({
      turnId: accepted.turnId,
      conversationId: accepted.conversationId,
      status: "running",
      messages: [],
      events: [],
    });
    await work(accepted.conversationId);
    const done = TurnResult.parse((await call(shared.a.key, "GET", `/turns/${accepted.turnId}`)).json());
    expect(done.status).toBe("completed");
    expect(done.messages).toHaveLength(1);
  });

  test("wait outside 1–55 seconds is validation_failed", async () => {
    expect((await send(shared.a.key, ext(), hello(), "?wait=56")).statusCode).toBe(400);
    expect((await send(shared.a.key, ext(), hello(), "?wait=0")).statusCode).toBe(400);
  });
});

describe("SSE", () => {
  test("streams the turn's events, typing included, and ends after turn.completed", async () => {
    autoWork = true;
    const res = await send(shared.a.key, ext(), hello("مرحبا"), "", { accept: "text/event-stream" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = res.body
      .trim()
      .split("\n\n")
      .map((f) => {
        const [eventLine, dataLine] = f.split("\n");
        return {
          type: eventLine?.slice("event: ".length),
          data: BridgeEvent.parse(JSON.parse(dataLine?.slice("data: ".length) ?? "")),
        };
      });
    expect(frames.map((f) => f.type)).toEqual(["typing", "message.created", "turn.completed"]);
    expect(frames[0]?.data.ephemeral).toBe(true);
  });
});

describe("updateUser", () => {
  test("merges data into the user; attributes set to null are removed; no turn starts", async () => {
    const u = `cw_contact_${randomBytes(3).toString("hex")}`;
    const first = BridgeUser.parse(
      (
        await call(shared.a.key, "PUT", `/users/${u}`, { name: "منى", attributes: { plan: "pro", city: "القاهرة" } })
      ).json(),
    );
    expect(first).toMatchObject({
      externalId: u,
      name: "منى",
      attributes: { plan: "pro", city: "القاهرة", name: "منى" },
    });
    const second = BridgeUser.parse(
      (await call(shared.a.key, "PUT", `/users/${u}`, { phone: "+201012345678", attributes: { city: null } })).json(),
    );
    expect(second.attributes).toEqual({ plan: "pro", name: "منى", phone: "+201012345678" });
    expect(second.id).toBe(first.id);
    expect(jobs).toEqual([]);
  });
});

describe("listMessages", () => {
  test("pages through the transcript in order with a cursor; Arabic and mixed text come back unchanged", async () => {
    autoWork = false;
    const conv = ext();
    const texts = RTL_FIXTURES.slice(0, 5).map((f) => f.text);
    for (const t of texts) await send(shared.a.key, conv, hello(t));
    const page1 = (await call(shared.a.key, "GET", `/conversations/${conv}/messages?limit=3`)).json() as {
      data: Message[];
      nextCursor: string;
    };
    expect(page1.data).toHaveLength(3);
    const page2 = (
      await call(shared.a.key, "GET", `/conversations/${conv}/messages?limit=3&cursor=${page1.nextCursor}`)
    ).json() as {
      data: Message[];
      nextCursor: string | null;
    };
    expect(page2.nextCursor).toBeNull();
    expect([...page1.data, ...page2.data].map((m) => (m.payload as { text: string }).text)).toEqual(texts);
    const seqs = [...page1.data, ...page2.data].map((m) => m.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect((await call(shared.a.key, "GET", `/conversations/${conv}/messages?cursor=garbage`)).statusCode).toBe(400);
  });
});

describe("keys and connections", () => {
  test("a key for connection A cannot touch connection B", async () => {
    const conv = ext();
    autoWork = false;
    const b = Accepted.parse((await send(shared.b.key, conv, hello("رسالة على B"))).json());
    await work(b.conversationId);

    // A sees nothing of B's conversation, transcript or turn.
    expect((await call(shared.a.key, "GET", `/conversations/${conv}`)).statusCode).toBe(404);
    expect((await call(shared.a.key, "GET", `/conversations/${conv}/messages`)).statusCode).toBe(404);
    expect((await call(shared.a.key, "GET", `/turns/${b.turnId}`)).statusCode).toBe(404);

    // The same external ids under A are A's own conversation and user, separate from B's.
    const a = Accepted.parse((await send(shared.a.key, conv, hello("رسالة على A"))).json());
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.userId).not.toBe(b.userId);
    const bMessages = await superuserQuery(
      pg.urls,
      "select payload->>'text' as text from messages where conversation_id = $1 and direction = 'in'",
      [b.conversationId],
    );
    expect(bMessages).toEqual([{ text: "رسالة على B" }]);
  });

  test("a key from another workspace sees nothing either", async () => {
    const other = await tenant();
    const conv = ext();
    const mine = Accepted.parse((await send(shared.a.key, conv, hello())).json());
    expect((await call(other.a.key, "GET", `/conversations/${conv}`)).statusCode).toBe(404);
    expect((await call(other.a.key, "GET", `/turns/${mine.turnId}`)).statusCode).toBe(404);
  });

  test("no key, a malformed or workspace key, a wrong secret and a revoked key are unauthenticated", async () => {
    const conv = ext();
    const [prefix] = shared.a.key.split("_").slice(2);
    for (const headers of [
      {},
      { authorization: "Bearer nonsense" },
      { authorization: `Bearer ${generateKey("workspace").key}` },
      { authorization: `Bearer wk_bridge_${prefix}_${"x".repeat(32)}` },
    ]) {
      const res = await app.inject({ method: "GET", url: `/v1/bridge/conversations/${conv}`, headers });
      expect(res.json()).toMatchObject({ status: 401, code: "unauthenticated" });
    }
    const t = await tenant();
    await db.withWorkspace(t.ws, (tx) => revokeApiKey(tx, t.a.keyId, new Date()));
    expect((await call(t.a.key, "GET", `/conversations/${conv}`)).json()).toMatchObject({ code: "unauthenticated" });
  });

  test("a disabled connection is connection_disabled", async () => {
    const t = await tenant();
    await db.withWorkspace(t.ws, (tx) =>
      tx.execute(sql`update bridge_connections set status = 'disabled' where id = ${t.a.id}`),
    );
    const res = await send(t.a.key, ext(), hello());
    expect(res.json()).toMatchObject({ status: 409, code: "connection_disabled" });
  });
});
