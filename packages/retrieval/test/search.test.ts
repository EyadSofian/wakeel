import { newId } from "@wakeel/contracts";
import { RTL_FIXTURES } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { queryTokens } from "../src/arabic";
import { createSearch, reciprocalRankFusion, type SearchCandidate } from "../src/search";

const kbId = newId("kb");
const candidate = (text = "سياسة الاسترجاع خلال ١٤ يومًا", score = 1): SearchCandidate => ({
  chunkId: newId("chk"),
  documentId: newId("doc"),
  kbId,
  sourceId: newId("src"),
  language: "ar",
  title: "سياسة متجر النور",
  uri: "https://example.test/policy",
  headingPath: ["الاسترجاع"],
  text,
  score,
  meta: {},
});

describe("reciprocal rank fusion", () => {
  test("adds reciprocal ranks with k=60, deduplicates each leg, and breaks ties by id", () => {
    const a = candidate("أ"),
      b = candidate("ب"),
      c = candidate("ج");
    const fused = reciprocalRankFusion([a, b, b], [b, c]);
    expect(fused.map((r) => r.chunkId)).toEqual([b.chunkId, a.chunkId, c.chunkId]);
    expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(reciprocalRankFusion([a], [c]).map((r) => r.chunkId)).toEqual([a.chunkId, c.chunkId].sort());
  });
});

function setup(options: { minScore?: number; otherModel?: boolean } = {}) {
  const dense = [candidate("سياسة الاسترجاع"), candidate("سياسة الدفع")];
  const lexical = [dense[1] as SearchCandidate];
  const requests: unknown[] = [];
  const spans: unknown[] = [];
  const search = createSearch({
    resolve: async (ids) =>
      ids.map((id, i) => ({
        id,
        embeddingModel: options.otherModel && i ? "other" : "embedding",
        indexVersion: 1,
        minScore: options.minScore,
      })),
    embed: async (model, query) => {
      requests.push({ model, query });
      return Array(1024).fill(0.01);
    },
    candidates: async (input) => {
      requests.push(input);
      return { dense, lexical };
    },
    rerank: async (_query, passages) =>
      passages.map((p, index) => ({ index, score: p.chunkId === dense[0]?.chunkId ? 0.2 : 0.9 })),
    trace: (span) => {
      spans.push(span);
    },
  });
  return { search, dense, requests, spans };
}

describe("architecture §8.2 pipeline", () => {
  test("reranks the fused candidates, applies the score floor and registers persistent citation labels", async () => {
    const s = setup({ minScore: 0.5 });
    const first = await s.search({ query: "إزاي أرجع الأوردر؟", kbIds: [kbId], topK: 5 });
    expect(first.passages).toHaveLength(1);
    expect(first.passages[0]).toMatchObject({ chunkId: s.dense[1]?.chunkId, score: 0.9, cite: "[[c1]]" });
    const second = await s.search({ query: "payment", kbIds: [kbId] }, first.citations);
    expect(second.passages[0]?.cite).toBe("[[c2]]");
    expect(second.citations.sources["c1"]?.chunkId).toBe(s.dense[1]?.chunkId);
    expect(s.spans.at(-1)).toMatchObject({
      returned: 1,
      dense: expect.any(Array),
      lexical: expect.any(Array),
      fused: expect.any(Array),
      reranked: expect.any(Array),
    });
  });

  test.each(RTL_FIXTURES)(
    "uses the shared query normalization for $id while embedding original text",
    async (fixture) => {
      const s = setup();
      await s.search({ query: fixture.text, kbIds: [kbId] });
      expect(s.requests[0]).toEqual({ model: "embedding", query: fixture.text });
      expect(s.requests[1]).toMatchObject({ tokens: queryTokens(fixture.text) });
    },
  );

  test("rejects mixed embedding spaces before any model call", async () => {
    const s = setup({ otherModel: true });
    await expect(s.search({ query: "رجوع", kbIds: [kbId, newId("kb")] })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(s.requests).toHaveLength(0);
  });

  test("never returns a candidate outside the requested knowledge bases", async () => {
    const foreign = candidate();
    foreign.kbId = newId("kb");
    const search = createSearch({
      resolve: async () => [{ id: kbId, embeddingModel: "embedding", indexVersion: 1 }],
      embed: async () => Array(1024).fill(0.01),
      candidates: async () => ({ dense: [foreign], lexical: [] }),
      rerank: async () => [{ index: 0, score: 1 }],
    });
    const result = await search({ query: "policy", kbIds: [kbId] });
    expect(result.passages).toEqual([]);
  });

  test("model failures are visible; dense results are never substituted for a failed reranker", async () => {
    const p = candidate();
    const search = createSearch({
      resolve: async () => [{ id: kbId, embeddingModel: "embedding", indexVersion: 1 }],
      embed: async () => Array(1024).fill(0.01),
      candidates: async () => ({ dense: [p], lexical: [] }),
      rerank: async () => {
        throw new Error("reranker offline");
      },
    });
    await expect(search({ query: "policy", kbIds: [kbId] })).rejects.toThrow("reranker offline");
  });

  test("filters survive the request boundary unchanged", async () => {
    const s = setup();
    const filters = { documentIds: [newId("doc")], sourceIds: [newId("src")], languages: ["ar"] };
    await s.search({ query: "سياسة", kbIds: [kbId], filters });
    expect(s.requests[1]).toMatchObject({ filters });
  });
});

describe("retrieval boundary failures", () => {
  const request = { query: "وين ألقى سياسة refund؟", kbIds: [kbId] };
  const p = candidate();
  const base = {
    resolve: async () => [{ id: kbId, embeddingModel: "embedding", indexVersion: 1 }],
    embed: async () => Array(1024).fill(0.01),
    candidates: async () => ({ dense: [p], lexical: [] }),
    rerank: async () => [{ index: 0, score: 1 }],
  };
  test("missing KB ownership is rejected before a vector is requested", async () => {
    await expect(createSearch({ ...base, resolve: async () => [] })(request)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  test("a KB without an embedding model fails visibly", async () => {
    await expect(
      createSearch({ ...base, resolve: async () => [{ id: kbId, embeddingModel: "", indexVersion: 1 }] })(request),
    ).rejects.toMatchObject({ code: "model_not_configured" });
  });
  test.each([
    [{ index: -1, score: 1 }],
    [{ index: 0.5, score: 1 }],
    [{ index: 0, score: Number.NaN }],
    [
      { index: 0, score: 1 },
      { index: 0, score: 0.5 },
    ],
    [],
  ])("refuses an incomplete or invalid reranker response %#", async (...rows) => {
    await expect(createSearch({ ...base, rerank: async () => rows })(request)).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });
});
