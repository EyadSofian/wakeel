import { randomBytes } from "node:crypto";
import type { Workflow } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, STUDIO, type Stack, signUp, startStack } from "./stack";

/**
 * Task 7.1 acceptance through the api (ADR-036): publish is blocked by errors with the issue list;
 * identical drafts produce the same hash; rollback changes only the pointer; restore; audit; two
 * tenants.
 */
let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

const slug = () => `v-${randomBytes(4).toString("hex")}`;

async function botFor(owner: Browser) {
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Versions", slug: slug() })).json().id as string;
  const botId = (await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name: "مساعد", slug: slug() })).json()
    .id as string;
  const base = `/v1/workspaces/${ws}/bots/${botId}`;
  return { ws, botId, base };
}

/** Gives the seeded Autonomous node instructions, which is all the seeded draft lacks to publish. */
async function fixDraft(owner: Browser, base: string) {
  const detail = (await owner.get(base)).json();
  const mainId = detail.docs.find((d: { kind: string }) => d.kind === "workflow").docId as string;
  const res = await owner.get(`${base}/docs/workflow/${mainId}`);
  const wf = res.json().doc as Workflow;
  const doc = {
    ...wf,
    nodes: wf.nodes.map((n) => (n.type === "autonomous" ? { ...n, instructions: "ساعد العميل." } : n)),
  };
  const saved = await stack.app.inject({
    method: "PUT",
    url: `${base}/docs/workflow/${mainId}`,
    headers: {
      cookie: owner.cookie,
      origin: STUDIO,
      "x-csrf-token": owner.csrf,
      "if-match": res.headers.etag as string,
    },
    payload: { doc },
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

describe("versions", () => {
  test("publish is refused with the blocking issues, then succeeds once they are fixed", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botFor(owner);
    const refused = await owner.send("POST", `${base}/versions`, { label: "First" });
    expect(refused.statusCode).toBe(422);
    const problem = refused.json();
    expect(problem.code).toBe("definition_invalid");
    expect(problem.title).toBe("The bot has 1 problems that block publishing");
    expect(problem.errors.map((e: { code: string }) => e.code)).toEqual(["autonomous_instructions_empty"]);

    await fixDraft(owner, base);
    const published = await owner.send("POST", `${base}/versions`, { label: "First", notes: "أول نسخة" });
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json()).toMatchObject({ number: 1, label: "First", notes: "أول نسخة", live: true });
    expect((await owner.get(base)).json().publishedVersionId).toBe(published.json().id);
  });

  test("an empty label is a field error", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botFor(owner);
    const res = await owner.send("POST", `${base}/versions`, { label: "  " });
    expect(res.statusCode).toBe(400);
  });

  test("identical drafts hash the same; rollback moves only the pointer; the audit log has each step", async () => {
    const owner = await signUp(stack.app);
    const { ws, base } = await botFor(owner);
    await fixDraft(owner, base);
    const v1 = (await owner.send("POST", `${base}/versions`, { label: "v1" })).json();
    const v2 = (await owner.send("POST", `${base}/versions`, { label: "v2" })).json();
    expect(v2.definitionHash).toBe(v1.definitionHash);
    const draftBefore = (await owner.get(base)).json().docs;

    const rolled = await owner.send("POST", `${base}/versions/${v1.id}/rollback`, {});
    expect(rolled.statusCode, rolled.body).toBe(200);
    const list = (await owner.get(`${base}/versions`)).json();
    expect(list.data.map((v: { number: number; live: boolean }) => [v.number, v.live])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect((await owner.get(base)).json().docs).toEqual(draftBefore);

    const one = (await owner.get(`${base}/versions/${v1.id}`)).json();
    expect(one.definition.manifest.name).toBe("مساعد");

    const actions = (await owner.get(`/v1/workspaces/${ws}/audit-log?limit=200`))
      .json()
      .data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["bot.published", "bot.rolled_back"]));
  });

  test("restore brings the version's definition back into the draft", async () => {
    const owner = await signUp(stack.app);
    const { base } = await botFor(owner);
    await fixDraft(owner, base);
    const v1 = (await owner.send("POST", `${base}/versions`, { label: "v1" })).json();
    const added = await owner.send("POST", `${base}/workflows`, { name: "Extra" });
    expect(added.statusCode).toBe(201);
    const restored = await owner.send("POST", `${base}/versions/${v1.id}/restore`, {});
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().removedWorkflows).toEqual([added.json().docId]);
    const docs = (await owner.get(base)).json().docs as { kind: string; rev: number }[];
    expect(docs.map((d) => d.kind)).toEqual(["manifest", "workflow"]);
  });

  test("two tenants: another workspace cannot list, read, publish or roll back", async () => {
    const a = await signUp(stack.app);
    const b = await signUp(stack.app);
    const { botId, base } = await botFor(a);
    await fixDraft(a, base);
    const v1 = (await a.send("POST", `${base}/versions`, { label: "v1" })).json();
    const bws = (await b.send("POST", "/v1/workspaces", { name: "Other", slug: slug() })).json().id as string;
    const other = `/v1/workspaces/${bws}/bots/${botId}/versions`;
    expect((await b.get(other)).statusCode).toBe(404);
    expect((await b.get(`${other}/${v1.id}`)).statusCode).toBe(404);
    expect((await b.send("POST", other, { label: "x" })).statusCode).toBe(404);
    expect((await b.send("POST", `${other}/${v1.id}/rollback`, {})).statusCode).toBe(404);
    // B asking under A's workspace is hidden like a missing workspace.
    expect((await b.get(`${base}/versions`)).statusCode).toBe(404);
  });
});
