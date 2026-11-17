import { describe, expect, test } from "vitest";
import { courses } from "../evals/realistic/catalogue";
import { evaluateRealistic, type RealisticRanking, realisticSet } from "../evals/realistic/index";
import { LOCALES, SLICES } from "../evals/realistic/questions";
import { estimateTokens } from "../src/chunk";

/**
 * Task 8.9 (ADR-056): the realistic golden set holds itself to its own rules, so a later edit
 * cannot quietly make it easier or break a label.
 */

const set = realisticSet();

describe("the realistic set", () => {
  test("has 200 questions in the five slices, each spread evenly over the four locales", () => {
    expect(set.questions).toHaveLength(200);
    const expected = { single: 50, "follow-up": 50, table: 40, "near-miss": 30, unanswerable: 30 };
    for (const slice of SLICES) {
      const inSlice = set.questions.filter((q) => q.slice === slice);
      expect(inSlice, slice).toHaveLength(expected[slice]);
      const perLocale = LOCALES.map((l) => inSlice.filter((q) => q.locale === l).length);
      expect(Math.max(...perLocale) - Math.min(...perLocale), `${slice} ${perLocale}`).toBeLessThanOrEqual(1);
    }
  });

  test("every question is asked once", () => {
    const asked = set.questions.map((q) => `${q.history?.user ?? ""}|${q.query}`);
    expect(new Set(asked).size).toBe(asked.length);
    expect(new Set(set.questions.map((q) => q.key)).size).toBe(200);
  });

  test("every answerable question has relevant chunks, all from its own course's page", () => {
    for (const q of set.questions) {
      if (q.slice === "unanswerable") {
        expect(q.relevant, q.key).toEqual([]);
        expect(q.course, q.key).toBeUndefined();
        continue;
      }
      expect(q.relevant.length, q.key).toBeGreaterThan(0);
      for (const key of q.relevant) expect(key.startsWith(`${q.course}#`), `${q.key} → ${key}`).toBe(true);
    }
  });

  test("a follow-up never names its course, so only the conversation can say which one it means", () => {
    for (const q of set.questions.filter((x) => x.slice === "follow-up")) {
      const c = courses.find((x) => x.code === q.course);
      if (!c) throw new Error(q.key);
      expect(q.history, q.key).toBeDefined();
      expect(q.query.includes(c.ar) || q.query.includes(c.en) || q.query.includes(c.code), q.key).toBe(false);
      expect(q.history?.user.includes(c.ar) || q.history?.user.includes(c.en), q.key).toBe(true);
    }
  });

  test("table questions are answered by table chunks; near-miss questions have a look-alike page", () => {
    for (const q of set.questions.filter((x) => x.slice === "table")) {
      const kinds = set.chunks.filter((c) => q.relevant.includes(c.key)).map((c) => c.kind);
      expect(kinds, q.key).toContain("table");
    }
    const nearMiss = set.questions.filter((q) => q.slice === "near-miss");
    expect(new Set(nearMiss.map((q) => q.course)).size).toBe(10);
  });

  test("pages are long and split into several chunks, with tables kept whole", () => {
    for (const c of courses) {
      const chunks = set.chunks.filter((x) => x.page.key === c.code);
      const tokens = chunks.reduce((n, x) => n + estimateTokens(x.text), 0);
      expect(tokens, c.code).toBeGreaterThanOrEqual(900);
      expect(chunks.length, c.code).toBeGreaterThanOrEqual(6);
      expect(chunks.filter((x) => x.kind === "table").length, c.code).toBeGreaterThanOrEqual(3);
    }
  });

  test("the fixture is deterministic", () => {
    expect(realisticSet().fixtureHash).toBe(set.fixtureHash);
  });
});

describe("evaluateRealistic", () => {
  const row = (slice: RealisticRanking["slice"], relevant: string[], hybrid: string[]): RealisticRanking => ({
    key: `${slice}-${hybrid.join()}`,
    slice,
    locale: "egyptian",
    query: "q",
    searched: "q",
    relevant,
    dense: [],
    hybrid,
  });

  test("scores each answerable slice, counts unanswerable questions, and fails a slice under the bar", () => {
    const report = evaluateRealistic([
      row("single", ["A#1"], ["A#1"]),
      row("follow-up", ["A#2"], ["B#1", "B#2", "B#3", "B#4", "B#5", "A#2"]),
      row("table", ["A#3"], ["A#3"]),
      row("near-miss", ["A#4"], ["A#4"]),
      row("unanswerable", [], ["A#1"]),
    ]);
    expect(report.slices.find((s) => s.slice === "single")).toMatchObject({ count: 1, passed: true });
    expect(report.slices.find((s) => s.slice === "follow-up")).toMatchObject({
      count: 1,
      hybrid: { recallAt5: 0, mrr: 1 / 6 },
      passed: false,
    });
    expect(report.unanswerable).toBe(1);
    expect(report.passed).toBe(false);
  });
});
