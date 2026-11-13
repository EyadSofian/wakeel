/**
 * Address (slug) suggestions from a display name. Arabic names are transliterated so an Arabic-only
 * name still gets a usable address instead of an empty, invalid field (CLAUDE.md §11).
 */
const ARABIC: Record<string, string> = {
  ا: "a",
  أ: "a",
  إ: "e",
  آ: "a",
  ٱ: "a",
  ء: "",
  ؤ: "o",
  ئ: "e",
  ب: "b",
  ت: "t",
  ث: "th",
  ج: "g",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "z",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  ة: "a",
  و: "w",
  ي: "y",
  ى: "a",
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
};

const MAX = 48;

/** Lower-case letters, digits and dashes from a name; empty only when nothing is usable. */
export function slugFrom(name: string): string {
  // Harakat, superscript alef and tatweel carry no letter of their own.
  const bare = name.normalize("NFC").replace(/[ً-ٰٟـ]/g, "");
  const latin = Array.from(bare)
    .map((ch) => ARABIC[ch] ?? ch)
    .join("");
  return latin
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/g, "");
}
