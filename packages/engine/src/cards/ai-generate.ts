import type { BotMessagePayload } from "@wakeel/contracts";
import { indexDefinition } from "../definition";
import { writeFor } from "../variables";
import { aiPort, dataBlock, GENERATE_SYSTEM, modelFor } from "./ai-prompts";
import { CardEvaluator } from "./render";
import type { ExecutorOf } from "./types";

/**
 * Generate text (task 6.7): the bot's default model (or the card's) writes text from the rendered
 * instructions and input; it is stored in `into` and, with `send`, also sent to the user.
 */
export const aiGenerate: ExecutorOf<"ai_generate"> = async (ctx) => {
  const { card } = ctx;
  const ai = aiPort(ctx);
  const ev = new CardEvaluator();
  const instructions = ev.template(card.instructions);
  const input = card.input === undefined ? undefined : ev.template(card.input);
  const rendered = await ev.run(ctx.scopes, ctx.sandbox);
  const inputText = input === undefined ? "" : rendered.text(input);
  const content = [`Instructions:\n${rendered.text(instructions)}`];
  if (inputText.trim() !== "") content.push(dataBlock("input", inputText));
  const { text } = await ai.complete({
    purpose: "ai_generate",
    model: modelFor(ctx.definition, card.model, "default"),
    system: GENERATE_SYSTEM,
    messages: [{ role: "user", content: content.join("\n\n") }],
    maxOutputTokens: card.maxOutputTokens,
    turnId: ctx.turnId,
  });
  const reply = text.trim();
  const write = writeFor(indexDefinition(ctx.definition), card.into, reply);
  const messages: BotMessagePayload[] =
    card.send && reply !== "" ? [{ type: "text", text: reply.slice(0, 8_000), format: "markdown" }] : [];
  return { outcome: { type: "next" }, writes: [write], ...(messages.length > 0 ? { messages } : {}) };
};
