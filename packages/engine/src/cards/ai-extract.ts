import { AppError } from "@wakeel/contracts";
import { indexDefinition } from "../definition";
import { writeFor } from "../variables";
import { aiPort, extract, modelFor } from "./ai-prompts";
import { CardEvaluator } from "./render";
import type { ExecutorOf } from "./types";

/**
 * Extract data (task 6.7): the utility model (or the card's) fills the card's JSON Schema from the
 * rendered input. A reply that does not match is retried once; a second miss fails the card with
 * `ai_extraction_invalid` and stores nothing. Empty input stores `null` without a call.
 */
export const aiExtract: ExecutorOf<"ai_extract"> = async (ctx) => {
  const { card } = ctx;
  const ev = new CardEvaluator();
  const input = ev.template(card.input);
  const instructions = card.instructions === undefined ? undefined : ev.template(card.instructions);
  const rendered = await ev.run(ctx.scopes, ctx.sandbox);
  const text = rendered.text(input);
  const index = indexDefinition(ctx.definition);
  if (text.trim() === "") return { outcome: { type: "next" }, writes: [writeFor(index, card.into, null)] };
  const result = await extract(
    aiPort(ctx),
    { purpose: "ai_extract", model: modelFor(ctx.definition, card.model, "utility"), turnId: ctx.turnId },
    {
      schema: card.schema as Record<string, unknown>,
      ...(instructions ? { instructions: rendered.text(instructions) } : {}),
      text,
    },
  );
  if (!result.ok) throw new AppError("ai_extraction_invalid", { message: result.message });
  return { outcome: { type: "next" }, writes: [writeFor(index, card.into, result.value)] };
};
