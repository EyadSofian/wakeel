import { describe, expect, test } from "vitest";
import { costMicroUsd, loadRegistry, registry } from "../src/registry";

/** Task 6.1 (ADR-010): the model registry and the cost of one call. */

describe("registry", () => {
  test("the shipped registry is valid and every fallback names a chat model in it", () => {
    for (const m of registry.models()) {
      for (const f of m.fallback) expect(registry.get(f).kind, `${m.id} → ${f}`).toBe("chat");
    }
    expect(registry.get("claude-opus-5-5")).toMatchObject({ provider: "anthropic", contextWindow: 1_000_000 });
  });

  test("an unknown model is model_not_configured, naming it", () => {
    expect(() => registry.get("gpt-nonexistent")).toThrow(expect.objectContaining({ code: "model_not_configured" }));
  });

  test("a registry whose fallback names a missing model is refused when loaded", () => {
    const bad = {
      models: [
        {
          id: "a",
          provider: "anthropic",
          providerModel: "a",
          kind: "chat",
          contextWindow: 1000,
          maxOutput: 100,
          capabilities: { vision: false, caching: false, structuredOutput: false },
          prices: null,
          autonomy: "untested",
          fallback: ["b"],
        },
      ],
    };
    expect(() => loadRegistry(bad)).toThrow(/a falls back to b, which is not in the registry/);
  });
});

describe("costMicroUsd", () => {
  const opus = registry.get("claude-opus-5-5");
  const haiku = registry.get("claude-haiku-5-5");

  test("input, cache reads, cache writes and output each at their own price", () => {
    // 10,000 uncached in at $4, 50,000 cache reads at $0.20, 2,000 cache writes at $5, 1,000 out at $20.
    expect(
      costMicroUsd(opus, {
        inputTokens: 10_000,
        cachedInputTokens: 50_000,
        cacheWriteTokens: 2_000,
        outputTokens: 1_000,
      }),
    ).toBe(40_000 + 10_000 + 10_000 + 20_000);
  });

  test("a model without a cache-read price charges cached reads at the input price", () => {
    // 50,000 cached reads at Haiku's $0.10 input price (under its 100K long-context threshold).
    expect(
      costMicroUsd(haiku, { inputTokens: 0, cachedInputTokens: 50_000, cacheWriteTokens: 0, outputTokens: 0 }),
    ).toBe(5_000);
  });

  test("past the long-context threshold the whole call takes the long-context prices", () => {
    const under = { inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000 };
    const over = { ...under, inputTokens: 100_001 };
    expect(costMicroUsd(haiku, under)).toBe(10_000 + 500);
    expect(costMicroUsd(haiku, over)).toBe(Math.round(100_001 * 0.5) + 2_500);
  });

  test("an unpriced model costs 0", () => {
    const local = loadRegistry({
      models: [
        {
          id: "local",
          provider: "openai-compatible",
          providerModel: "qwen",
          kind: "chat",
          contextWindow: 32000,
          maxOutput: 4000,
          capabilities: { vision: false, caching: false, structuredOutput: false },
          prices: null,
          autonomy: "untested",
          fallback: [],
        },
      ],
    }).get("local");
    expect(
      costMicroUsd(local, { inputTokens: 5000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 500 }),
    ).toBe(0);
  });
});
