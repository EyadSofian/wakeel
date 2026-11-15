export interface RankingCase {
  locale: string;
  query: string;
  relevant: readonly string[];
  dense: readonly string[];
  hybrid: readonly string[];
}

/** Recall on five unique results and reciprocal rank in the supplied candidate list (at most 30). */
export function scoreRanking(ranking: readonly string[], relevant: readonly string[]) {
  if (!relevant.length) throw new Error("Every golden question needs at least one relevant passage");
  const unique = [...new Set(ranking)].slice(0, 30);
  const wanted = new Set(relevant);
  const recallAt5 = unique.slice(0, 5).filter((id) => wanted.has(id)).length / wanted.size;
  const first = unique.findIndex((id) => wanted.has(id));
  return { recallAt5, mrr: first < 0 ? 0 : 1 / (first + 1) };
}

/** Every dialect is a separate acceptance gate; an aggregate gain cannot conceal a regression. */
export function evaluateRankings(rows: readonly RankingCase[]) {
  if (!rows.length) throw new Error("No retrieval questions were evaluated");
  const sets = [...new Set(rows.map((r) => r.locale))].map((locale) => {
    const cases = rows.filter((r) => r.locale === locale);
    const mean = (kind: "dense" | "hybrid") => {
      const scores = cases.map((r) => scoreRanking(r[kind], r.relevant));
      return {
        recallAt5: scores.reduce((n, s) => n + s.recallAt5, 0) / cases.length,
        mrr: scores.reduce((n, s) => n + s.mrr, 0) / cases.length,
      };
    };
    const dense = mean("dense"),
      hybrid = mean("hybrid");
    return {
      locale,
      count: cases.length,
      dense,
      hybrid,
      passed: hybrid.recallAt5 > dense.recallAt5 && hybrid.mrr > dense.mrr,
    };
  });
  return { sets, passed: sets.every((s) => s.passed) };
}
