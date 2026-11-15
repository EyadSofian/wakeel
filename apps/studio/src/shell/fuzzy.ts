/**
 * Fuzzy matching for the command palette (design system §5.15). Builder text is Arabic as often as
 * English (CLAUDE.md §11), so both sides go through the same `foldForSearch` first: case, Latin
 * accents, Arabic diacritics and tatweel, and the letter forms people type interchangeably.
 *
 * The match is a subsequence: every query character appears in order. Matches score higher when
 * they start the text or a word, run together, and come early: "refund" finds "Refunds" before
 * "Partial refund flow", and "nw" finds "New workflow" by its initials.
 */

// Arabic marks (U+0610-061A, U+064B-065F, U+0670, U+06D6-06ED) and tatweel (U+0640).
const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g;
// Combining Latin accents left by NFD.
const LATIN_MARKS = /[\u0300-\u036f]/g;
const LETTERS: Record<string, string> = {
  "\u0622": "\u0627", // آ → ا
  "\u0623": "\u0627", // أ → ا
  "\u0625": "\u0627", // إ → ا
  "\u0671": "\u0627", // ٱ → ا
  "\u0649": "\u064a", // ى → ي
  "\u0629": "\u0647", // ة → ه
  "\u0624": "\u0648", // ؤ → و
  "\u0626": "\u064a", // ئ → ي
};
const LETTER_PATTERN = new RegExp(`[${Object.keys(LETTERS).join("")}]`, "g");

/**
 * The comparable form of a string. Keeps one character per input character where it can, so a
 * position in the folded text is (almost always) the same position in the original.
 */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(LATIN_MARKS, "")
    .replace(ARABIC_MARKS, "")
    .normalize("NFC")
    .replace(LETTER_PATTERN, (c) => LETTERS[c] ?? c)
    .toLowerCase();
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  return /[\s›/._\-:(]/.test(text[i - 1] ?? " ");
};

/**
 * Score of `query` against `text`, higher is better, or undefined when it does not match. An empty
 * query matches everything with score 0. Spaces in the query are ignored, so "go to var" still
 * matches "Variables".
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = foldForSearch(query).replace(/\s+/g, "");
  if (q === "") return 0;
  const t = foldForSearch(text);
  // A plain substring is the strongest signal; rank by where it starts.
  const at = t.indexOf(q);
  if (at >= 0) return 1_000 - Math.min(at, 200) + (isBoundary(t, at) ? 300 : 0) + (at === 0 ? 200 : 0);

  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return undefined;
    run = found === ti && ti > 0 ? run + 1 : 0;
    score += 10 + run * 15 + (isBoundary(t, found) ? 30 : 0) - Math.min(found - ti, 20);
    ti = found + 1;
  }
  return score;
}

/** `items` that match `query`, best first; ties keep their original order. */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
