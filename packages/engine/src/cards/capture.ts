import {
  AppError,
  type BotMessagePayload,
  type EventScope,
  type Json,
  type MessageTemplate,
  type StepOutcome,
} from "@wakeel/contracts";
import { indexDefinition, type VariableEntry } from "../definition";
import { evalExpressions } from "../expr/evaluate";
import type { ExpressionScopes } from "../expr/sandbox-port";
import type { CardContext } from "../ports";
import { fitsType, writeFor } from "../variables";
import { conditionError } from "./branch";
import { type CaptureKind, parseReply } from "./capture-parse";
import { renderMessages, textTemplate } from "./render";
import type { CardOf, ExecutorOf } from "./types";

type Capture = CardOf<"capture">;

/** The key under `turn` that carries the reply to the card's validate expression. */
const VALUE_KEY = "$value";

/**
 * Capture: asks, waits for the reply, validates it, stores it.
 *
 * - First run: with `skipIfFilled` and a stored value that fits the variable, nothing is asked;
 *   otherwise the prompt is sent and the conversation waits.
 * - On the reply: parse it as `kind`, then check `validate` with the reply as `value`. A valid
 *   reply is stored in `into`; with `routeByOption` the chosen option's port is taken.
 * - An invalid reply sends the validation or retry message and the prompt again, until
 *   `maxRetries` retries are used; then the card fails through its `failed` port.
 */
export const capture: ExecutorOf<"capture"> = async (ctx) => {
  const { card } = ctx;
  if (card.kind === "extract")
    throw new AppError(
      "internal_error",
      { requestId: ctx.turnId },
      { detail: "Capture with extraction arrives with the AI cards." },
    );
  const kind: CaptureKind = card.kind;
  const index = indexDefinition(ctx.definition);
  const entry = index.variable(card.into);
  if (!entry) throw new AppError("variable_not_found", { name: card.into });

  if (!ctx.reply) {
    if (card.skipIfFilled) {
      const stored = storedValue(ctx.scopes, entry);
      if (stored !== undefined && stored !== null && fitsType(stored, entry.variable.type, entry.variable.enumValues)) {
        const outcome = card.routeByOption ? await optionOutcome(ctx, stored) : next;
        return { outcome };
      }
    }
    const [prompt] = await renderMessages([card.prompt], ctx.scopes, ctx.sandbox);
    return { outcome: waitFor(ctx, 0), messages: [prompt as BotMessagePayload] };
  }

  const attempts = ctx.reply.wait.kind === "capture" ? ctx.reply.wait.attempts : 0;
  const raw = replyText(ctx.reply.event);
  const options = kind === "choice" ? await renderedOptions(ctx) : [];
  const parsed =
    raw === undefined
      ? { ok: false as const }
      : parseReply(
          kind,
          raw,
          options.map((o) => o.rendered),
        );

  let valid = parsed.ok;
  let complaint: string | undefined = card.retryMessage;
  if (parsed.ok && card.validate && !(await runValidate(ctx, card.validate.expression, parsed.value))) {
    valid = false;
    complaint = card.validate.message;
  }

  if (parsed.ok && valid) {
    const write = writeFor(index, card.into, parsed.value);
    const option = parsed.index === undefined ? undefined : options[parsed.index];
    const outcome: StepOutcome =
      card.routeByOption && option ? { type: "goto", port: `option:${option.template}` } : next;
    return { outcome, writes: [write] };
  }

  const used = attempts + 1;
  if (used > card.maxRetries)
    throw new AppError(
      "validation_failed",
      {},
      { detail: `The reply was not valid after ${used} ${used === 1 ? "try" : "tries"}.` },
    );
  const templates: MessageTemplate[] = complaint ? [textTemplate(complaint), card.prompt] : [card.prompt];
  const messages = await renderMessages(templates, ctx.scopes, ctx.sandbox);
  return { outcome: waitFor(ctx, used), messages };
};

const next: StepOutcome = { type: "next" };

function waitFor(ctx: CardContext<Capture>, attempts: number): StepOutcome {
  return {
    type: "wait",
    wait: {
      kind: "capture",
      nodeId: ctx.location.nodeId,
      cardId: ctx.card.id,
      attempts,
      since: new Date(ctx.now).toISOString(),
    },
  };
}

/** The text of the reply: a postback's value, or a text message's text. Other messages have none. */
function replyText(event: EventScope): string | undefined {
  const message = event.message;
  if (message?.type === "postback") return message.value;
  if (message?.type === "text") return message.text;
  if (!message && event.text !== "") return event.text;
  return undefined;
}

function storedValue(scopes: ExpressionScopes, entry: VariableEntry): Json | undefined {
  const scope = scopes[entry.variable.scope];
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return undefined;
  return (scope as Record<string, Json>)[entry.variable.name];
}

interface RenderedOption {
  /** The option's value as written on the card; port ids use it (`option:<value>`). */
  template: string;
  rendered: { label: string; value: string };
}

/** The prompt's options, rendered, beside the values the card's ports are named after. */
async function renderedOptions(ctx: CardContext<Capture>): Promise<RenderedOption[]> {
  const prompt = ctx.card.prompt;
  if (prompt.type !== "choice" && prompt.type !== "dropdown") return [];
  const [message] = await renderMessages([prompt], ctx.scopes, ctx.sandbox);
  const rendered = message && "options" in message ? message.options : [];
  return prompt.options.map((o, i) => ({
    template: o.value,
    rendered: rendered[i] ?? { label: o.label, value: o.value },
  }));
}

async function optionOutcome(ctx: CardContext<Capture>, value: Json): Promise<StepOutcome> {
  const option = (await renderedOptions(ctx)).find((o) => o.rendered.value === value);
  return option ? { type: "goto", port: `option:${option.template}` } : next;
}

/**
 * Runs the card's validate expression with the reply bound to `value`. The sandbox installs only
 * the scope objects (§5.2), so the reply travels in `turn` and the expression is wrapped in a
 * function whose parameter is `value`; the builder's own text is unchanged inside it.
 */
async function runValidate(ctx: CardContext<Capture>, expression: string, value: Json): Promise<boolean> {
  const turn = { ...(ctx.scopes.turn as Record<string, Json> | undefined), [VALUE_KEY]: value };
  const wrapped = `((value) => (${expression}))(turn[${JSON.stringify(VALUE_KEY)}])`;
  const [result] = await evalExpressions([wrapped], { ...ctx.scopes, turn }, ctx.sandbox);
  if (!result?.ok) {
    const message = result ? String(result.error.params["message"]) : "it did not run";
    throw new AppError("expression_error", { expression, message });
  }
  if (typeof result.value !== "boolean") throw conditionError(expression, result.value);
  return result.value;
}
