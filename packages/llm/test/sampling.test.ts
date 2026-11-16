import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ModelFactory } from "../src/adapters";
import { createLlm } from "../src/client";
import { loadRegistry } from "../src/registry";

/**
 * Some providers reject sampling parameters outright: OpenAI's GPT-6 family answers 400 to any
 * `temperature` other than 1 and to `stop`. The registry records that, and the client leaves the
 * parameters out instead of failing every call (found live, 2026-11-16).
 */

const entry = (id: string, capabilities: Record<string, boolean>) => ({
  id,
  provider: "openai" as const,
  providerModel: id,
  kind: "chat" as const,
  contextWindow: 400_000,
  maxOutput: 128_000,
  capabilities: { vision: false, caching: true, structuredOutput: true, ...capabilities },
  prices: { inputPerMTok: 1, outputPerMTok: 2 },
  autonomy: "untested" as const,
  fallback: [],
});

function setup() {
  const seen: { model: string; temperature?: number; stopSequences?: string[] }[] = [];
  const factory: ModelFactory = {
    language(model) {
      return new MockLanguageModelV4({
        modelId: model.providerModel,
        doStream: async (options) => {
          seen.push({ model: model.id, temperature: options.temperature, stopSequences: options.stopSequences });
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
        entry("classic", {}),
        entry("fixed", { temperature: false, stopSequences: false }),
        entry("no-stop", { stopSequences: false }),
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
  return { llm, seen };
}

const call = (model: string) => ({
  model,
  system: "Fixed system text.",
  messages: [{ role: "user" as const, content: "مرحبا" }],
  stop: [":::end"],
  temperature: 0.3,
  purpose: "test",
  context: { workspaceId: "ws_1", mode: "live" as const },
});

describe("sampling parameters", () => {
  test.each([
    ["classic", 0.3, [":::end"]],
    ["fixed", undefined, undefined],
    ["no-stop", 0.3, undefined],
  ])("%s receives temperature %s and stop %j", async (model, temperature, stopSequences) => {
    const s = setup();
    await s.llm.stream(call(model)).result;
    expect(s.seen).toEqual([{ model, temperature, stopSequences }]);
  });

  test("registry entries without the flags keep sending both parameters", () => {
    const reg = loadRegistry({ models: [entry("classic", {})] });
    expect(reg.get("classic").capabilities).toMatchObject({ temperature: true, stopSequences: true });
  });
});
