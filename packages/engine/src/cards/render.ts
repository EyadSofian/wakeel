import { AppError, BotMessagePayload, type Json, type MessageTemplate } from "@wakeel/contracts";
import { type ExpressionResult, evalExpressions } from "../expr/evaluate";
import type { ExpressionScopes, SandboxPort } from "../expr/sandbox-port";
import { splitTemplate, stringifyValue, type TemplatePart } from "../expr/template";

/**
 * Collects every template and expression a card needs, then evaluates them together, so a card
 * calls the sandbox at most once (architecture §4.6) and not at all when everything is a path.
 * Failures surface when a slot is read: `template_error` for a template, `expression_error` for an
 * expression.
 */
export class CardEvaluator {
  readonly #templates: { source: string; parts: TemplatePart[] | string }[] = [];
  readonly #expressions: string[] = [];

  /** Registers a template; returns its slot. */
  template(source: string): number {
    const split = splitTemplate(source);
    this.#templates.push({ source, parts: split.ok ? split.parts : split.reason });
    return this.#templates.length - 1;
  }

  /** Registers an expression; returns its slot. */
  expression(source: string): number {
    this.#expressions.push(source);
    return this.#expressions.length - 1;
  }

  async run(scopes: ExpressionScopes, sandbox: SandboxPort): Promise<Evaluated> {
    const placeholders = this.#templates.flatMap((t) =>
      typeof t.parts === "string" ? [] : t.parts.flatMap((p) => (p.kind === "expression" ? [p.source] : [])),
    );
    const results = await evalExpressions([...placeholders, ...this.#expressions], scopes, sandbox);
    return new Evaluated(this.#templates, results.slice(0, placeholders.length), results.slice(placeholders.length));
  }
}

export class Evaluated {
  readonly #texts: (() => string)[];
  readonly #values: ExpressionResult[];

  constructor(
    templates: readonly { source: string; parts: TemplatePart[] | string }[],
    placeholderResults: readonly ExpressionResult[],
    values: ExpressionResult[],
  ) {
    let next = 0;
    this.#texts = templates.map(({ source, parts }) => {
      if (typeof parts === "string") return () => throwTemplate(source, parts);
      const pieces = parts.map((part) => {
        if (part.kind === "text") return () => part.text;
        const result = placeholderResults[next++] as ExpressionResult;
        return () => {
          if (!result.ok) throwTemplate(part.source, String(result.error.params["message"]), result.error);
          return stringifyValue(result.value);
        };
      });
      return () => pieces.map((piece) => piece()).join("");
    });
    this.#values = values;
  }

  /** The filled-in text of a template slot. */
  text(slot: number): string {
    return (this.#texts[slot] as () => string)();
  }

  /** The value of an expression slot; `undefined` when the expression gave `undefined`. */
  value(slot: number): Json | undefined {
    const result = this.#values[slot] as ExpressionResult;
    if (!result.ok) throw result.error;
    return result.value;
  }
}

function throwTemplate(expression: string, detail: string, cause?: unknown): never {
  throw new AppError("template_error", { expression }, cause === undefined ? { detail } : { detail, cause });
}

/** Builds a message from a template once the evaluator has run. Optional texts that render empty are left out. */
type Build = (e: Evaluated) => Record<string, unknown>;

function plan(template: MessageTemplate, ev: CardEvaluator): Build {
  const t = (s: string) => {
    const slot = ev.template(s);
    return (e: Evaluated) => e.text(slot);
  };
  const optional = (key: string, s: string | undefined) => {
    if (s === undefined) return () => ({});
    const get = t(s);
    return (e: Evaluated) => {
      const text = get(e);
      return text === "" ? {} : { [key]: text };
    };
  };
  const option = (o: { label: string; value: string }) => {
    const label = t(o.label);
    const value = t(o.value);
    return (e: Evaluated) => ({ label: label(e), value: value(e) });
  };
  const cardBody = (
    b: Extract<MessageTemplate, { type: "card" }> | Omit<Extract<MessageTemplate, { type: "card" }>, "type">,
  ) => {
    const title = t(b.title);
    const subtitle = optional("subtitle", b.subtitle);
    const imageUrl = optional("imageUrl", b.imageUrl);
    const actions = b.actions.map((a) => {
      const label = t(a.label);
      const value = t(a.value);
      return (e: Evaluated) => ({ type: a.type, label: label(e), value: value(e) });
    });
    return (e: Evaluated) => ({
      title: title(e),
      ...subtitle(e),
      ...imageUrl(e),
      actions: actions.map((a) => a(e)),
    });
  };

  switch (template.type) {
    case "text": {
      const text = t(template.text);
      return (e) => ({ type: "text", text: text(e), format: template.format });
    }
    case "image": {
      const url = t(template.url);
      const alt = optional("alt", template.alt);
      const caption = optional("caption", template.caption);
      return (e) => ({ type: "image", url: url(e), ...alt(e), ...caption(e) });
    }
    case "file": {
      const url = t(template.url);
      const name = t(template.name);
      return (e) => ({ type: "file", url: url(e), name: name(e), ...(template.mime ? { mime: template.mime } : {}) });
    }
    case "location": {
      const lat = ev.expression(template.latitude);
      const lng = ev.expression(template.longitude);
      const title = optional("title", template.title);
      const address = optional("address", template.address);
      return (e) => ({
        type: "location",
        latitude: e.value(lat),
        longitude: e.value(lng),
        ...title(e),
        ...address(e),
      });
    }
    case "choice": {
      const text = t(template.text);
      const options = template.options.map(option);
      return (e) => ({ type: "choice", text: text(e), options: options.map((o) => o(e)) });
    }
    case "dropdown": {
      const text = t(template.text);
      const placeholder = optional("placeholder", template.placeholder);
      const options = template.options.map(option);
      return (e) => ({ type: "dropdown", text: text(e), ...placeholder(e), options: options.map((o) => o(e)) });
    }
    case "card": {
      const body = cardBody(template);
      return (e) => ({ type: "card", ...body(e) });
    }
    case "carousel": {
      const items = template.items.map(cardBody);
      return (e) => ({ type: "carousel", items: items.map((i) => i(e)) });
    }
    case "custom": {
      const data = ev.expression(template.data);
      return (e) => ({ type: "custom", name: template.name, data: e.value(data) ?? null });
    }
  }
}

/** Checks a message against the contract; `message_invalid` names the first problem. */
export function checkMessage(raw: unknown): BotMessagePayload {
  const parsed = BotMessagePayload.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") || "the message";
  throw new AppError("message_invalid", { reason: `${path}: ${issue?.message ?? "it is not valid"}` });
}

/**
 * Renders message templates (Say, Capture prompts and retries) with one evaluation, and checks each
 * result against `BotMessagePayload`.
 */
export async function renderMessages(
  templates: readonly MessageTemplate[],
  scopes: ExpressionScopes,
  sandbox: SandboxPort,
): Promise<BotMessagePayload[]> {
  const ev = new CardEvaluator();
  const builds = templates.map((m) => plan(m, ev));
  const evaluated = await ev.run(scopes, sandbox);
  return builds.map((build) => checkMessage(build(evaluated)));
}

/** A plain text message template from a template string (retry and validation messages). */
export const textTemplate = (text: string): MessageTemplate => ({ type: "text", text, format: "markdown" });
