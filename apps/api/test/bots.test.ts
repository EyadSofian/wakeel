import { randomBytes } from "node:crypto";
import type { BotManifest, Workflow } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, STUDIO, type Stack, signUp, startStack } from "./stack";

/**
 * Task 2.1 acceptance: a stale If-Match returns revision_conflict with the server copy; two-tenant
 * tests; a new bot seeds a Main workflow with Start and one Autonomous node.
 */
let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

const slug = () => `b-${randomBytes(4).toString("hex")}`;

const workspaceOf = async (owner: Browser) =>
  (await owner.send("POST", "/v1/workspaces", { name: "Bots", slug: slug() })).json().id as string;

/** PUT with an explicit If-Match (Browser.send has no header option). */
const put = (b: Browser, url: string, body: unknown, rev: string | undefined) =>
  stack.app.inject({
    method: "PUT",
    url,
    headers: {
      cookie: b.cookie,
      origin: STUDIO,
      "x-csrf-token": b.csrf,
      ...(rev === undefined ? {} : { "if-match": rev }),
    },
    payload: body as object,
  });

const newBot = async (owner: Browser, ws: string, name = "مساعد") => {
  const res = await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name, slug: slug() });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

describe("bots", () => {
  test("a new bot has a manifest and a Main workflow: Start wired to one Autonomous node", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws, "مساعد المبيعات");
    const detail = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}`)).json();
    expect(detail).toMatchObject({ name: "مساعد المبيعات", defaultLocale: "ar", publishedVersionId: null });
    expect(detail.docs.map((d: { kind: string; rev: number }) => [d.kind, d.rev])).toEqual([
      ["manifest", 0],
      ["workflow", 0],
    ]);
    const mainId = detail.docs[1].docId;
    const res = await owner.get(`/v1/workspaces/${ws}/bots/${botId}/docs/workflow/${mainId}`);
    expect(res.headers.etag).toBe('"0"');
    const main = res.json().doc as Workflow;
    expect(main.nodes.map((n) => n.type)).toEqual(["start", "autonomous"]);
    expect(main.edges[0]).toMatchObject({
      from: { nodeId: main.nodes[0]?.id, port: "next" },
      to: { nodeId: main.nodes[1]?.id },
    });
    expect((await owner.get(`/v1/workspaces/${ws}/bots`)).json().data.map((b: { id: string }) => b.id)).toEqual([
      botId,
    ]);
  });

  test("rename, then delete; each writes an audit entry", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws, "Old name");
    expect((await owner.send("PATCH", `/v1/workspaces/${ws}/bots/${botId}`, { name: "New name" })).json().name).toBe(
      "New name",
    );
    const manifest = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}/docs/manifest/manifest`)).json();
    expect(manifest.doc.name).toBe("New name");
    expect(manifest.rev).toBe(1);
    expect((await owner.send("DELETE", `/v1/workspaces/${ws}/bots/${botId}`)).statusCode).toBe(204);
    expect((await owner.get(`/v1/workspaces/${ws}/bots/${botId}`)).json().code).toBe("not_found");
    const actions = (await owner.get(`/v1/workspaces/${ws}/audit-log`))
      .json()
      .data.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 3)).toEqual(["bot.deleted", "bot.updated", "bot.created"]);
  });
});

describe("draft documents", () => {
  test("PUT with the current revision saves and returns the next ETag", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const url = `/v1/workspaces/${ws}/bots/${botId}/docs/manifest/manifest`;
    const doc = (await owner.get(url)).json().doc as BotManifest;
    const res = await put(owner, url, { doc: { ...doc, description: "يرد على أسئلة الطلبات" } }, '"0"');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    expect(res.json().doc.description).toBe("يرد على أسئلة الطلبات");
  });

  test("a stale If-Match is revision_conflict carrying the server copy", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const detail = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}`)).json();
    const url = `/v1/workspaces/${ws}/bots/${botId}/docs/workflow/${detail.docs[1].docId}`;
    const original = (await owner.get(url)).json().doc as Workflow;
    // Tab one saves.
    expect((await put(owner, url, { doc: { ...original, name: "From tab one" } }, '"0"')).statusCode).toBe(200);
    // Tab two still holds revision 0.
    const stale = await put(owner, url, { doc: { ...original, name: "From tab two" } }, '"0"');
    expect(stale.statusCode).toBe(409);
    const problem = stale.json();
    expect(problem.code).toBe("revision_conflict");
    expect(problem.detail).toBe("Your copy is based on revision 0; the saved revision is 1.");
    expect(problem.current.rev).toBe(1);
    expect(problem.current.doc.name).toBe("From tab one");
  });

  test("a PUT without If-Match, or with an invalid document, is validation_failed", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const url = `/v1/workspaces/${ws}/bots/${botId}/docs/manifest/manifest`;
    const doc = (await owner.get(url)).json().doc;
    const missing = await put(owner, url, { doc }, undefined);
    expect(missing.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "If-Match" }] });
    const invalid = await put(owner, url, { doc: { ...doc, name: "" } }, '"0"');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("validation_failed");
    expect((await owner.get(url)).json().rev).toBe(0);
  });

  test("a workflow whose id does not match the address is refused", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const detail = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}`)).json();
    const url = `/v1/workspaces/${ws}/bots/${botId}/docs/workflow/${detail.docs[1].docId}`;
    const doc = (await owner.get(url)).json().doc;
    const res = await put(owner, url, { doc: { ...doc, id: "wf_AAAAAAAAAA" } }, '"0"');
    expect(res.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "doc.id" }] });
  });

  test("sub-workflows: add one, delete it; the main workflow cannot be deleted", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const created = await owner.send("POST", `/v1/workspaces/${ws}/bots/${botId}/workflows`, { name: "استرجاع" });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"0"');
    expect(created.json().doc.nodes.map((n: { type: string }) => n.type)).toEqual(["entry", "exit"]);
    expect(
      (await owner.send("DELETE", `/v1/workspaces/${ws}/bots/${botId}/workflows/${created.json().docId}`)).statusCode,
    ).toBe(204);
    const main = (await owner.get(`/v1/workspaces/${ws}/bots/${botId}/docs/manifest/manifest`)).json().doc
      .mainWorkflowId;
    expect((await owner.send("DELETE", `/v1/workspaces/${ws}/bots/${botId}/workflows/${main}`)).json().code).toBe(
      "validation_failed",
    );
  });
});

describe("roles and tenants", () => {
  test("a viewer reads bots but cannot create, change, save or delete them", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const viewer = await signUp(stack.app);
    const inv = await owner.send("POST", `/v1/workspaces/${ws}/invitations`, { email: viewer.email, role: "viewer" });
    await viewer.send("POST", "/v1/invitations/accept", {
      token: new URL(inv.json().acceptUrl).pathname.split("/").pop(),
    });

    expect((await viewer.get(`/v1/workspaces/${ws}/bots/${botId}`)).statusCode).toBe(200);
    const url = `/v1/workspaces/${ws}/bots/${botId}/docs/manifest/manifest`;
    const doc = (await viewer.get(url)).json().doc;
    for (const res of [
      await viewer.send("POST", `/v1/workspaces/${ws}/bots`, { name: "X", slug: slug() }),
      await viewer.send("PATCH", `/v1/workspaces/${ws}/bots/${botId}`, { name: "Viewer was here" }),
      await put(viewer, url, { doc: { ...doc, name: "Viewer was here" } }, '"0"'),
      await viewer.send("POST", `/v1/workspaces/${ws}/bots/${botId}/workflows`, { name: "X" }),
      await viewer.send("DELETE", `/v1/workspaces/${ws}/bots/${botId}`),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe("forbidden");
    }
  });

  test("another workspace's owner cannot reach the bot or its documents, in both directions", async () => {
    const a = await signUp(stack.app);
    const b = await signUp(stack.app);
    const wa = await workspaceOf(a);
    const wb = await workspaceOf(b);
    const botA = await newBot(a, wa);
    const botB = await newBot(b, wb);
    for (const [who, ownWs, bot] of [
      [b, wb, botA],
      [a, wa, botB],
    ] as const) {
      // Through their own workspace: the bot id is unknown there.
      expect((await who.get(`/v1/workspaces/${ownWs}/bots/${bot}`)).json().code).toBe("not_found");
      expect((await who.get(`/v1/workspaces/${ownWs}/bots/${bot}/docs/manifest/manifest`)).json().code).toBe(
        "not_found",
      );
      const steal = await put(who, `/v1/workspaces/${ownWs}/bots/${bot}/docs/manifest/manifest`, { doc: {} }, '"0"');
      expect(steal.statusCode).toBeGreaterThanOrEqual(400);
      expect((await who.send("DELETE", `/v1/workspaces/${ownWs}/bots/${bot}`)).json().code).toBe("not_found");
    }
    // Through the other workspace's path: not a member.
    expect((await b.get(`/v1/workspaces/${wa}/bots`)).json().code).toBe("not_found");
    expect((await a.get(`/v1/workspaces/${wa}/bots/${botA}`)).statusCode).toBe(200);
  });

  test("an API key with bot.update can save a document; one with only bot.read cannot", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspaceOf(owner);
    const botId = await newBot(owner, ws);
    const key = async (scopes: string[]) =>
      (await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, { name: "CI", scopes })).json().key as string;
    const url = `/v1/workspaces/${ws}/bots/${botId}/docs/manifest/manifest`;
    const doc = (await owner.get(url)).json().doc;
    const withKey = (k: string, rev: string) =>
      stack.app.inject({
        method: "PUT",
        url,
        headers: { authorization: `Bearer ${k}`, "if-match": rev },
        payload: { doc },
      });
    expect((await withKey(await key(["bot.read"]), '"0"')).json().code).toBe("forbidden");
    const ok = await withKey(await key(["bot.read", "bot.update"]), '"0"');
    expect(ok.statusCode, ok.body).toBe(200);
  });
});
