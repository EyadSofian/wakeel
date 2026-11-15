import { describe, expect, test } from "vitest";
import { corpus, queries } from "../evals/corpus";
import { evaluateRankings, scoreRanking } from "../evals/metrics";

describe("retrieval golden-set integrity", () => {
  test("four sets have 60 distinct authored questions over one synthetic corpus", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(240);
    const keys = new Set(corpus.map((d) => d.key));
    expect(keys.size).toBe(corpus.length);
    for (const locale of ["msa", "egyptian", "gulf", "code-switched"]) {
      const set = queries.filter((q) => q.locale === locale);
      expect(set).toHaveLength(60);
      expect(new Set(set.map((q) => q.query)).size).toBe(60);
      for (const q of set) expect(q.relevant.every((key) => keys.has(key))).toBe(true);
    }
  });
  test("recall deduplicates results and MRR uses the first relevant rank", () => {
    expect(scoreRanking(["x", "a", "a", "y", "z", "w", "b"], ["a", "b"])).toEqual({ recallAt5: 0.5, mrr: 0.5 });
    expect(scoreRanking([], ["a"])).toEqual({ recallAt5: 0, mrr: 0 });
  });
  test("a failed dialect cannot be hidden in the aggregate", () => {
    const rows = [
      { locale: "msa", query: "أين السياسة؟", relevant: ["a"], dense: ["x"], hybrid: ["a"] },
      { locale: "gulf", query: "وين السياسة؟", relevant: ["b"], dense: ["b"], hybrid: ["x"] },
    ];
    const result = evaluateRankings(rows);
    expect(result.passed).toBe(false);
    expect(result.sets.find((s) => s.locale === "msa")?.passed).toBe(true);
    expect(result.sets.find((s) => s.locale === "gulf")?.passed).toBe(false);
  });
});
