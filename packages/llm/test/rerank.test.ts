import { describe, expect, test } from "vitest";
import { createLlm, type UsageEvent } from "../src/client";
import { loadRegistry } from "../src/registry";

const entry = (provider: "tei" | "cohere") => ({
  id: `rerank-${provider}`,
  provider,
  providerModel: "rerank-fixture",
  kind: "rerank",
  contextWindow: 8192,
  maxOutput: 1,
  capabilities: { vision: false, caching: false, structuredOutput: false },
  prices: null,
  autonomy: "unsupported",
  fallback: [],
});
const request = {
  model: "rerank-tei",
  query: "الأوردر فين؟",
  documents: ["سياسة الاسترجاع", "الطلب خرج للشحن"],
  purpose: "kb_rerank",
  context: { workspaceId: "ws_fixture", mode: "eval" as const },
};

describe("direct rerank adapters", () => {
  test.each(["tei", "cohere"] as const)(
    "%s parses its documented shape, sends original Arabic and meters eval traffic",
    async (provider) => {
      const calls: unknown[] = [],
        events: UsageEvent[] = [];
      const llm = createLlm({
        registry: loadRegistry({ models: [entry(provider)] }),
        credentials: {
          workspaceKey: async () => ({
            apiKey: "secret-canary",
            ...(provider === "tei" ? { baseURL: "https://tei.example.test" } : {}),
          }),
          platformKey: async () => undefined,
          platformKeysAllowed: async () => false,
        },
        onUsage: async (e) => {
          events.push(e);
        },
        rerankFetch: async (r) => {
          calls.push(r);
          return {
            status: 200,
            body:
              provider === "tei"
                ? [
                    { index: 1, score: 0.9 },
                    { index: 0, score: 0.2 },
                  ]
                : {
                    results: [
                      { index: 1, relevance_score: 0.9 },
                      { index: 0, relevance_score: 0.2 },
                    ],
                  },
          };
        },
      });
      const result = await llm.rerank({ ...request, model: `rerank-${provider}` });
      expect(result).toEqual([
        { index: 1, score: 0.9 },
        { index: 0, score: 0.2 },
      ]);
      expect(calls[0]).toMatchObject({ body: { query: request.query }, tenantUrl: provider === "tei" });
      expect(events[0]).toMatchObject({ kind: "rerank_units", rerankUnits: 2, mode: "eval", keySource: "workspace" });
      expect(JSON.stringify(events)).not.toContain("secret-canary");
    },
  );

  test("a tenant-supplied TEI URL requires the egress adapter; default transport never fetches it", async () => {
    const llm = createLlm({
      registry: loadRegistry({ models: [entry("tei")] }),
      credentials: {
        workspaceKey: async () => ({ apiKey: "secret-canary", baseURL: "http://127.0.0.1" }),
        platformKey: async () => undefined,
        platformKeysAllowed: async () => false,
      },
      onUsage: async () => {},
    });
    await expect(llm.rerank(request)).rejects.toMatchObject({ code: "fetch_blocked" });
  });

  test("malformed provider scores fail without being returned or logged", async () => {
    const llm = createLlm({
      registry: loadRegistry({ models: [entry("tei")] }),
      credentials: {
        workspaceKey: async () => ({ apiKey: "secret-canary", baseURL: "https://tei.example.test" }),
        platformKey: async () => undefined,
        platformKeysAllowed: async () => false,
      },
      onUsage: async () => {},
      rerankFetch: async () => ({ status: 200, body: [{ index: 99, score: 1 }] }),
    });
    await expect(llm.rerank(request)).rejects.toMatchObject({ code: "model_unavailable" });
  });
});
