/**
 * Arabic normaliser and light stemmer for the lexical leg of knowledge-base search (build plan 8.3;
 * architecture §8.1 Normalise and §8.2 step 2; ADR-007 decision 2).
 *
 * The `lex` column is `to_tsvector('simple', …)` over the tokens this module produces, and the
 * lexical query is built from the same tokens. Postgres never applies its own Arabic analysis, so
 * index and query cannot drift as long as both sides call `lexicalTokens` (CLAUDE.md §11). Any
 * change to the output here changes stored lexemes: rows indexed before the change must be
 * re-indexed.
 *
 * Original text is kept for display and embedding; nothing here is shown to a user.
 */

/**
 * Tashkeel (harakat, tanween, shadda, sukun), the dagger alef and Quranic annotation marks.
 * Hamza and madda marks that NFKC could not compose with their letter are stray and go too.
 */
const ARABIC_MARKS =
  /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u08D3-\u08E1\u08E3-\u08FF]/g;

const TATWEEL = /\u0640/g;

/** Zero-width joiners and non-joiners, bidi marks and isolates, the BOM, soft hyphens and the like. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/** Alef with hamza above or below, with madda, wasla and wavy hamza: all become bare alef. */
const ALEF_FORMS = /[\u0622\u0623\u0625\u0671\u0672\u0673]/g;

const LETTER_FOLDS: Readonly<Record<string, string>> = {
  "\u0649": "\u064A", // ى alef maqsura → ي
  "\u06CC": "\u064A", // ی Persian ya → ي
  "\u06A9": "\u0643", // ک Persian kaf → ك
  "\u0629": "\u0647", // ة ta marbuta → ه
  "\u066B": ".", // ٫ Arabic decimal separator
  "\u066C": ",", // ٬ Arabic thousands separator
};
const LETTER_FOLD_PATTERN = /[\u0649\u06CC\u06A9\u0629\u066B\u066C]/g;

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;
const NON_ASCII_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/**
 * Character-level normalisation: Unicode NFKC; format characters, tashkeel and tatweel removed;
 * alef forms unified; ى and Persian ی to ي, Persian ک to ك; ة to ه; Arabic-Indic and Persian
 * digits to ASCII; Latin lower-cased. Hamza on waw (ؤ), on ya (ئ) and on the line (ء) is kept.
 * Spacing and punctuation are kept, so the result still reads as text.
 */
export function normalizeArabic(text: string): string {
  return text
    .normalize("NFKC")
    .replace(FORMAT_CHARACTERS, "")
    .replace(ARABIC_MARKS, "")
    .replace(TATWEEL, "")
    .replace(ALEF_FORMS, "\u0627")
    .replace(LETTER_FOLD_PATTERN, (ch) => LETTER_FOLDS[ch] ?? ch)
    .replace(NON_ASCII_DIGITS, (d) => {
      const code = d.charCodeAt(0);
      return String(code - (code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_INDIC_ZERO));
    })
    .toLowerCase();
}

const ARABIC_LETTER = /\p{Script=Arabic}/u;

/**
 * Article forms, longest first, with the shortest stem each may leave. The bare article may leave
 * two letters (الام → ام, الدم → دم); the compounds need three, because a two-letter remainder is
 * more often a word that merely starts with them (بالون).
 */
const PREFIXES: readonly (readonly [prefix: string, minStem: number])[] = [
  ["وبال", 3],
  ["وال", 3],
  ["بال", 3],
  ["كال", 3],
  ["فال", 3],
  ["ولل", 3],
  ["لل", 3],
  ["ال", 2],
];

/**
 * Suffixes in two passes, at most one strip each. The first removes an attached pronoun or the
 * feminine ending (ها, ه which also stands for ة, ي); the second an inflection (ات, the sound
 * plurals ون and ين, the nisba ي), so طلباته → طلبات → طلب and عربيه → عربي → عرب. Sound plurals need
 * a four-letter stem: words such as تامين, قانون and يومين are not plurals. ـان is never stripped:
 * far more nouns end in it (مكان, عنوان, رمضان) than duals do.
 */
const PRONOUN_SUFFIXES: readonly (readonly [suffix: string, minStem: number])[] = [
  ["ها", 3],
  ["ه", 3],
  ["ي", 3],
];
const INFLECTION_SUFFIXES: readonly (readonly [suffix: string, minStem: number])[] = [
  ["ات", 3],
  ["ون", 4],
  ["ين", 4],
  ["ي", 3],
];

/**
 * Words the rules would wreck. الله and its proclitic forms would become له ("to him"); اللي, the
 * Egyptian and Gulf relative pronoun, would become لي ("to me").
 */
const PROTECTED: ReadonlyMap<string, string> = new Map([
  ["الله", "الله"],
  ["والله", "الله"],
  ["بالله", "الله"],
  ["فالله", "الله"],
  ["لله", "الله"],
  ["اللي", "اللي"],
]);

/** The article on its own, as in "الـ invoice" or "للـ accounting": never a word by itself. */
const BARE_ARTICLES = new Set(["ال", "لل"]);
/** Article compounds that are also words (بال "mind"): dropped only before a non-Arabic token. */
const DETACHABLE_ARTICLES = new Set(["وال", "بال", "كال", "فال", "ولل", "وبال"]);

function stripOne(word: string, rules: readonly (readonly [string, number])[], at: "start" | "end"): string {
  for (const [affix, minStem] of rules) {
    const matches = at === "start" ? word.startsWith(affix) : word.endsWith(affix);
    if (matches && word.length - affix.length >= minStem) {
      return at === "start" ? word.slice(affix.length) : word.slice(0, word.length - affix.length);
    }
  }
  return word;
}

/**
 * Light stemming of one token that `normalizeArabic` has already produced. Strips at most one
 * article form, then at most one pronoun suffix and one inflection suffix, each only when enough
 * stem is left. A bare و, ب, ك, ف or ل is never stripped, nor are dialect verb prefixes (ه, ح, ب) or
 * the negation ـش: each would merge far more unrelated words than it would join. Tokens that are not
 * Arabic script come back unchanged.
 */
export function stemArabicWord(word: string): string {
  const protectedForm = PROTECTED.get(word);
  if (protectedForm !== undefined) return protectedForm;
  if (!ARABIC_LETTER.test(word)) return word;
  const withoutPrefix = stripOne(word, PREFIXES, "start");
  const withoutPronoun = stripOne(withoutPrefix, PRONOUN_SUFFIXES, "end");
  return stripOne(withoutPronoun, INFLECTION_SUFFIXES, "end");
}

const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu;
/** Splits a run where Arabic script meets anything else: "الinvoice", "رقم45123". */
const SCRIPT_BOUNDARY =
  /(?<=\p{Script=Arabic})(?=[^\p{Script=Arabic}])|(?<=[^\p{Script=Arabic}])(?=\p{Script=Arabic})/u;

function tokenize(normalized: string): string[] {
  return (normalized.match(WORD_RUN) ?? []).flatMap((run) => run.split(SCRIPT_BOUNDARY));
}

/**
 * The lexical tokens of `text`, in order and with repeats, for building `lex` at index time and the
 * lexical query at query time (ADR-007 decision 2). Normalises, splits on anything that is not a
 * letter, mark or digit and where Arabic script meets Latin or digits, drops an article left
 * standing on its own by code-switching ("الـ invoice"), and light-stems each Arabic token.
 * Latin and digits are only normalised; there is no stopword list.
 */
export function lexicalTokens(text: string): string[] {
  const tokens = tokenize(normalizeArabic(text));
  const out: string[] = [];
  for (const [i, token] of tokens.entries()) {
    if (BARE_ARTICLES.has(token)) continue;
    const next = tokens[i + 1];
    if (DETACHABLE_ARTICLES.has(token) && next !== undefined && !ARABIC_LETTER.test(next)) continue;
    out.push(stemArabicWord(token));
  }
  return out;
}

/** What the indexer (build plan 8.4) calls. The same function as `queryTokens`, by construction. */
export const indexTokens: (text: string) => string[] = lexicalTokens;

/** What lexical search (build plan 8.6) calls. The same function as `indexTokens`, by construction. */
export const queryTokens: (text: string) => string[] = lexicalTokens;
