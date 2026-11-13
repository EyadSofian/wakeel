import { ERRORS, type ErrorCode, fill } from "./errors";

/** One field-level problem, as listed in a problem document's `errors` (ADR-012). */
export interface FieldError {
  /** `message.text`, `nodes[3].cards[0].text`; "" for the whole input. */
  path: string;
  code: string;
  message: string;
}

export type ErrorParams = Record<string, string | number>;

/**
 * The one error type the platform throws on purpose (CLAUDE.md §6): a code from `errors.ts` plus
 * the values for its `{placeholders}`. Boundaries (the API, the worker, the trace writer) turn it
 * into a problem document or a span; nothing else writes error sentences.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;

  constructor(
    code: ErrorCode,
    params: ErrorParams = {},
    options: { detail?: string; errors?: FieldError[]; cause?: unknown } = {},
  ) {
    super(fill(ERRORS[code].title, params), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.params = params;
    this.detail = options.detail;
    this.errors = options.errors;
  }

  get status(): number {
    return ERRORS[this.code].status;
  }

  get title(): string {
    return fill(ERRORS[this.code].title, this.params);
  }

  get fix(): string {
    return fill(ERRORS[this.code].fix, this.params);
  }
}

/** Formats a path array the way problem documents show it: `nodes[3].cards[0].text`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out;
}
