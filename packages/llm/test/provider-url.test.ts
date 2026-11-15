import { describe, expect, test } from "vitest";
import { aiSdkModels } from "../src/adapters";
import { ModelEntry } from "../src/registry";

const model = ModelEntry.parse({
  id: "private-fixture",
  provider: "openai-compatible",
  providerModel: "fixture",
  kind: "embedding",
  contextWindow: 8192,
  maxOutput: 1,
  capabilities: { vision: false, caching: false, structuredOutput: false },
  prices: null,
  autonomy: "unsupported",
  fallback: [],
});

describe("tenant provider addresses", () => {
  test("the SDK must not silently fetch a workspace's URL outside egress", () => {
    expect(() =>
      aiSdkModels.embedding(model, {
        apiKey: "fixture-canary",
        baseURL: "https://provider.example.test/v1",
        source: "workspace",
      }),
    ).toThrow(expect.objectContaining({ code: "fetch_blocked" }));
  });
});
