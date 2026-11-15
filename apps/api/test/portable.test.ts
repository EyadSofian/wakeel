import { randomBytes } from "node:crypto";
import { BotDefinition, type BotExport, validateDefinition, type Workflow } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, STUDIO, type Stack, signUp, startStack } from "./stack";

/**
 * Task 7.6 acceptance (ADR-038): export → import yields an equivalent validated definition with new
 * ids; knowledge base and table references are reported as unresolved; secrets never travel.
 */
let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

const slug = () => `p-${randomBytes(4).toString("hex")}`;

async function botWithTool(owner: Browser) {
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Portable", slug: slug() })).json().id as string;
  const botId = (await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name: "متجر النور", slug: slug() })).json()
    .id as string;
  const base = `/v1/workspaces/${ws}/bots/${botId}`;
  const detail = (await owner.get(base)).json();
  const mainId = detail.docs.find((d: { kind: string }) => d.kind === "workflow").docId as string;
  const res = await owner.get(`${base}/docs/workflow/${mainId}`);
  const wf = res.json().doc as Workflow;
  const doc = {
    ...wf,
    nodes: wf.nodes.map((n) =>
      n.type === "autonomous"
        ? {
            ...n,
            instructions: "ساعد العميل.",
            tools: [
              {
                id: "tool_kbsearch01",
                type: "kb_search",
                name: "searchPolicies",
                description: "Search the return policy.",
                kbIds: ["kb_01m7a256m0a13warwhczsjhx9k"],
              },
            ],
          }
        : n,
    ),
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
  await owner.send("PUT", `${base}/config/production/SHOP_TOKEN`, { value: "never-exported" });
  return { ws, botId, base };
}

describe("export and import", () => {
  test("export → import gives an equivalent definition with new ids and lists unresolved references", async () => {
    const owner = await signUp(stack.app);
    const { ws, base } = await botWithTool(owner);
    const exported = await owner.get(`${base}/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-disposition"]).toMatch(/^attachment; filename=".+\.wakeel\.json"$/);
    expect(exported.body).not.toContain("never-exported");
    const file = exported.json() as BotExport;
    expect(file).toMatchObject({ format: "wakeel.bot", formatVersion: 1 });

    const imported = await owner.send("POST", `/v1/workspaces/${ws}/bots/import`, {
      name: "نسخة من المتجر",
      slug: slug(),
      file,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const { bot, unresolved } = imported.json();
    expect(unresolved).toEqual([{ kind: "knowledge_base", id: "kb_01m7a256m0a13warwhczsjhx9k" }]);

    const copy = await owner.get(`/v1/workspaces/${ws}/bots/${bot.id}/export`);
    const before = BotDefinition.parse(file.definition);
    const after = BotDefinition.parse(copy.json().definition);
    expect(after.manifest.name).toBe("نسخة من المتجر");
    // Same shape, different ids.
    expect(after.workflows.map((w) => w.nodes.map((n) => [n.type, n.name]))).toEqual(
      before.workflows.map((w) => w.nodes.map((n) => [n.type, n.name])),
    );
    const ids = (d: BotDefinition) => d.workflows.flatMap((w) => [w.id, ...w.nodes.map((n) => n.id)]);
    for (const id of ids(after)) expect(ids(before)).not.toContain(id);
    expect(validateDefinition(after).map((i) => i.code)).toEqual(validateDefinition(before).map((i) => i.code));
  });

  test("a file that is not a bot export is a field error", async () => {
    const owner = await signUp(stack.app);
    const { ws } = await botWithTool(owner);
    const res = await owner.send("POST", `/v1/workspaces/${ws}/bots/import`, {
      name: "x",
      slug: slug(),
      file: { format: "something-else" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0]).toMatchObject({ path: "file", code: "not_a_bot_export" });
  });

  test("two tenants: another workspace cannot export the bot", async () => {
    const owner = await signUp(stack.app);
    const { botId } = await botWithTool(owner);
    const other = await signUp(stack.app);
    const ows = (await other.send("POST", "/v1/workspaces", { name: "Other", slug: slug() })).json().id as string;
    expect((await other.get(`/v1/workspaces/${ows}/bots/${botId}/export`)).statusCode).toBe(404);
  });
});
