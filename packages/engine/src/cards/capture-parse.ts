import type { Json } from "@wakeel/contracts";

/**
 * Reading a user's reply as the kind a Capture card asks for (card.ts `CaptureCard`). Users type
 * Arabic-Indic (٠–٩) and Persian (۰–۹) digits as often as ASCII ones (CLAUDE.md §11), so every
 * kind that reads digits normalises them first.
 */

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;

/** Replaces Arabic-Indic and Persian digits with ASCII digits; nothing else changes. */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code - (code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_INDIC_ZERO));
  });
}

export type CaptureKind = "text" | "number" | "boolean" | "email" | "phone" | "date" | "choice";

export type ParsedReply = { ok: true; value: Json; index?: number } | { ok: false };

const INVALID: ParsedReply = { ok: false };

/** Text compared loosely for choices and yes/no: case, width forms, tatweel and spacing ignored. */
function loose(text: string): string {
  return normalizeDigits(text.normalize("NFKC")).replace(/ـ/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const YES = new Set(["yes", "y", "true", "ok", "نعم", "أيوه", "ايوه", "أيوة", "ايوة", "اه", "آه", "أه", "صح", "تمام"]);
const NO = new Set(["no", "n", "false", "لا", "لأ", "لاء", "مش", "كلا"]);

function parseNumber(raw: string): ParsedReply {
  let s = normalizeDigits(raw).trim().replace(/٫/g, ".");
  // Thousands separators (`,` or Arabic `٬`) only in groups of three, so "1,25" is not 125.
  if (/^[+-]?\d{1,3}([,٬]\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/[,٬]/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return INVALID;
  const value = Number(s);
  return Number.isFinite(value) ? { ok: true, value } : INVALID;
}

function parsePhone(raw: string): ParsedReply {
  const s = normalizeDigits(raw).trim();
  if (!/^\+?[\d\s\-().]+$/.test(s)) return INVALID;
  let plus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!plus && digits.startsWith("00")) {
    plus = true;
    digits = digits.slice(2);
  }
  if (digits.length < 7 || digits.length > 15) return INVALID;
  return { ok: true, value: `${plus ? "+" : ""}${digits}` };
}

/** `YYYY-MM-DD`, or day first: `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`. Stored as `YYYY-MM-DD`. */
function parseDate(raw: string): ParsedReply {
  const s = normalizeDigits(raw).trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dayFirst ? [dayFirst[3], dayFirst[2], dayFirst[1]] : [];
  if (!y || !m || !d) return INVALID;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return INVALID;
  return { ok: true, value: `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

/**
 * A choice matches an option by its value, then its label, then its position ("2" or "٢" is the
 * second option). The value stored is the option's value.
 */
function parseChoice(raw: string, options: readonly { label: string; value: string }[]): ParsedReply {
  const reply = loose(raw);
  if (reply === "") return INVALID;
  let index = options.findIndex((o) => loose(o.value) === reply);
  if (index < 0) index = options.findIndex((o) => loose(o.label) === reply);
  if (index < 0 && /^\d+$/.test(reply)) {
    const n = Number(reply);
    if (n >= 1 && n <= options.length) index = n - 1;
  }
  const option = options[index];
  return option ? { ok: true, value: option.value, index } : INVALID;
}

/** Parses a reply as `kind`. `options` are the rendered options of a choice prompt. */
export function parseReply(
  kind: CaptureKind,
  raw: string,
  options: readonly { label: string; value: string }[],
): ParsedReply {
  switch (kind) {
    case "text": {
      const text = raw.trim();
      return text === "" ? INVALID : { ok: true, value: text };
    }
    case "number":
      return parseNumber(raw);
    case "boolean": {
      const word = loose(raw);
      if (YES.has(word)) return { ok: true, value: true };
      if (NO.has(word)) return { ok: true, value: false };
      return INVALID;
    }
    case "email": {
      const email = raw.trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { ok: true, value: email } : INVALID;
    }
    case "phone":
      return parsePhone(raw);
    case "date":
      return parseDate(raw);
    case "choice":
      return parseChoice(raw, options);
  }
}
