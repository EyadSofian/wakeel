import { AppError, parseTemplate } from "@wakeel/contracts";
import { type ExpressionResult, evalExpressions } from "./evaluate";
import type { ExpressionScopes, SandboxPort } from "./sandbox-port";

export type TemplatePart = { kind: "text"; text: string } | { kind: "expression"; source: string };
export type SplitTemplateResult = { ok: true; parts: TemplatePart[] } | { ok: false; reason: string };

/**
 * Splits `{{ expression }}` placeholders from the text around them. Syntax is checked by
 * `parseTemplate` from the contracts, the same function publish validation uses, so the engine
 * and the Studio accept exactly the same templates. Text parts are kept byte for byte.
 */
export function splitTemplate(text: string): SplitTemplateResult {
  const parsed = parseTemplate(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  // parseTemplate accepted it, so every {{ has a later }} and none nest.
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open === -1) {
      parts.push({ kind: "text", text: text.slice(i) });
      break;
    }
    if (open > i) parts.push({ kind: "text", text: text.slice(i, open) });
    const close = text.indexOf("}}", open + 2);
    parts.push({ kind: "expression", source: text.slice(open + 2, close).trim() });
    i = close + 2;
  }
  return { ok: true, parts };
}

/**
 * Turns a value into the text a template shows (ADR-018): strings as they are, numbers and
 * booleans with `String`, `null` and `undefined` as nothing, objects and arrays as JSON. Text is
 * never trimmed, reordered or wrapped in direction marks.
 */
export function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function templateError(expression: string, detail: string, cause?: unknown): AppError {
  return new AppError("template_error", { expression }, cause === undefined ? { detail } : { detail, cause });
}

/**
 * Fills in the templates of one card. All placeholders across all the templates are evaluated
 * together, so the sandbox is called at most once (architecture §4.6), and never when every
 * placeholder is a property path. Any failure is a `template_error` naming the placeholder: the
 * message goes in `detail`, and an expression failure is kept as the `cause`.
 */
export async function renderTemplates(
  templates: readonly string[],
  scopes: ExpressionScopes,
  sandbox: SandboxPort,
): Promise<string[]> {
  const split = templates.map((template) => {
    const result = splitTemplate(template);
    if (!result.ok) throw templateError(template, result.reason);
    return result.parts;
  });

  const sources = split.flatMap((parts) => parts.flatMap((part) => (part.kind === "expression" ? [part.source] : [])));
  const results = await evalExpressions(sources, scopes, sandbox);

  let next = 0;
  return split.map((parts) =>
    parts
      .map((part) => {
        if (part.kind === "text") return part.text;
        // evalExpressions returns one result per source, in order.
        const result = results[next++] as ExpressionResult;
        if (!result.ok) throw templateError(part.source, String(result.error.params["message"]), result.error);
        try {
          return stringifyValue(result.value);
        } catch (e) {
          throw templateError(part.source, e instanceof Error ? e.message : String(e), e);
        }
      })
      .join(""),
  );
}

/** Fills in one template. See `renderTemplates`; a card with several fields should use that. */
export async function renderTemplate(
  template: string,
  scopes: ExpressionScopes,
  sandbox: SandboxPort,
): Promise<string> {
  const [text] = await renderTemplates([template], scopes, sandbox);
  return text as string;
}
