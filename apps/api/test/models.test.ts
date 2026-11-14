import { randomBytes } from "node:crypto";
import { ModelKeyStatus, type ModelSummary } from "@wakeel/contracts";
import { superuserQuery } from "@wakeel/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, type Stack, signUp, startStack } from "./stack";

/**
 * Task 6.2: Settings → Models. Acceptance (build plan): add a key (write-only), pick defaults; the
 * key is never returned by the API.
 */
let stack: Stack;
const KEY = `sk-ant-test-${randomBytes(12).toString("hex")}`;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

async function workspace(owner: Browser) {
  const res = await owner.send("POST", "/v1/workspaces", {
    name: "Models",
    slug: `m-${randomBytes(4).toString("hex")}`,
  });
  return `/v1/workspaces/${res.json().id as string}`;
}

describe("model keys", () => {
  test("a key is stored sealed and only its last four characters ever come back", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspace(owner);
    const put = await owner.send("PUT", `${ws}/model-keys/anthropic`, { apiKey: KEY });
    expect(put.statusCode, put.body).toBe(200);
    expect(ModelKeyStatus.parse(put.json())).toMatchObject({ provider: "anthropic", set: true, last4: KEY.slice(-4) });
    const list = await owner.get(`${ws}/model-keys`);
    for (const res of [put, list]) expect(res.body).not.toContain(KEY);
    expect(list.json().data.map((s: ModelKeyStatus) => [s.provider, s.set])).toEqual([
      ["anthropic", true],
      ["openai", false],
      ["google", false],
      ["openai-compatible", false],
    ]);
    const stored = (await superuserQuery(
      stack.pg.urls,
      "select encode(ciphertext, 'escape') as c from workspace_secrets",
      [],
    )) as {
      c: string;
    }[];
    expect(stored.some((r) => r.c.includes(KEY))).toBe(false);
    const audit = (await superuserQuery(
      stack.pg.urls,
      "select meta::text as m from audit_log where action = 'secret.written'",
      [],
    )) as {
      m: string;
    }[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => !a.m.includes(KEY))).toBe(true);

    const models = (await owner.get(`${ws}/models`)).json().data as ModelSummary[];
    expect(models.find((m) => m.id === "claude-sonnet-5-5")).toMatchObject({ provider: "anthropic", keySet: true });
    expect(models.length).toBeGreaterThan(0);

    expect((await owner.send("DELETE", `${ws}/model-keys/anthropic`)).statusCode).toBe(204);
    expect((await owner.get(`${ws}/model-keys`)).json().data[0]).toMatchObject({
      provider: "anthropic",
      set: false,
      last4: null,
    });
  });

  test("an OpenAI-compatible key needs its server's https address", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspace(owner);
    const missing = await owner.send("PUT", `${ws}/model-keys/openai-compatible`, { apiKey: KEY });
    expect(missing.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "baseUrl" }] });
    const ok = await owner.send("PUT", `${ws}/model-keys/openai-compatible`, {
      apiKey: KEY,
      baseUrl: "https://llm.example.com/v1",
    });
    expect(ok.json()).toMatchObject({ set: true, baseUrl: "https://llm.example.com/v1" });
  });

  test("another workspace's member cannot read or write these keys", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspace(owner);
    const stranger = await signUp(stack.app);
    expect((await stranger.get(`${ws}/model-keys`)).statusCode).toBe(404);
    expect((await stranger.send("PUT", `${ws}/model-keys/anthropic`, { apiKey: KEY })).statusCode).toBe(404);
  });
});

describe("model defaults", () => {
  test("defaults are set from the registry, an unknown model is refused, and null clears one", async () => {
    const owner = await signUp(stack.app);
    const ws = await workspace(owner);
    const set = await owner.send("PUT", `${ws}/model-defaults`, {
      defaultModel: "claude-sonnet-5-5",
      utilityModel: "claude-haiku-5-5",
    });
    expect(set.json()).toEqual({ defaultModel: "claude-sonnet-5-5", utilityModel: "claude-haiku-5-5" });
    expect((await owner.get(ws)).json().settings).toEqual({
      defaultModel: "claude-sonnet-5-5",
      utilityModel: "claude-haiku-5-5",
    });
    const bad = await owner.send("PUT", `${ws}/model-defaults`, { defaultModel: "gpt-imaginary", utilityModel: null });
    expect(bad.json()).toMatchObject({
      code: "validation_failed",
      errors: [{ path: "defaultModel", code: "unknown_model" }],
    });
    const cleared = await owner.send("PUT", `${ws}/model-defaults`, {
      defaultModel: "claude-opus-5-5",
      utilityModel: null,
    });
    expect(cleared.json()).toEqual({ defaultModel: "claude-opus-5-5", utilityModel: null });
  });
});
