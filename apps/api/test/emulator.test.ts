import { randomBytes } from "node:crypto";
import {
  Accepted,
  type BotManifest,
  BridgeUser,
  EmulatorStateResponse,
  newElementId,
  type Workflow,
} from "@wakeel/contracts";
import { superuserQuery } from "@wakeel/db/testing";
import { RTL_FIXTURES } from "@wakeel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type Browser, PASSWORD, STUDIO, type Stack, signUp, startStack } from "./stack";

/**
 * Task 4.6, ADR-025: the Studio emulator's routes. They run the Bridge inbound path for a draft
 * connection that belongs to the builder's session, so the browser never holds a bridge key.
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
});

const slug = () => `e-${randomBytes(4).toString("hex")}`;
const emu = () => `emu-${randomBytes(4).toString("hex")}`;

/** A second session for the same user: what signing in from another tab or device gives. */
async function signIn(email: string): Promise<Browser> {
  const res = await stack.app.inject({
    method: "POST",
    url: "/v1/auth/sign-in",
    headers: { origin: STUDIO },
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [String(raw)]).map((c) => c.split(";")[0]).join("; ");
  const csrf = res.json().csrfToken as string;
  return {
    userId: res.json().user.id,
    email,
    cookie,
    csrf,
    get: (url) => stack.app.inject({ method: "GET", url, headers: { cookie } }),
    send: (method, url, body) =>
      stack.app.inject({
        method,
        url,
        headers: { cookie, origin: STUDIO, "x-csrf-token": csrf },
        ...(body === undefined ? {} : { payload: body as object }),
      }),
  };
}

/** A workspace with a bot; its Main workflow is Start → one Autonomous node, as seeded. */
async function botOf(owner: Browser) {
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Emulator", slug: slug() })).json().id as string;
  const created = await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name: "النور", slug: slug() });
  expect(created.statusCode, created.body).toBe(201);
  const botId = created.json().id as string;
  const detail = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}`)).json();
  const mainId = detail.docs[1].docId as string;
  const main = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}/docs/workflow/${mainId}`)).json().doc as Workflow;
  const base = `/v1/workspaces/${ws}/bots/${botId}/emulator`;
  return { ws, botId, main, base };
}

const hello = (text = "عايز أعرف حالة الطلب") => ({
  userId: "test-user",
  user: { name: "Test user", locale: "ar-EG" },
  message: { type: "text", text },
});

const connectionOf = async (conversationId: string) =>
  (
    await superuserQuery(
      stack.pg.urls,
      `select c.mode, b.id as connection_id, b.target, b.emulator_session_id,
              (select count(*)::int from api_keys k where k.connection_id = b.id) as keys
         from conversations c join bridge_connections b on b.id = c.connection_id where c.id = $1`,
      [conversationId],
    )
  )[0] as { mode: string; connection_id: string; target: string; emulator_session_id: string | null; keys: number };

describe("sending messages", () => {
  test("the first message makes an emulator conversation on the session's draft connection, with no key", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const res = await owner.send("POST", `${b.base}/conversations/${emu()}/messages`, hello());
    expect(res.statusCode, res.body).toBe(202);
    const accepted = Accepted.parse(res.json());
    expect(stack.jobs).toEqual([accepted.conversationId]);
    expect(await connectionOf(accepted.conversationId)).toMatchObject({
      mode: "emulator",
      target: "draft",
      emulator_session_id: expect.stringMatching(/^ses_/),
      keys: 0,
    });
  });

  test("a session keeps one connection per bot; another session of the same user gets its own", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const first = Accepted.parse(
      (await owner.send("POST", `${b.base}/conversations/${emu()}/messages`, hello())).json(),
    );
    const reset = Accepted.parse(
      (await owner.send("POST", `${b.base}/conversations/${emu()}/messages`, hello())).json(),
    );
    const other = await signIn(owner.email);
    const elsewhere = Accepted.parse(
      (await other.send("POST", `${b.base}/conversations/${emu()}/messages`, hello())).json(),
    );
    const [x, y, z] = await Promise.all([first, reset, elsewhere].map((a) => connectionOf(a.conversationId)));
    expect(y?.connection_id).toBe(x?.connection_id);
    expect(z?.connection_id).not.toBe(x?.connection_id);
  });

  test("SSE streams the turn's events, and Arabic and mixed text come back unchanged", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    stack.autoWork.on = true;
    const text = (RTL_FIXTURES.find((f) => f.id === "english_arabic_name") ?? RTL_FIXTURES[0])?.text as string;
    const res = await stack.app.inject({
      method: "POST",
      url: `${b.base}/conversations/${emu()}/messages`,
      headers: { cookie: owner.cookie, origin: STUDIO, "x-csrf-token": owner.csrf, accept: "text/event-stream" },
      payload: hello(text),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = res.body
      .split("\n\n")
      .filter(Boolean)
      .map((f) => {
        const [eventLine, dataLine] = f.split("\n");
        return { type: eventLine?.slice("event: ".length), data: JSON.parse(dataLine?.slice("data: ".length) ?? "{}") };
      });
    expect(frames.map((f) => f.type)).toEqual(["typing", "message.created", "turn.completed"]);
    expect(frames[1]?.data.data.message.payload.text).toBe(`رد: ${text}`);
  });

  test("mutations need the session's CSRF token", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const res = await stack.app.inject({
      method: "POST",
      url: `${b.base}/conversations/${emu()}/messages`,
      headers: { cookie: owner.cookie, origin: STUDIO },
      payload: hello(),
    });
    expect(res.statusCode).toBe(403);
    expect(stack.jobs).toEqual([]);
  });
});

describe("run from here", () => {
  test("stores a run_from event for the node on a new emulator conversation and enqueues it", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const node = b.main.nodes[1] as { id: string };
    const res = await owner.send("POST", `${b.base}/conversations/${emu()}/run-from`, {
      userId: "test-user",
      workflowId: b.main.id,
      nodeId: node.id,
    });
    expect(res.statusCode, res.body).toBe(202);
    const accepted = Accepted.parse(res.json());
    expect(accepted.messageId).toBeUndefined();
    const [event] = await superuserQuery(
      stack.pg.urls,
      "select kind, payload->>'workflowId' as workflow_id, payload->>'nodeId' as node_id from inbound_events where conversation_id = $1",
      [accepted.conversationId],
    );
    expect(event).toEqual({ kind: "run_from", workflow_id: b.main.id, node_id: node.id });
    expect((await connectionOf(accepted.conversationId))?.mode).toBe("emulator");
    expect(stack.jobs).toEqual([accepted.conversationId]);
  });

  test("ids that are not element ids are validation_failed", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const res = await owner.send("POST", `${b.base}/conversations/${emu()}/run-from`, {
      userId: "test-user",
      workflowId: b.main.id,
      nodeId: "not-a-node",
    });
    expect(res.json()).toMatchObject({ status: 400, code: "validation_failed" });
  });

  test("the public Bridge API has no way to send run_from", async () => {
    // sendEvent's kind is always `event`; only this route writes `run_from` (ADR-025).
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const res = await owner.send("POST", `${b.base}/conversations/${emu()}/events`, {
      userId: "test-user",
      name: "run_from",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the test user", () => {
  test("PUT users merges the form's data into the test user", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    await owner.send("PUT", `${b.base}/users/test-user`, { name: "منى", attributes: { plan: "pro" } });
    const res = await owner.send("PUT", `${b.base}/users/test-user`, { attributes: { plan: null, city: "جدة" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(BridgeUser.parse(res.json())).toMatchObject({
      externalId: "test-user",
      name: "منى",
      attributes: { name: "منى", city: "جدة" },
    });
  });
});

describe("state", () => {
  test("values by scope, defaults when unset, and sensitive values never sent", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const manifestUrl = `/v1/workspaces/${b.ws}/bots/${b.botId}/docs/manifest/manifest`;
    const current = (await owner.get(manifestUrl)).json();
    const city = newElementId("var");
    const token = newElementId("var");
    const greeting = newElementId("var");
    const manifest: BotManifest = {
      ...(current.doc as BotManifest),
      variables: [
        { id: city, name: "city", scope: "conversation", type: "string", sensitive: false },
        { id: token, name: "token", scope: "conversation", type: "string", sensitive: true },
        { id: greeting, name: "greeting", scope: "bot", type: "string", default: "أهلاً", sensitive: false },
      ],
    };
    const saved = await stack.app.inject({
      method: "PUT",
      url: manifestUrl,
      headers: { cookie: owner.cookie, origin: STUDIO, "x-csrf-token": owner.csrf, "if-match": `"${current.rev}"` },
      payload: { doc: manifest },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const ext = emu();
    const accepted = Accepted.parse(
      (await owner.send("POST", `${b.base}/conversations/${ext}/messages`, hello())).json(),
    );
    await superuserQuery(
      stack.pg.urls,
      `update conversations set state = jsonb_set(jsonb_set(state, '{conversationVars,${city}}', '"القاهرة"'),
         '{conversationVars,${token}}', '"sk-secret"') where id = $1`,
      [accepted.conversationId],
    );
    const res = await owner.get(`${b.base}/conversations/${ext}/state`);
    expect(res.statusCode, res.body).toBe(200);
    const view = EmulatorStateResponse.parse(res.json());
    expect(view).toMatchObject({ conversationId: accepted.conversationId, status: "idle", limitBytes: 262_144 });
    expect(view.attributes).toMatchObject({ name: "Test user", locale: "ar-EG" });
    const byName = Object.fromEntries(view.variables.map((v) => [v.name, v]));
    expect(byName["city"]).toMatchObject({ scope: "conversation", value: "القاهرة", sensitive: false });
    expect(byName["token"]).toMatchObject({ scope: "conversation", value: null, sensitive: true });
    expect(byName["greeting"]).toMatchObject({ scope: "bot", value: "أهلاً" });
    expect(res.body).not.toContain("sk-secret");
  });

  test("a conversation of another session is not_found", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const ext = emu();
    await owner.send("POST", `${b.base}/conversations/${ext}/messages`, hello());
    const other = await signIn(owner.email);
    expect((await other.get(`${b.base}/conversations/${ext}/state`)).json()).toMatchObject({ code: "not_found" });
  });
});

describe("who may use it", () => {
  test("a viewer is forbidden; another workspace's owner reaches neither the workspace nor the bot", async () => {
    const owner = await signUp(stack.app);
    const b = await botOf(owner);
    const viewer = await signUp(stack.app);
    const inv = await owner.send("POST", `/v1/workspaces/${b.ws}/invitations`, { email: viewer.email, role: "viewer" });
    const tokenOf = new URL(inv.json().acceptUrl).pathname.split("/").pop();
    expect((await viewer.send("POST", "/v1/invitations/accept", { token: tokenOf })).statusCode).toBe(200);
    expect((await viewer.send("POST", `${b.base}/conversations/${emu()}/messages`, hello())).json()).toMatchObject({
      code: "forbidden",
    });

    const stranger = await signUp(stack.app);
    const theirs = await botOf(stranger);
    // Not a member: not_found, so workspace ids cannot be probed (studio.ts requireMember).
    expect((await stranger.send("POST", `${b.base}/conversations/${emu()}/messages`, hello())).statusCode).toBe(404);
    const crossed = `/v1/workspaces/${theirs.ws}/bots/${b.botId}/emulator/conversations/${emu()}/messages`;
    expect((await stranger.send("POST", crossed, hello())).json()).toMatchObject({ code: "not_found" });
    expect(stack.jobs).toEqual([]);
  });
});
