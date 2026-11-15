import { describe, expect, test } from "vitest";
import { normalizeDigits, parseReply } from "../../src/cards/capture-parse";

/**
 * Capture validation by kind (build plan 4.3). CLAUDE.md §11: Arabic is a gate, so every kind
 * that reads digits is checked with Arabic-Indic and Persian digits too.
 */

describe("normalizeDigits", () => {
  test("turns Arabic-Indic and Persian digits into ASCII and leaves other text alone", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeDigits("طلب ٤٥١٢٣ ORD-7")).toBe("طلب 45123 ORD-7");
  });
});

type Case = [string, string, unknown];
const ok = (kind: string, raw: string, value: unknown): Case => [kind, raw, value];
const bad = (kind: string, raw: string): Case => [kind, raw, undefined];

const CASES: Case[] = [
  ok("text", "  عايز أعرف طلبي فين  ", "عايز أعرف طلبي فين"),
  bad("text", "   "),
  ok("number", "45123", 45123),
  ok("number", "٤٥١٢٣", 45123),
  ok("number", "۴۵۱۲۳", 45123),
  ok("number", "-١٢٫٥", -12.5),
  ok("number", "12.5", 12.5),
  ok("number", "1,250", 1250),
  ok("number", "١٬٢٥٠٬٠٠٠", 1250000),
  ok("number", " +7 ", 7),
  bad("number", "١٢ جنيه"),
  bad("number", "1,25"),
  bad("number", "abc"),
  bad("number", "1e400"),
  bad("number", ""),
  ok("boolean", "yes", true),
  ok("boolean", "No", false),
  ok("boolean", "true", true),
  ok("boolean", "نعم", true),
  ok("boolean", "أيوه", true),
  ok("boolean", "ايوه", true),
  ok("boolean", "آه", true),
  ok("boolean", "لا", false),
  ok("boolean", "لأ", false),
  bad("boolean", "ممكن"),
  ok("email", " Sara@Example.com ", "Sara@Example.com"),
  bad("email", "sara@"),
  bad("email", "sara example.com"),
  ok("phone", "٠١٠ ١٢٣٤ ٥٦٧٨", "01012345678"),
  ok("phone", "+20 (10) 1234-5678", "+201012345678"),
  ok("phone", "0020 10 1234 5678", "+201012345678"),
  bad("phone", "12"),
  bad("phone", "اتصل بي"),
  bad("phone", "+1234567890123456"),
  ok("date", "2026-11-13", "2026-11-13"),
  ok("date", "13/11/2026", "2026-11-13"),
  ok("date", "١٣/١١/٢٠٢٦", "2026-11-13"),
  ok("date", "3-1-2027", "2027-01-03"),
  ok("date", "13.11.2026", "2026-11-13"),
  bad("date", "31/02/2026"),
  bad("date", "2026-13-01"),
  bad("date", "بكرة"),
];

describe("parseReply", () => {
  test.each(CASES)("%s %j → %j", (kind, raw, value) => {
    const result = parseReply(kind as never, raw, []);
    if (value === undefined) expect(result.ok).toBe(false);
    else expect(result).toEqual({ ok: true, value });
  });

  const options = [
    { label: "الشحن", value: "shipping" },
    { label: "Returns", value: "returns" },
    { label: "الفواتير", value: "billing" },
  ];

  test.each([
    ["shipping", "shipping"],
    ["الشحن", "shipping"],
    ["  returns ", "returns"],
    ["RETURNS", "returns"],
    ["الـفـواتـير", "billing"],
    ["2", "returns"],
    ["٣", "billing"],
  ])("choice %j → %j", (raw, value) => {
    expect(parseReply("choice", raw, options)).toEqual({
      ok: true,
      value,
      index: options.findIndex((o) => o.value === value),
    });
  });

  test.each(["4", "٠", "something else", ""])("choice %j is not an option", (raw) => {
    expect(parseReply("choice", raw, options).ok).toBe(false);
  });
});
