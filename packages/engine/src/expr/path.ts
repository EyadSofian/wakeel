import type { Json } from "@wakeel/contracts";
import { EXPRESSION_ROOTS, type ExpressionRoot, type ExpressionScopes } from "./sandbox-port";

/** One property step of a path: `.name`, `?.name`, `[0]`, `?.[0]`, `["key"]`. */
export interface PathStep {
  key: string | number;
  /** True for `?.`: a null or undefined value here ends the whole chain with `undefined`. */
  optional: boolean;
}

/** An expression that only reads properties, starting at a scope root (architecture §4.6). */
export interface ScopePath {
  root: ExpressionRoot;
  steps: PathStep[];
}

export type PathResolution =
  | { kind: "value"; value: Json | undefined }
  /** Only the interpreter can answer (an inherited name, or a scope that was not passed). */
  | { kind: "defer" }
  /** JavaScript would throw a TypeError; `message` says what it would say. */
  | { kind: "fail"; message: string };

// JavaScript IdentifierName (ECMA-262 §12.7), without escape sequences: those go to the sandbox.
const IDENT = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;
const WHITESPACE = /\s*/y;
// No leading zeros: `[01]` is a legacy octal literal, not index 1.
const INDEX = /0|[1-9][0-9]*/y;
// No escapes and no line breaks, so the text between the quotes is exactly the key.
const STRING_KEY = /"([^"\\\n\r]*)"|'([^'\\\n\r]*)'/y;

/** A tiny scanner over the source; every `read` either consumes a token or leaves `pos` unchanged. */
class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  read(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.text);
    if (match) this.pos = pattern.lastIndex;
    return match;
  }

  skipWhitespace(): void {
    this.read(WHITESPACE);
  }

  eat(literal: string): boolean {
    if (!this.text.startsWith(literal, this.pos)) return false;
    this.pos += literal.length;
    return true;
  }

  get done(): boolean {
    return this.pos >= this.text.length;
  }
}

function readBracketKey(s: Scanner): string | number | null {
  s.skipWhitespace();
  let key: string | number;
  const index = s.read(INDEX);
  if (index) {
    key = Number(index[0]);
    if (!Number.isSafeInteger(key)) return null;
  } else {
    const str = s.read(STRING_KEY);
    if (!str) return null;
    key = str[1] ?? str[2] ?? "";
  }
  s.skipWhitespace();
  return s.eat("]") ? key : null;
}

/**
 * Recognises a pure property path such as `workflow.email`, `user?.attributes?.plan` or
 * `workflow.items[0]["name"]`. Returns `null` for anything else, which then goes to the sandbox.
 * The grammar is deliberately narrow (ADR-018): a false negative costs one sandbox call, while a
 * false positive would give a wrong answer. This only recognises text; it never evaluates it.
 */
export function parsePath(source: string): ScopePath | null {
  const s = new Scanner(source);
  s.skipWhitespace();
  const root = s.read(IDENT)?.[0];
  if (root === undefined || !(EXPRESSION_ROOTS as readonly string[]).includes(root)) return null;
  const steps: PathStep[] = [];
  for (;;) {
    s.skipWhitespace();
    if (s.done) return { root: root as ExpressionRoot, steps };
    const optional = s.eat("?.");
    if (optional) s.skipWhitespace();
    if (s.eat("[")) {
      const key = readBracketKey(s);
      if (key === null) return null;
      steps.push({ key, optional });
      continue;
    }
    if (!optional && !s.eat(".")) return null;
    s.skipWhitespace();
    const name = s.read(IDENT)?.[0];
    if (name === undefined) return null;
    steps.push({ key: name, optional });
  }
}

/**
 * Reads a path from the scopes with JavaScript's semantics for JSON values: own properties
 * (including `length` and indexes of strings and arrays) give their value, missing ones give
 * `undefined`, reading through `null` or `undefined` fails unless the step is optional, and
 * inherited names such as `constructor` defer to the sandbox.
 */
export function resolvePath(path: ScopePath, scopes: ExpressionScopes): PathResolution {
  if (!Object.hasOwn(scopes, path.root)) return { kind: "defer" };
  let current: unknown = scopes[path.root];
  for (const step of path.steps) {
    if (current === null || current === undefined) {
      // `a?.b.c` short-circuits the whole chain when `a` is nullish.
      if (step.optional) return { kind: "value", value: undefined };
      return {
        kind: "fail",
        message: `Cannot read properties of ${current === null ? "null" : "undefined"} (reading '${String(step.key)}')`,
      };
    }
    const key = String(step.key);
    // Boxing gives strings their own `length` and index properties, as property access does.
    const target = Object(current) as Record<string, unknown>;
    if (Object.hasOwn(target, key)) current = target[key];
    else if (key in target) return { kind: "defer" };
    else current = undefined;
  }
  return { kind: "value", value: current as Json | undefined };
}
