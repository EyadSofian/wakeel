import type { StepLog } from "../ports";
import { aiPort, CLASSIFY_SYSTEM, dataBlock, modelFor } from "./ai-prompts";
import { CardEvaluator } from "./render";
import type { ExecutorOf } from "./types";

/**
 * AI condition (task 6.7, card.ts `AiBranchCard`): the utility model (or the card's) picks the one
 * branch the rendered input fits, by number. No fit, or an answer that is not an option, continues
 * with the next card; the second is logged as a warning on the step.
 */
export const aiBranch: ExecutorOf<"ai_branch"> = async (ctx) => {
  const { card } = ctx;
  const ev = new CardEvaluator();
  const input = ev.template(card.input);
  const rendered = await ev.run(ctx.scopes, ctx.sandbox);
  const options = card.branches.map((b, i) => `${i + 1}. ${b.label}: ${b.description}`).join("\n");
  const { text } = await aiPort(ctx).complete({
    purpose: "ai_branch",
    model: modelFor(ctx.definition, card.model, "utility"),
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: `Options:\n${options}\n\n${dataBlock("input", rendered.text(input))}` }],
    temperature: 0,
    maxOutputTokens: 8,
    turnId: ctx.turnId,
  });
  const answer = text.trim();
  const chosen = /^\d+$/.test(answer) ? Number(answer) : Number.NaN;
  if (chosen >= 1 && chosen <= card.branches.length) {
    const branch = card.branches[chosen - 1] as (typeof card.branches)[number];
    return { outcome: { type: "goto", port: `branch:${branch.id}` } };
  }
  const logs: StepLog[] =
    chosen === 0
      ? []
      : [{ level: "warn", message: `The model answered "${answer.slice(0, 80)}", which is not an option` }];
  return { outcome: { type: "next" }, ...(logs.length > 0 ? { logs } : {}) };
};
