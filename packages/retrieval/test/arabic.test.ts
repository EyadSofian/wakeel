import { RTL_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { describe, expect, test } from "vitest";
import { indexTokens, lexicalTokens, normalizeArabic, queryTokens, stemArabicWord } from "../src/arabic";

/**
 * Build plan 8.3; architecture §8.1 (Normalise) and §8.2 step 2; ADR-007 decision 2; CLAUDE.md §11.
 *
 * Three layers are tested separately so a failure points at one rule:
 * - `normalizeArabic`: character-level folding; keeps spacing and punctuation.
 * - `stemArabicWord`: light stemming of one already-normalised token.
 * - `lexicalTokens`: the whole pipeline; what the `lex` column and the lexical query are built from.
 */

type Case = readonly [input: string, expected: string];

describe("normalizeArabic: alef forms fold to bare alef", () => {
  test.each<Case>([
    ["أحمد", "احمد"],
    ["إسلام", "اسلام"],
    ["آمن", "امن"],
    ["ٱلحمد", "الحمد"],
    ["\u0672", "ا"],
    ["\u0673", "ا"],
    ["سأل", "سال"],
    ["قرأ", "قرا"],
    ["مسألة", "مساله"],
    ["إلى", "الي"],
    // Decomposed hamza and madda marks compose under NFKC, then fold.
    ["ا\u0654", "ا"],
    ["ا\u0655", "ا"],
    ["ا\u0653", "ا"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: hamza on waw and ya, and bare hamza, are kept", () => {
  test.each<Case>([
    ["مسؤول", "مسؤول"],
    ["مسئول", "مسئول"],
    ["شيء", "شيء"],
    ["سماء", "سماء"],
    ["رئيس", "رئيس"],
    ["ي\u0654", "ئ"],
    // A hamza mark that cannot compose with its letter is a stray mark.
    ["ى\u0654", "ي"],
    ["و\u0654", "ؤ"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: alef maqsura and Persian ya and kaf", () => {
  test.each<Case>([
    ["على", "علي"],
    ["مستشفى", "مستشفي"],
    ["امتى", "امتي"],
    ["یوم", "يوم"],
    ["کتاب", "كتاب"],
    ["ی", "ي"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: ta marbuta folds to ha", () => {
  test.each<Case>([
    ["مدرسة", "مدرسه"],
    ["شركة النور", "شركه النور"],
    ["ة", "ه"],
    ["السيارة الجديدة", "السياره الجديده"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: diacritics are stripped", () => {
  test.each<Case>([
    ["كَتَبَ", "كتب"],
    ["مُحَمَّد", "محمد"],
    ["كِتَابٌ", "كتاب"],
    ["شكرًا", "شكرا"],
    ["شكراً", "شكرا"],
    ["مِنْ", "من"],
    ["هٰذا", "هذا"],
    ["الرَّحْمٰنِ", "الرحمن"],
    ["ذَٰلِكَ", "ذلك"],
    ["قال\u06D6", "قال"],
    ["صلى\u0610", "صلي"],
    ["السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللَّهِ وَبَرَكَاتُهُ", "السلام عليكم ورحمه الله وبركاته"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: tatweel is stripped", () => {
  test.each<Case>([
    ["مـــرحبا", "مرحبا"],
    ["الـ", "ال"],
    ["جميـل", "جميل"],
    ["ـ", ""],
    ["الـinvoice", "الinvoice"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: digits become ASCII", () => {
  test.each<Case>([
    ["٠١٢٣٤٥٦٧٨٩", "0123456789"],
    ["۰۱۲۳۴۵۶۷۸۹", "0123456789"],
    ["٢٥٠ جنيه", "250 جنيه"],
    ["١٣/١١/٢٠٢٦", "13/11/2026"],
    ["۴۵", "45"],
    ["１２３", "123"],
    ["ORD-٢٠٢٦", "ord-2026"],
    ["٢٫٥", "2.5"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: Latin is lower-cased and compatibility forms fold", () => {
  test.each<Case>([
    ["Invoice", "invoice"],
    ["HELLO World", "hello world"],
    ["ＡＢＣ", "abc"],
    ["\uFB01le", "file"],
    ["Café", "café"],
    ["ﻻ", "لا"],
    ["\uFDF2", "الله"],
    ["ﻣﺮﺣﺒﺎ", "مرحبا"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: invisible format characters are removed", () => {
  test.each<Case>([
    ["مر\u200Cحبا", "مرحبا"],
    ["مر\u200Dحبا", "مرحبا"],
    ["\u200Fمرحبا\u200E", "مرحبا"],
    ["\u061Cنعم", "نعم"],
    ["\uFEFFhello", "hello"],
    ["in\u00ADvoice", "invoice"],
    ["\u202Bطلب\u202C", "طلب"],
    ["\u2067طلب\u2069", "طلب"],
  ])("%j → %s", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("normalizeArabic: everything else is kept", () => {
  test.each<Case>([
    ["", ""],
    ["مرحبا، كيف حالك؟", "مرحبا، كيف حالك؟"],
    ["a\u00A0b", "a b"],
    ["تم 🎉", "تم 🎉"],
    ["  طلب  ", "  طلب  "],
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });
});

describe("stemArabicWord: definite article", () => {
  test.each<Case>([
    ["الكتاب", "كتاب"],
    ["البيت", "بيت"],
    ["الطلب", "طلب"],
    ["الشمس", "شمس"],
    ["القمر", "قمر"],
    ["الام", "ام"],
    ["الدم", "دم"],
    ["الحين", "حين"],
    // Too short to be article + stem.
    ["ال", "ال"],
    ["الا", "الا"],
    ["الي", "الي"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: article with a proclitic", () => {
  test.each<Case>([
    ["والكتاب", "كتاب"],
    ["بالكتاب", "كتاب"],
    ["كالعاده", "عاد"],
    ["فالموضوع", "موضوع"],
    ["للشركه", "شرك"],
    ["للبيت", "بيت"],
    ["وللطلاب", "طلاب"],
    ["وبالتالي", "تال"],
    ["والمبلغ", "مبلغ"],
    // The stem left after a compound proclitic must be at least three letters.
    ["بالون", "بالون"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: a bare و, ب, ك, ف or ل is not stripped", () => {
  test.each<Case>([
    ["وصل", "وصل"],
    ["وصول", "وصول"],
    ["وزير", "وزير"],
    ["واحد", "واحد"],
    ["وكيل", "وكيل"],
    ["بيت", "بيت"],
    ["كتب", "كتب"],
    ["فهم", "فهم"],
    ["لعب", "لعب"],
    ["بتاريخ", "بتاريخ"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: suffixes", () => {
  test.each<Case>([
    ["كتبها", "كتب"],
    ["طلباتها", "طلب"],
    ["طلباته", "طلب"],
    ["مدرسه", "مدرس"],
    ["مدرسات", "مدرس"],
    ["شركات", "شرك"],
    ["شركه", "شرك"],
    ["موظفون", "موظف"],
    ["موظفين", "موظف"],
    ["موظفيه", "موظف"],
    ["اقتصاديه", "اقتصاد"],
    ["عربي", "عرب"],
    ["عربيه", "عرب"],
    ["كتابي", "كتاب"],
    ["بيته", "بيت"],
    ["سيارات", "سيار"],
    ["سياره", "سيار"],
    ["حسابي", "حساب"],
    ["حسابات", "حساب"],
    ["حسابه", "حساب"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: suffixes are kept when the stem would be too short", () => {
  test.each<Case>([
    ["فيه", "فيه"],
    ["هذه", "هذه"],
    ["منها", "منها"],
    ["علي", "علي"],
    ["دين", "دين"],
    // ـين and ـون need a four-letter stem: these are not sound plurals.
    ["تامين", "تامين"],
    ["بنزين", "بنزين"],
    ["قانون", "قانون"],
    ["زيتون", "زيتون"],
    ["يومين", "يومين"],
    // ـان is not stripped at all: far more nouns end in it than duals do.
    ["مكان", "مكان"],
    ["عنوان", "عنوان"],
    ["رمضان", "رمضان"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: article and suffix together", () => {
  test.each<Case>([
    ["والشركات", "شرك"],
    ["بالسيارات", "سيار"],
    ["المدرسه", "مدرس"],
    ["الموظفين", "موظف"],
    ["الرحمن", "رحمن"],
    ["السلام", "سلام"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: protected words", () => {
  test.each<Case>([
    ["الله", "الله"],
    ["والله", "الله"],
    ["بالله", "الله"],
    ["فالله", "الله"],
    ["لله", "الله"],
    ["اللي", "اللي"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: Egyptian dialect", () => {
  test.each<Case>([
    ["بتاعي", "بتاع"],
    ["بتاعتي", "بتاعت"],
    ["عايزين", "عايز"],
    // Dialect verb prefixes (future ه/ح, habitual ب) and the negation ـش are left alone.
    ["هيوصل", "هيوصل"],
    ["حيوصل", "حيوصل"],
    ["بيشتغل", "بيشتغل"],
    ["ماعرفش", "ماعرفش"],
    ["ازيك", "ازيك"],
    ["اوردرات", "اوردر"],
    ["الاوردر", "اوردر"],
    ["امتي", "امت"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: Gulf dialect", () => {
  test.each<Case>([
    ["شلونك", "شلونك"],
    ["ابي", "ابي"],
    ["وين", "وين"],
    ["طلبي", "طلب"],
    ["زين", "زين"],
    ["الحين", "حين"],
    ["سويت", "سويت"],
    ["اشوفكم", "اشوفكم"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("stemArabicWord: non-Arabic tokens pass through", () => {
  test.each<Case>([
    ["invoice", "invoice"],
    ["2026", "2026"],
    ["x7q9", "x7q9"],
    ["café", "café"],
  ])("%s → %s", (input, expected) => {
    expect(stemArabicWord(input)).toBe(expected);
  });
});

describe("lexicalTokens: tokenising", () => {
  test.each<readonly [string, string[]]>([
    ["", []],
    ["   ", []],
    ["؟!،؛", []],
    ["🎉🙏🏽", []],
    ["ORD-2026-45123", ["ord", "2026", "45123"]],
    [
      "https://track.example.com/orders/45123?lang=ar",
      ["https", "track", "example", "com", "orders", "45123", "lang", "ar"],
    ],
    ["رقم45123", ["رقم", "45123"]],
    ["طلبي:٤٥١٢٣", ["طلب", "45123"]],
    ["iPhone15 الجديد", ["iphone15", "جديد"]],
    // Arabic and Latin letters glued together are two tokens.
    ["الinvoice", ["invoice"]],
    ["مر\u200Cحبا", ["مرحبا"]],
  ])("%j → %j", (input, expected) => {
    expect(lexicalTokens(input)).toEqual(expected);
  });
});

describe("lexicalTokens: a detached article before a non-Arabic word is dropped", () => {
  test.each<readonly [string, string[]]>([
    ["الـ invoice", ["invoice"]],
    ["الـinvoice", ["invoice"]],
    ["للـ accounting", ["accounting"]],
    ["بالـ visa", ["visa"]],
    ["والـ cash", ["cash"]],
    ["ادفع بالـ ٢٠٠", ["ادفع", "200"]],
    // ال and لل are never words, so they go wherever they stand.
    ["الـ طلب", ["طلب"]],
    // بال is a word ("mind") when an Arabic word follows or nothing does.
    ["على بال", ["علي", "بال"]],
  ])("%j → %j", (input, expected) => {
    expect(lexicalTokens(input)).toEqual(expected);
  });
});

describe("lexicalTokens: spelling variants meet on one token", () => {
  test.each<readonly string[]>([
    ["أحمد", "احمد", "إحمد"],
    ["مدرسة", "مدرسه", "المدرسة"],
    ["مُحَمَّد", "محمد", "مـحـمـد"],
    ["على", "علي"],
    ["٢٠٢٦", "2026", "۲۰۲۶"],
    ["Invoice", "INVOICE", "invoice"],
    ["الشركة", "الشركات", "شركه", "للشركة"],
    ["الطلبات", "طلبي", "طلبه", "طلبها"],
    ["الموظفين", "موظفون", "موظف"],
    ["ﻣﺮﺣﺒﺎ", "مرحبا"],
    ["کتاب", "كتاب", "الكتاب", "بالكتاب"],
    ["یوم", "يوم", "اليوم"],
    ["سيارة", "السيارات", "سياره"],
    ["عربية", "العربي", "عربي"],
    ["الإيميل", "ايميل", "الايميل"],
    ["الأوردر", "اوردرات", "أوردر"],
    ["حسابي", "بالحساب", "حساباته"],
  ])("%s", (...variants) => {
    const [first, ...rest] = variants.map((v) => lexicalTokens(v));
    for (const tokens of rest) expect(tokens).toEqual(first);
  });
});

describe("lexicalTokens: the shared RTL and language fixtures", () => {
  const expected: Record<string, string[]> = {
    pure_arabic: ["مرحبا", "بك", "في", "متجر", "نور", "كيف", "اقدر", "اساعدك", "يوم"],
    arabic_product_code: ["طلبك", "رقم", "ord", "2026", "45123", "خرج", "شحن", "وسيصل", "خلال", "يومين"],
    english_arabic_name: [
      "order",
      "confirmed",
      "for",
      "محمد",
      "عبد",
      "رحمن",
      "delivery",
      "tomorrow",
      "before",
      "6",
      "pm",
    ],
    arabic_url: [
      "تقدر",
      "تتابع",
      "شحنتك",
      "من",
      "هنا",
      "https",
      "track",
      "example",
      "com",
      "orders",
      "45123",
      "lang",
      "ar",
      "ثم",
      "اضغط",
      "تحديث",
    ],
    long_token: ["رقم", "مرجع", "x7q9".repeat(30)],
    arabic_diacritics: ["سلام", "عليكم", "ورحم", "الله", "وبرك"],
    emoji: ["تم", "استلام", "طلبك", "شكرا", "لاختيارك", "متجرنا"],
    egyptian: ["ازيك", "عايز", "اعرف", "اوردر", "بتاع", "هيوصل", "امت"],
    gulf: ["شلونك", "ابي", "اعرف", "وين", "وصل", "طلب", "صار", "له", "اسبوع"],
    code_switch: ["ممكن", "تبعتل", "invoice", "علي", "ايميل", "please", "محتاج", "accounting"],
    arabic_indic_digits: ["رقم", "طلب", "45123", "بتاريخ", "13", "11", "2026", "مبلغ", "250", "جني"],
    english_only: ["where", "is", "my", "order", "it", "has", "been", "a", "week"],
  };

  test("every fixture has an expectation", () => {
    expect(Object.keys(expected).sort()).toEqual(RTL_FIXTURES.map((f) => f.id).sort());
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f.text] as const))("%s", (id, text) => {
    expect(lexicalTokens(text)).toEqual(expected[id]);
  });
});

describe("lexicalTokens: output is clean", () => {
  const ALEF_FORMS = /[أإآٱ]/u;
  const MARKS_AND_TATWEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/u;
  const NON_ASCII_DIGITS = /[٠-٩۰-۹]/u;

  test.each(RTL_FIXTURES.map((f) => [f.id, f.text] as const))("%s", (_id, text) => {
    for (const token of lexicalTokens(text)) {
      expect(token).toMatch(/^[\p{L}\p{M}\p{N}]+$/u);
      expect(token).not.toMatch(ALEF_FORMS);
      expect(token).not.toMatch(MARKS_AND_TATWEEL);
      expect(token).not.toMatch(NON_ASCII_DIGITS);
      expect(token).not.toMatch(/[ىةA-Z]/u);
    }
  });
});

/** CLAUDE.md §11 and the 8.3 acceptance: index and query output identical for the same input. */
describe("index and query share one function", () => {
  test("indexTokens and queryTokens are the same function", () => {
    expect(indexTokens).toBe(queryTokens);
    expect(indexTokens).toBe(lexicalTokens);
  });

  const inputs = [
    ...RTL_FIXTURES.map((f) => f.text),
    "السَّلَامُ عَلَيْكُمْ",
    "الـ invoice بتاعي",
    "رقم الطلب ۴۵۱۲۳",
    "شلونك؟ أبي أعرف وين وصل طلبي",
  ];

  test.each(inputs)("%s", (text) => {
    expect(queryTokens(text)).toEqual(indexTokens(text));
  });
});

describe("normalizeArabic is idempotent", () => {
  test.each(RTL_FIXTURES.map((f) => [f.id, f.text] as const))("%s", (_id, text) => {
    const once = normalizeArabic(text);
    expect(normalizeArabic(once)).toBe(once);
  });
});
