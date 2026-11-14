import type { Json } from "@wakeel/contracts";
import { PROTOCOL_MARK } from "./types";

/**
 * Line-level syntax of protocol v1 (architecture §6.2). Nothing here knows about the node; the
 * validator decides whether a well-formed directive is allowed.
 */

export const KEYWORDS = ["say", "run", "exit", "end"] as const;
export type Keyword = (typeof KEYWORDS)[number];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARK = escapeRegExp(PROTOCOL_MARK);
const KEYWORD = `(${KEYWORDS.join("|")})`;

/** A whole directive line: marker at column 0, a keyword, then nothing or whitespace and arguments. */
const DIRECTIVE = new RegExp(`^${MARK}${KEYWORD}(?:[ \\t]+(.*))?$`);

/**
 * The start of a line that is certainly a directive even before the line is complete: the keyword
 * is followed by a separator, so it cannot grow into another word (`:::end` might become `:::ending`).
 */
const DIRECTIVE_PREFIX = new RegExp(`^${MARK}${KEYWORD}[ \\t]`);

/** A directive written after spaces or bidi marks. Bidi controls are invisible, so they are skipped. */
const LEADING_NOISE = /^[\s‎‏؜‪-‮⁦-⁩﻿]+/;
const DIRECTIVE_ANYWHERE = new RegExp(`^${MARK}${KEYWORD}(?:[ \\t]|$)`);

export type LineKind =
  | { kind: "directive"; keyword: Keyword; args: string }
  /** Starts with the marker at column 0 but is not one of the four directives. */
  | { kind: "unknown_directive" }
  /** Looks like a directive but something precedes the marker. */
  | { kind: "misplaced_directive" }
  | { kind: "text" };

/** Classifies one complete line (without its line ending). */
export function classifyLine(line: string): LineKind {
  if (line.startsWith(PROTOCOL_MARK)) {
    const m = DIRECTIVE.exec(line.trimEnd());
    if (!m) return { kind: "unknown_directive" };
    return { kind: "directive", keyword: m[1] as Keyword, args: (m[2] ?? "").trim() };
  }
  const stripped = line.replace(LEADING_NOISE, "");
  if (stripped !== line && DIRECTIVE_ANYWHERE.test(stripped)) return { kind: "misplaced_directive" };
  return { kind: "text" };
}

/** True when an incomplete line already reads as a directive, so the block before it is complete. */
export function startsDirective(partialLine: string): boolean {
  return DIRECTIVE_PREFIX.test(partialLine);
}

/** Splits `"<word> <rest>"` into the word and the trimmed rest. */
export function splitWord(args: string): { word: string; rest: string } {
  const m = /^(\S+)(?:\s+(.*))?$/.exec(args);
  return m ? { word: m[1] as string, rest: (m[2] ?? "").trim() } : { word: "", rest: "" };
}

/** Body text as the model meant it: no blank lines around it and no trailing whitespace. */
export function bodyText(lines: readonly string[]): string {
  let first = 0;
  while (first < lines.length && (lines[first] as string).trim() === "") first++;
  return lines.slice(first).join("\n").trimEnd();
}

/** `JSON.parse` that reports failure as a value instead of throwing. It parses data; it never runs code. */
export function parseJson(text: string): { ok: true; value: Json } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    return { ok: false };
  }
}

export const isPlainObject = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
