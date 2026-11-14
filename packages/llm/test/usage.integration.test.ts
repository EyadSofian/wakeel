import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import { createDatabase, createWorkspace, type Database, insertUsageEvent } from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createLlm } from "../src/client";
import { registry } from "../src/registry";

/**
 * Task 6.1 acceptance: a usage event per call with the correct cost, stored in usage_events through
 * the real repository. The provider is the SDK's mock model reporting a known usage.
 */
let database: StartedTestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = createDatabase({ url: database.urls.rw, maxConnections: 4 });
});

afterAll(async () => {
  await db?.close();
  await database?.stop();
});

test("each call stores one usage event whose cost follows the registry's prices", async () => {
  const userId = newId("usr");
  await superuserQuery(database.urls, "insert into users (id, email, name) values ($1, $2, 'Builder')", [
    userId,
    `${userId}@example.test`,
  ]);
  const { workspace } = await createWorkspace(db, {
    name: "Usage",
    slug: `u-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const usage = {
    inputTokens: { total: 12_000, noCache: 2_000, cacheRead: 10_000, cacheWrite: 0 },
    outputTokens: { total: 800, text: 800, reasoning: 0 },
  };
  const llm = createLlm({
    models: {
      language: () =>
        new MockLanguageModelV4({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "تمام" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
              ],
            }),
          }),
        }),
      embedding: () => {
        throw new Error("not used");
      },
    },
    credentials: {
      workspaceKey: async () => "ws-key",
      platformKey: async () => undefined,
      platformKeysAllowed: async () => false,
    },
    onUsage: (e) =>
      db.withWorkspace(e.workspaceId, async (tx) => {
        await insertUsageEvent(tx, {
          kind: e.kind,
          quantity: e.usage.inputTokens + e.usage.cachedInputTokens + e.usage.cacheWriteTokens + e.usage.outputTokens,
          unit: "tokens",
          model: e.model,
          costMicroUsd: e.costMicroUsd,
          mode: e.mode,
          ...(e.turnId ? { turnId: e.turnId } : {}),
          detail: { ...e.usage, provider: e.provider, keySource: e.keySource, purpose: e.purpose },
        });
      }),
  });
  for (const mode of ["live", "emulator"] as const) {
    await llm.stream({
      model: "claude-sonnet-5-5",
      system: "Fixed.",
      messages: [{ role: "user", content: "مرحبا" }],
      purpose: "autonomy",
      context: { workspaceId: workspace.id, mode },
    }).result;
  }
  const rows = (await superuserQuery(
    database.urls,
    "select kind, quantity::int as quantity, model, cost_micro_usd::int as cost, mode, detail from usage_events where workspace_id = $1 order by mode",
    [workspace.id],
  )) as {
    kind: string;
    quantity: number;
    model: string;
    cost: number;
    mode: string;
    detail: Record<string, unknown>;
  }[];
  const sonnet = registry.get("claude-sonnet-5-5").prices;
  // 2,000 × $2 + 10,000 × $0.10 + 800 × $10 = 4,000 + 1,000 + 8,000 micro-USD.
  expect(sonnet).toMatchObject({ inputPerMTok: 2, cacheReadPerMTok: 0.1, outputPerMTok: 10 });
  const expected = { kind: "llm_tokens", quantity: 12_800, model: "claude-sonnet-5-5", cost: 13_000 };
  expect(rows).toEqual([
    {
      ...expected,
      mode: "emulator",
      detail: expect.objectContaining({ keySource: "workspace", cachedInputTokens: 10_000 }),
    },
    { ...expected, mode: "live", detail: expect.objectContaining({ keySource: "workspace", purpose: "autonomy" }) },
  ]);
});
