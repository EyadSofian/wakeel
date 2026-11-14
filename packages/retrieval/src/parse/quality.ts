import type { ParseQuality, ParseWarning } from "./types";

/**
 * The parse-quality score (architecture §8.1): text density, replacement-character ratio and an
 * RTL reading-order heuristic. Low scores show a warning on the document; they never block indexing.
 */

/** Characters per page at which density counts as full. A sparse slide deck is below, and fine. */
const FULL_DENSITY_CHARS = 600;
export const LOW_SCORE = 0.6;

const ARABIC_LETTER = /\p{Script=Arabic}/u;
/** Arabic presentation forms: what PDF text layers in visual order produce instead of letters. */
const PRESENTATION_FORM = /[\uFB50-\uFDFF\uFE70-\uFEFF]/u;
/** U+FFFD and private-use code points: glyphs the extractor could not map to characters. */
const REPLACEMENT = /[\uFFFD\uE000-\uF8FF]/u;
const CID = /\(cid:\d+\)/g;

/** Runs of single Arabic letters separated by spaces ("ا ل س ل ا م"): letters split apart. */
const SPLIT_LETTERS = /(?:^|\s)(\p{Script=Arabic}(?:\s\p{Script=Arabic}){3,})(?=\s|$)/gu;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

export function scoreQuality(input: { text: string; pageChars: number[]; ocrPages?: number; ocrCapped?: boolean }) {
  const { text } = input;
  const letters = [...text].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const total = Math.max(1, letters.length);

  const perPage = input.pageChars.length > 0 ? input.pageChars : [letters.length];
  const avg = perPage.reduce((a, b) => a + b, 0) / perPage.length;
  const textDensity = Math.min(1, avg / FULL_DENSITY_CHARS);

  const replacements = [...text].filter((c) => REPLACEMENT.test(c)).length + countMatches(text, CID) * 4;
  const replacementRatio = Math.min(1, replacements / total);

  const arabic = letters.filter((c) => ARABIC_LETTER.test(c)).length;
  let rtlDisorder = 0;
  if (arabic > 0) {
    const forms = [...text].filter((c) => PRESENTATION_FORM.test(c)).length;
    const split = [...text.matchAll(SPLIT_LETTERS)].reduce((n, m) => n + (m[1]?.replace(/\s/g, "").length ?? 0), 0);
    rtlDisorder = Math.min(1, (forms + split) / arabic);
  }

  const score = round(0.4 * textDensity + 0.3 * (1 - Math.min(1, replacementRatio * 10)) + 0.3 * (1 - rtlDisorder));

  const warnings: ParseWarning[] = [];
  if (textDensity < 0.15) warnings.push("low_text");
  if (replacementRatio > 0.02) warnings.push("replacement_characters");
  if (rtlDisorder > 0.1) warnings.push("rtl_order");
  if ((input.ocrPages ?? 0) > 0) warnings.push("ocr_used");
  if (input.ocrCapped) warnings.push("ocr_capped");

  const quality: ParseQuality = {
    score,
    textDensity: round(textDensity),
    replacementRatio: round(replacementRatio),
    rtlDisorder: round(rtlDisorder),
    warnings,
  };
  return quality;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
