import { parseExpressionAt } from "acorn";

/**
 * Parsing for expressions and `{{ }}` templates (architecture §4.6). Parse only, never evaluate:
 * nothing here runs builder text (CLAUDE.md §9). Works in Node and in a browser worker.
 */

/** Scope roots whose properties are checked against declared variables and settings. */
export const CHECKED_ROOTS = ["bot", "user", "conversation", "workflow", "env"] as const;
type Root = (typeof CHECKED_ROOTS)[number];

export interface Reference {
  root: Root;
  name: string;
}

export type ParseResult = { ok: true; refs: Reference[] } | { ok: false; reason: string; line?: number };

const ECMA = 2023;

function shortReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // acorn appends " (line:column)"; the field shows position itself.
  return raw.replace(/\s*\(\d+:\d+\)\s*$/, "");
}

/** Collects `<root>.<name>` member accesses for the checked roots. */
function collectRefs(node: unknown, out: Reference[]): void {
  if (node === null || typeof node !== "object") return;
  const n = node as {
    type?: string;
    object?: { type?: string; name?: string };
    property?: { type?: string; name?: string };
    computed?: boolean;
  };
  if (
    n.type === "MemberExpression" &&
    n.object?.type === "Identifier" &&
    (CHECKED_ROOTS as readonly string[]).includes(n.object.name ?? "") &&
    !n.computed &&
    n.property?.type === "Identifier"
  ) {
    out.push({ root: n.object.name as Root, name: n.property.name ?? "" });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const v of value) collectRefs(v, out);
    else if (value && typeof value === "object") collectRefs(value, out);
  }
}

/** Parses one expression; the whole text must be a single expression. */
export function parseExpression(source: string): ParseResult {
  const text = source.trim();
  if (text === "") return { ok: false, reason: "it is empty" };
  try {
    const ast = parseExpressionAt(text, 0, { ecmaVersion: ECMA });
    if (ast.end !== text.length) return { ok: false, reason: `unexpected text after position ${ast.end + 1}` };
    const refs: Reference[] = [];
    collectRefs(ast, refs);
    return { ok: true, refs };
  } catch (e) {
    return { ok: false, reason: shortReason(e) };
  }
}

/** Parses a template: text with `{{ expression }}` placeholders. */
export function parseTemplate(text: string): ParseResult {
  const refs: Reference[] = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf("{{", i);
    const strayClose = text.indexOf("}}", i);
    if (open === -1) {
      if (strayClose !== -1) return { ok: false, reason: "a }} has no matching {{" };
      return { ok: true, refs };
    }
    if (strayClose !== -1 && strayClose < open) return { ok: false, reason: "a }} has no matching {{" };
    const close = text.indexOf("}}", open + 2);
    if (close === -1) return { ok: false, reason: "a {{ is never closed" };
    const inner = text.slice(open + 2, close);
    if (inner.includes("{{")) return { ok: false, reason: "placeholders cannot be nested" };
    const parsed = parseExpression(inner);
    if (!parsed.ok) return { ok: false, reason: `{{${inner}}} ${parsed.reason}` };
    refs.push(...parsed.refs);
    i = close + 2;
  }
}

/**
 * Checks the syntax of a Run code body. It runs as the body of an async function in the sandbox,
 * so it is parsed wrapped in one; the reported line is the builder's line.
 */
export function parseCodeBody(source: string): ParseResult {
  const wrapped = `(async function (input, ctx) {\n${source}\n})`;
  try {
    const ast = parseExpressionAt(wrapped, 0, { ecmaVersion: ECMA, locations: true });
    const refs: Reference[] = [];
    collectRefs(ast, refs);
    return { ok: true, refs };
  } catch (e) {
    const loc = (e as { loc?: { line: number } }).loc;
    return { ok: false, reason: shortReason(e), ...(loc ? { line: Math.max(1, loc.line - 1) } : {}) };
  }
}
