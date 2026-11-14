import { LANGUAGE_FIXTURES, SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { describe, expect, test } from "vitest";
import { foldForSearch, fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("foldForSearch", () => {
  test.each([
    ["Refunds", "refunds"],
    ["Café", "cafe"],
    ["السَّلَامُ عَلَيْكُمْ", "السلام عليكم"],
    ["أهلاً بإسلام", "اهلا باسلام"],
    ["مكتبة", "مكتبه"],
    ["مستشفى", "مستشفي"],
    ["مـــرحبا", "مرحبا"],
  ])("%s → %s", (input, folded) => {
    expect(foldForSearch(input)).toBe(folded);
  });

  test("is the same function for the text and the query: every fixture matches itself", () => {
    for (const f of [...SCREENSHOT_FIXTURES, ...LANGUAGE_FIXTURES]) {
      expect(fuzzyScore(f.text, f.text), f.id).toBeGreaterThan(0);
      expect(fuzzyScore(f.text.slice(0, 12), f.text), f.id).toBeGreaterThan(0);
    }
  });
});

describe("fuzzyScore", () => {
  test("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "Anything")).toBe(0);
    expect(fuzzyScore("  ", "Anything")).toBe(0);
  });

  test("characters must appear in order", () => {
    expect(fuzzyScore("zz", "Refunds")).toBeUndefined();
    expect(fuzzyScore("sdnufer", "Refunds")).toBeUndefined();
    expect(fuzzyScore("rfd", "Refunds")).toBeGreaterThan(0);
  });

  test("diacritics and letter forms in the query do not stop a match", () => {
    expect(fuzzyScore("السَّلام", "السلام عليكم")).toBeGreaterThan(0);
    expect(fuzzyScore("اسلام", "بِإسلام")).toBeGreaterThan(0);
    expect(fuzzyScore("ORD-2026", SCREENSHOT_FIXTURES[1]?.text ?? "")).toBeGreaterThan(0);
  });
});

describe("fuzzyFilter", () => {
  const items = ["Partial refund flow", "Refunds", "Rename workflow", "New workflow", "Run workflow"];

  test("a substring at the start beats one later; non-matches are dropped", () => {
    expect(fuzzyFilter(items, "refund", (x) => x)).toEqual(["Refunds", "Partial refund flow"]);
  });

  test("initials find the action", () => {
    expect(fuzzyFilter(items, "nw", (x) => x)[0]).toBe("New workflow");
  });

  test("an empty query keeps the order", () => {
    expect(fuzzyFilter(items, "", (x) => x)).toEqual(items);
  });

  test("Arabic names rank the same way", () => {
    const names = ["إلغاء الطلب", "طلبات الاسترجاع", "متابعة الطلب"];
    expect(fuzzyFilter(names, "طلب", (x) => x)).toEqual(["طلبات الاسترجاع", "إلغاء الطلب", "متابعة الطلب"]);
  });
});
