import { describe, expect, test } from "vitest";
import {
  CHUNK_DEFAULTS,
  chunkMarkdown,
  EmbeddingDimensionError,
  embedAll,
  embeddingInput,
  estimateTokens,
  fitVector,
  INDEX_DIMS,
  normalizeArabic,
  toIndexRows,
} from "../src/index";

/** Task 8.4: the structure-aware chunker, with Arabic and mixed text. */

const sentence = "يمكن استرجاع المنتج خلال أربعة عشر يوما من تاريخ الاستلام بشرط أن يكون في عبوته الأصلية.";
const para = (n: number) => Array.from({ length: n }, () => sentence).join(" ");

describe("estimateTokens", () => {
  test("Arabic counts more tokens per character than English", () => {
    const ar = estimateTokens("مرحبا بكم في المتجر");
    const en = estimateTokens("hello and welcome to");
    expect(ar).toBeGreaterThan(en);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkMarkdown", () => {
  test("splits on headings and records the heading path, skipping missing levels", () => {
    const md =
      "# الدليل\n\nمقدمة.\n\n## الاسترجاع\n\nخلال ١٤ يومًا.\n\n#### ملاحظة\n\nإلا المخفّض.\n\n## الشحن\n\nيومان.";
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => [c.headingPath, c.text])).toEqual([
      [["الدليل"], "مقدمة."],
      [["الدليل", "الاسترجاع"], "خلال ١٤ يومًا."],
      [["الدليل", "الاسترجاع", "ملاحظة"], "إلا المخفّض."],
      [["الدليل", "الشحن"], "يومان."],
    ]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
  });

  test("keeps a table whole and apart from prose", () => {
    const md = "## الأسعار\n\nقبل الجدول.\n\n| الباقة | السعر |\n| --- | --- |\n| العائلية | 450 جنيه |\n\nبعد الجدول.";
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => c.kind)).toEqual(["text", "table", "text"]);
    expect(chunks[1]?.text).toBe("| الباقة | السعر |\n| --- | --- |\n| العائلية | 450 جنيه |");
  });

  test("a table over the maximum is split by rows with the header repeated on every part", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| منتج رقم ${i + 1} | ${(i + 1) * 25} جنيه | غير متوفر |`);
    const md = ["| المنتج | السعر | الحالة |", "| --- | --- | --- |", ...rows].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.kind).toBe("table");
      expect(c.text.startsWith("| المنتج | السعر | الحالة |\n| --- | --- | --- |")).toBe(true);
      expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxTokens);
    }
    const body = chunks.flatMap((c) => c.text.split("\n").slice(2));
    expect(body).toEqual(rows);
  });

  test("long prose stays near the target, never over the maximum, and overlaps its neighbour", () => {
    const md = `## السياسة\n\n${Array.from({ length: 12 }, () => para(3)).join("\n\n")}`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxTokens);
    const [a, b] = chunks;
    const lastWords = a?.text.split(/\s+/).slice(-5).join(" ") ?? "";
    expect(b?.text).toContain(lastWords);
  });

  test("a single paragraph over the maximum is split by sentence; a single huge sentence by words", () => {
    const huge = `## نص\n\n${para(60)}`;
    for (const c of chunkMarkdown(huge)) expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxTokens);
    const noStops = `## نص\n\n${Array.from({ length: 900 }, () => "كلمة").join(" ")}`;
    const parts = chunkMarkdown(noStops);
    expect(parts.length).toBeGreaterThan(1);
    for (const c of parts) expect(c.tokenCount).toBeLessThanOrEqual(CHUNK_DEFAULTS.maxTokens);
  });

  test("a heading inside a code fence is not a heading; a table row inside one is not a table", () => {
    const md = "## الكود\n\n```\n# not a heading\n| a | b |\n```";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toEqual(["الكود"]);
    expect(chunks[0]?.text).toContain("# not a heading");
  });

  test("text before the first heading has an empty path; empty input has no chunks", () => {
    expect(chunkMarkdown("Intro سطر\n\n# A\n\nb")[0]?.headingPath).toEqual([]);
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("# فقط عنوان")).toEqual([]);
  });

  test("a table without a header separator is split by rows without a header", () => {
    const rows = Array.from({ length: 300 }, (_, i) => `| a${i} | b${i} | c${i} | d${i} |`);
    const chunks = chunkMarkdown(rows.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.text.split("\n"))).toEqual(rows);
  });
});

describe("embeddingInput", () => {
  test("is the heading path, a newline, then the text", () => {
    expect(embeddingInput({ headingPath: ["الدليل", "الشحن"], text: "يومان" })).toBe("الدليل › الشحن\nيومان");
    expect(embeddingInput({ headingPath: [], text: "x" })).toBe("x");
  });
});

describe("embedAll and toIndexRows", () => {
  test("batches, truncates to 1024 and normalises; refuses a model with fewer dimensions", async () => {
    const sizes: number[] = [];
    const v = await embedAll(
      async (values) => {
        sizes.push(values.length);
        return values.map(() => Array.from({ length: 1536 }, () => 2));
      },
      Array.from({ length: 130 }, (_, i) => `نص ${i}`),
    );
    expect(sizes).toEqual([64, 64, 2]);
    expect(v[0]).toHaveLength(INDEX_DIMS);
    expect(Math.hypot(...(v[0] as number[]))).toBeCloseTo(1, 6);
    await expect(embedAll(async (values) => values.map(() => [1, 2, 3]), ["x"])).rejects.toBeInstanceOf(
      EmbeddingDimensionError,
    );
    await expect(embedAll(async () => [], ["x"])).rejects.toThrow("asked for 1 embeddings, got 0");
    expect(fitVector(Array.from({ length: 1024 }, () => 0))).toHaveLength(1024);
  });

  test("index rows carry normalised text and stemmed tokens from the heading path and the text", () => {
    const [row] = toIndexRows(
      [{ ordinal: 0, headingPath: ["سياسة الاسترجاع"], text: "خلال ١٤ يومًا", tokenCount: 5, kind: "text" }],
      [[1]],
    );
    expect(row?.lexTokens.split(" ")).toEqual(expect.arrayContaining(["استرجاع", "14"]));
    expect(row?.textNorm).toBe(normalizeArabic("خلال ١٤ يومًا"));
    expect(row?.meta).toEqual({ kind: "text" });
    expect(() => toIndexRows([], [[1]])).toThrow("one embedding per chunk");
  });
});
