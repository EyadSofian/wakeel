import { createAnthropic } from "@ai-sdk/anthropic";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ModelFactory } from "../src/adapters";
import { createLlm } from "../src/client";
import { loadRegistry } from "../src/registry";

/**
 * Architecture §6.4 orders the Autonomous Node's prompt so its system text is a stable, cacheable
 * prefix (ADR-031 §5). Anthropic caches only up to a marked breakpoint, so without one every Claude
 * iteration paid full price for the whole system text. OpenAI caches long prefixes by itself.
 */

const entry = (id: string, provider: "anthropic" | "openai", caching: boolean) => ({
  id,
  provider,
  providerModel: id,
  kind: "chat" as const,
  contextWindow: 200_000,
  maxOutput: 64_000,
  capabilities: { vision: false, caching, structuredOutput: true },
  prices: { inputPerMTok: 1, outputPerMTok: 2 },
  autonomy: "untested" as const,
  fallback: [],
});

type Prompt = { role: string; content: unknown; providerOptions?: Record<string, unknown> }[];

function setup() {
  const prompts: Prompt[] = [];
  const factory: ModelFactory = {
    language(model) {
      return new MockLanguageModelV4({
        modelId: model.providerModel,
        doStream: async (options) => {
          prompts.push(options.prompt as Prompt);
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start" as const, id: "t" },
                { type: "text-delta" as const, id: "t", delta: "ok" },
                { type: "text-end" as const, id: "t" },
                {
                  type: "finish" as const,
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ],
            }),
          };
        },
      });
    },
    embedding() {
      throw new Error("not used");
    },
  };
  const llm = createLlm({
    registry: loadRegistry({
      models: [
        entry("claude", "anthropic", true),
        entry("claude-no-cache", "anthropic", false),
        entry("gpt", "openai", true),
      ],
    }),
    models: factory,
    credentials: {
      workspaceKey: async () => "key",
      platformKey: async () => undefined,
      platformKeysAllowed: async () => false,
    },
    onUsage: async () => {},
    sleep: async () => {},
    random: () => 0.5,
  });
  return { llm, prompts };
}

const SYSTEM = "You are the reasoning step of a conversational assistant.\n\nInstructions for مساعد النور: …";

async function send(llm: ReturnType<typeof setup>["llm"], model: string) {
  const handle = llm.stream({
    model,
    system: SYSTEM,
    messages: [
      { role: "user", content: "طلبي 5678 فين؟" },
      { role: "assistant", content: "ثواني أشوفلك" },
      { role: "user", content: '<data source="variables">\n…\n</data>' },
    ],
    purpose: "autonomy",
    context: { workspaceId: "ws_01m7a256m0a13warwhczsjhx9b", mode: "eval" },
  });
  for await (const _ of handle.textStream) {
    /* drain */
  }
  await handle.result;
}

describe("prompt caching", () => {
  test("Anthropic: the system text carries a cache breakpoint, and nothing else does", async () => {
    const { llm, prompts } = setup();
    await send(llm, "claude");
    const prompt = prompts[0] ?? [];
    expect(prompt[0]).toMatchObject({
      role: "system",
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(prompt.filter((m) => m.role === "system")).toHaveLength(1);
    // End-user text stays in user messages, never in the cached system text (CLAUDE.md §9).
    expect(prompt.slice(1).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(prompt.slice(1).some((m) => m.providerOptions?.["anthropic"])).toBe(false);
  });

  test("a model the registry does not mark as caching gets no breakpoint", async () => {
    const { llm, prompts } = setup();
    await send(llm, "claude-no-cache");
    expect(prompts[0]?.[0]).toMatchObject({ role: "system", content: SYSTEM });
    expect(prompts[0]?.[0]?.providerOptions?.["anthropic"]).toBeUndefined();
  });

  test("the real Anthropic provider sends the breakpoint as cache_control on the system block", async () => {
    // No network: a fetch that records the request body and answers 400, so the call fails after
    // the provider has serialised it.
    const bodies: Record<string, unknown>[] = [];
    const capture = async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const llm = createLlm({
      registry: loadRegistry({ models: [entry("claude", "anthropic", true)] }),
      models: {
        language: (model) => createAnthropic({ apiKey: "test-key", fetch: capture as never })(model.providerModel),
        embedding() {
          throw new Error("not used");
        },
      },
      credentials: {
        workspaceKey: async () => "key",
        platformKey: async () => undefined,
        platformKeysAllowed: async () => false,
      },
      onUsage: async () => {},
      sleep: async () => {},
      random: () => 0.5,
    });
    await expect(send(llm, "claude")).rejects.toBeDefined();
    expect(bodies[0]?.["system"]).toEqual([{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }]);
    expect(JSON.stringify(bodies[0]?.["messages"])).not.toContain("cache_control");
  });

  test("OpenAI: the request is unchanged (it caches long prefixes itself)", async () => {
    const { llm, prompts } = setup();
    await send(llm, "gpt");
    expect(prompts[0]?.[0]).toMatchObject({ role: "system", content: SYSTEM });
    expect(prompts[0]?.[0]?.providerOptions?.["anthropic"]).toBeUndefined();
  });
});
