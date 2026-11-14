import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  httpParser,
  ocrEstimate,
  type ParserPort,
  type ParserResponse,
  parseCsv,
  parseHtml,
  parseText,
  parseWithParser,
  scoreQuality,
} from "../src/index";

/** Task 8.2, the worker's side: HTML via Readability, text and CSV, the OCR tier and quality. */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseHtml", () => {
  const doc = parseHtml(fixture("article.html"));

  test("keeps the article's headings in order and the title", () => {
    expect(doc.title).toContain("كيف تختار باقة الإنترنت المناسبة");
    const headings = doc.markdown.split("\n").filter((l) => l.startsWith("#"));
    expect(headings).toEqual([
      "# كيف تختار باقة الإنترنت المناسبة",
      "## السرعة المطلوبة",
      "## مقارنة الباقات",
      "### ملاحظات مهمة",
    ]);
  });

  test("keeps the table as a Markdown table with every cell, Arabic and English", () => {
    expect(doc.markdown).toMatch(/\|\s*الباقة\s*\|\s*السرعة\s*\|\s*السعر الشهري\s*\|/);
    expect(doc.markdown).toMatch(/\|\s*العائلية\s*\|\s*100 ميجابت\s*\|\s*450 جنيه\s*\|/);
    expect(doc.markdown).toMatch(/\|\s*Ultra Fiber\s*\|\s*500 Mbps\s*\|\s*900 جنيه\s*\|/);
  });

  test("drops navigation, ads, footer and scripts", () => {
    for (const noise of ["تسجيل الدخول", "إعلان", "جميع الحقوق محفوظة", "tracker"]) {
      expect(doc.markdown).not.toContain(noise);
    }
  });

  test("is marked as from Readability with a clean quality score", () => {
    expect(doc.via).toBe("readability");
    expect(doc.quality.warnings).toEqual([]);
    expect(doc.quality.rtlDisorder).toBe(0);
  });

  test("a page with no article still yields its body text", () => {
    const d = parseHtml("<html><body><p>مرحبا</p></body></html>");
    expect(d.markdown).toContain("مرحبا");
  });
});

describe("parseText", () => {
  test("Markdown keeps its first heading as the title", () => {
    const d = parseText("﻿# الأسئلة الشائعة\r\n\r\nنص", "text/markdown", "faq.md");
    expect(d.title).toBe("الأسئلة الشائعة");
    expect(d.markdown).toBe("# الأسئلة الشائعة\n\nنص");
  });

  test("plain text without a heading is titled by its file name", () => {
    expect(parseText("سطر واحد", "text/plain", "ملاحظات.txt").title).toBe("ملاحظات");
  });

  test("CSV becomes one table; quoted commas, quotes, newlines and pipes survive", () => {
    const d = parseText(
      'المنتج,السعر\n"شاي, أخضر",30\n"قهوة ""تركي""",45\n"سطر\nثاني",1\nA|B,2\n',
      "text/csv",
      "p.csv",
    );
    expect(d.markdown.split("\n")).toEqual([
      "| المنتج | السعر |",
      "| --- | --- |",
      "| شاي, أخضر | 30 |",
      '| قهوة "تركي" | 45 |',
      "| سطر ثاني | 1 |",
      "| A\\|B | 2 |",
    ]);
  });

  test("parseCsv handles ragged rows and blank lines", () => {
    expect(parseCsv("a,b,c\n\n1\n")).toEqual([["a", "b", "c"], ["1"]]);
    expect(parseText("", "text/csv", "e.csv").markdown).toBe("");
  });
});

describe("scoreQuality", () => {
  const prose = "يمكن استرجاع المنتج خلال أربعة عشر يوما من تاريخ الاستلام بشرط أن يكون في عبوته الأصلية. ".repeat(10);

  test("clean Arabic prose scores high with no warnings", () => {
    const q = scoreQuality({ text: prose, pageChars: [700] });
    expect(q.score).toBeGreaterThan(0.9);
    expect(q.warnings).toEqual([]);
  });

  test("presentation forms (visual-order extraction) raise rtl_order", () => {
    const q = scoreQuality({ text: "ﺍﻟﺴﻼﻡ ﻋﻠﻴﻜﻢ ﻭﺭﺣﻤﺔ ﺍﻟﻠﻪ", pageChars: [700] });
    expect(q.rtlDisorder).toBeGreaterThan(0.5);
    expect(q.warnings).toContain("rtl_order");
  });

  test("letters split by spaces raise rtl_order", () => {
    expect(scoreQuality({ text: `م ر ح ب ا ب ك م ${prose}`, pageChars: [700] }).rtlDisorder).toBeGreaterThan(0);
    expect(scoreQuality({ text: "ا ل س ل ا م", pageChars: [700] }).warnings).toContain("rtl_order");
  });

  test("replacement characters and (cid:n) glyphs raise replacement_characters", () => {
    expect(scoreQuality({ text: `${prose}���${"(cid:12)".repeat(20)}`, pageChars: [700] }).warnings).toContain(
      "replacement_characters",
    );
  });

  test("near-empty pages are low_text and score below the warning line", () => {
    const q = scoreQuality({ text: "صفحة", pageChars: [4, 0, 2] });
    expect(q.warnings).toContain("low_text");
    expect(q.score).toBeLessThan(0.9);
  });

  test("Latin text has no RTL disorder; empty text does not divide by zero", () => {
    expect(scoreQuality({ text: "Return within 14 days", pageChars: [] }).rtlDisorder).toBe(0);
    expect(scoreQuality({ text: "", pageChars: [] }).score).toBeGreaterThanOrEqual(0);
  });
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
const response = (pages: ParserResponse["pages"]): ParserResponse => ({
  title: "دليل",
  pageCount: pages.length,
  pages,
  tables: [],
  headings: [],
});

describe("parseWithParser and the OCR tier", () => {
  const fake = (res: ParserResponse): ParserPort => ({ parse: async () => res });
  const input = { body: new Uint8Array([1]), mime: "application/pdf", name: "دليل.pdf" };

  test("image-only pages are replaced by the vision model's text, in page order", async () => {
    const calls: number[] = [];
    const doc = await parseWithParser(input, {
      parser: fake(
        response([
          { number: 1, markdown: "# دليل\n\nصفحة أولى", chars: 600 },
          { number: 2, markdown: "<!-- image -->", chars: 0, image: png },
          { number: 3, markdown: "صفحة ثالثة", chars: 600 },
        ]),
      ),
      ocr: {
        ocrPage: async ({ page, png: bytes }) => {
          calls.push(page);
          expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
          return " إيصال استلام مبلغ ألف جنيه ";
        },
      },
      maxOcrPages: 10,
    });
    expect(calls).toEqual([2]);
    expect(doc.markdown).toBe("# دليل\n\nصفحة أولى\n\nإيصال استلام مبلغ ألف جنيه\n\nصفحة ثالثة");
    expect(doc.pages.map((p) => p.ocr)).toEqual([false, true, false]);
    expect(doc.quality.warnings).toContain("ocr_used");
    expect(doc.via).toBe("docling");
  });

  test("OCR stops at the cap and says so; without an OCR port, pages keep their text", async () => {
    const pages = [1, 2, 3].map((n) => ({ number: n, markdown: "", chars: 0, image: png }));
    let n = 0;
    const doc = await parseWithParser(input, {
      parser: fake(response(pages)),
      ocr: { ocrPage: async () => `نص ${++n}` },
      maxOcrPages: 2,
    });
    expect(n).toBe(2);
    expect(doc.quality.warnings).toEqual(expect.arrayContaining(["ocr_used", "ocr_capped"]));
    expect(ocrEstimate(response(pages), 2)).toEqual({ pages: 2, capped: true });

    const none = await parseWithParser(input, { parser: fake(response(pages)), maxOcrPages: 2 });
    expect(none.pages.every((p) => !p.ocr)).toBe(true);
    expect(none.quality.warnings).toContain("ocr_capped");
  });
});

describe("httpParser", () => {
  test("sends the bytes with the token, type and an encoded name; validates the answer", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const parser = httpParser({
      url: "http://parser:4500",
      token: "t".repeat(32),
      timeoutMs: 1000,
      fetch: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return Response.json(response([{ number: 1, markdown: "نص", chars: 2 }]));
      },
    });
    const res = await parser.parse({ body: new Uint8Array([37, 80]), mime: "application/pdf", name: "دليل.pdf" });
    expect(res.pages[0]?.markdown).toBe("نص");
    expect(seen?.url).toBe("http://parser:4500/v1/parse");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${"t".repeat(32)}`);
    expect(headers["x-file-name"]).toBe(encodeURIComponent("دليل.pdf"));
  });

  test("a parser problem or a network failure is document_parse_failed with the parser's reason", async () => {
    const failing = httpParser({
      url: "http://parser:4500",
      token: "x".repeat(32),
      timeoutMs: 1000,
      fetch: async () => Response.json({ title: "Parsing took too long" }, { status: 504 }),
    });
    await expect(
      failing.parse({ body: new Uint8Array(), mime: "application/pdf", name: "a.pdf" }),
    ).rejects.toMatchObject({
      code: "document_parse_failed",
      detail: "Parsing took too long",
    });
    const down = httpParser({
      url: "http://parser:4500",
      token: "x".repeat(32),
      timeoutMs: 1000,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.parse({ body: new Uint8Array(), mime: "application/pdf", name: "a.pdf" })).rejects.toMatchObject({
      code: "document_parse_failed",
    });
  });

  test("a malformed answer is refused", async () => {
    const bad = httpParser({
      url: "http://p",
      token: "x".repeat(32),
      timeoutMs: 1000,
      fetch: async () => Response.json({}),
    });
    await expect(bad.parse({ body: new Uint8Array(), mime: "application/pdf", name: "a.pdf" })).rejects.toThrow();
  });
});
