import { APICallError } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Credential, ModelFactory } from "../src/adapters";
import { createLlm, type LlmDeps, type UsageEvent } from "../src/client";
import { loadRegistry } from "../src/registry";

/**
 * Task 6.1: the client over the AI SDK, with the SDK's own mock models standing in for providers.
 * Acceptance: a usage event per call with the correct cost; a 429 triggers retry then fallback.
 */

const entry = (id: string, fallback: string[] = [], kind: "chat" | "embedding" = "chat") => ({
  id,
  provider: "anthropic" as const,
  providerModel: `${id}-provider`,
  kind,
  contextWindow: 200_000,
  maxOutput: 8_000,
  capabilities: { vision: false, caching: true, structuredOutput: true },
  prices: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  autonomy: "untested" as const,
  fallback,
});
const reg = loadRegistry({ models: [entry("main", ["backup"]), entry("backup"), entry("embed", [], "embedding")] });

const usage = {
  inputTokens: { total: 1_200, noCache: 200, cacheRead: 1_000, cacheWrite: 0 },
  outputTokens: { total: 50, text: 50, reasoning: 0 },
};
const streamOf = (text: string[]) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "text-start" as const, id: "t" },
      ...text.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
      { type: "text-end" as const, id: "t" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "end_turn" }, usage },
    ],
  }),
});
const rateLimited = () =>
  new APICallError({
    message: "rate limited",
    url: "https://x",
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  });
const unauthorized = () =>
  new APICallError({
    message: "bad key",
    url: "https://x",
    requestBodyValues: {},
    statusCode: 401,
    isRetryable: false,
  });

function setup(
  behaviour: Record<string, () => unknown>,
  keys: { workspace?: string; platform?: string; allowed?: boolean } = {},
) {
  const events: UsageEvent[] = [];
  const sleeps: number[] = [];
  const calls: { model: string; credential: Credential }[] = [];
  const factory: ModelFactory = {
    language(model, credential) {
      calls.push({ model: model.id, credential });
      return new MockLanguageModelV4({
        modelId: model.providerModel,
        doStream: async () => {
          const result = (behaviour[model.id] ?? (() => streamOf(["ok"])))();
          if (result instanceof Error) throw result;
          return result as ReturnType<typeof streamOf>;
        },
      });
    },
    embedding(model, credential) {
      calls.push({ model: model.id, credential });
      return new MockEmbeddingModelV4({
        doEmbed: async ({ values }) => ({
          embeddings: values.map(() => [0.1, 0.2]),
          usage: { tokens: 21 * values.length },
          warnings: [],
        }),
      });
    },
  };
  const deps: LlmDeps = {
    registry: reg,
    models: factory,
    credentials: {
      workspaceKey: async () => keys.workspace,
      platformKey: async () => keys.platform ?? "platform-key",
      platformKeysAllowed: async () => keys.allowed ?? true,
    },
    onUsage: async (e) => {
      events.push(e);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  };
  return { llm: createLlm(deps), events, sleeps, calls };
}

const request = {
  model: "main",
  system: "Fixed system text.",
  messages: [{ role: "user" as const, content: "مرحبا" }],
  purpose: "test",
  context: { workspaceId: "ws_1", mode: "live" as const, turnId: "turn_1" },
};

describe("stream", () => {
  test("streams text and emits one usage event with the cost from the registry", async () => {
    const s = setup({ main: () => streamOf(["أهلاً", " بيك"]) });
    const handle = s.llm.stream(request);
    const chunks: string[] = [];
    for await (const c of handle.textStream) chunks.push(c);
    const result = await handle.result;
    expect(chunks.join("")).toBe("أهلاً بيك");
    expect(result).toMatchObject({ text: "أهلاً بيك", finishReason: "stop", model: "main" });
    expect(s.events).toEqual([
      {
        kind: "llm_tokens",
        workspaceId: "ws_1",
        mode: "live",
        turnId: "turn_1",
        model: "main",
        provider: "anthropic",
        keySource: "platform",
        purpose: "test",
        usage: { inputTokens: 200, cachedInputTokens: 1_000, cacheWriteTokens: 0, outputTokens: 50 },
        // 200 × $3 + 1,000 × $0.30 + 50 × $15 = 600 + 300 + 750 micro-USD.
        costMicroUsd: 1_650,
      },
    ]);
  });

  test("a 429 is retried, then the fallback model answers; each attempt waits longer", async () => {
    const s = setup({ main: rateLimited, backup: () => streamOf(["من الاحتياطي"]) });
    const handle = s.llm.stream(request);
    for await (const _ of handle.textStream) {
      // drain
    }
    const result = await handle.result;
    expect(s.calls.map((c) => c.model)).toEqual(["main", "main", "main", "backup"]);
    expect(s.sleeps).toEqual([500, 1_000]);
    expect(result).toMatchObject({ text: "من الاحتياطي", model: "backup" });
    expect(s.events.map((e) => e.model)).toEqual(["backup"]);
  });

  test("when every model is unavailable the call fails with model_unavailable", async () => {
    const s = setup({ main: rateLimited, backup: rateLimited });
    const handle = s.llm.stream(request);
    await expect(handle.result).rejects.toMatchObject({ code: "model_unavailable" });
    expect(s.events).toEqual([]);
  });

  test("a rejected key is model_auth_failed at once: no retry, no fallback", async () => {
    const s = setup({ main: unauthorized });
    await expect(s.llm.stream(request).result).rejects.toMatchObject({ code: "model_auth_failed" });
    expect(s.calls.map((c) => c.model)).toEqual(["main"]);
  });
});

describe("credentials (BYOK)", () => {
  test("the workspace's own key wins over the platform's", async () => {
    const s = setup({}, { workspace: "ws-key" });
    await s.llm.stream(request).result;
    expect(s.calls[0]?.credential).toEqual({ apiKey: "ws-key", source: "workspace" });
    expect(s.events[0]?.keySource).toBe("workspace");
  });

  test("without a workspace key and with platform keys not allowed by the plan, the call fails with model_key_missing", async () => {
    const s = setup({}, { allowed: false });
    await expect(s.llm.stream(request).result).rejects.toMatchObject({ code: "model_key_missing" });
    expect(s.calls).toEqual([]);
  });
});

describe("embed", () => {
  test("embeds every value and emits an embedding usage event", async () => {
    const s = setup({});
    const out = await s.llm.embed({
      model: "embed",
      values: ["أ", "ب"],
      purpose: "kb",
      context: { workspaceId: "ws_1", mode: "live" },
    });
    expect(out.embeddings).toEqual([
      [0.1, 0.2],
      [0.1, 0.2],
    ]);
    expect(s.events[0]).toMatchObject({
      kind: "embedding_tokens",
      usage: { inputTokens: 42, outputTokens: 0 },
      costMicroUsd: 126,
    });
  });
});
