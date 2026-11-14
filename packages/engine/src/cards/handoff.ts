import type { Json } from "@wakeel/contracts";
import type { StepLog } from "../ports";
import { CardEvaluator, renderMessages } from "./render";
import type { ExecutorOf } from "./types";

/**
 * Handoff (architecture §9.4, task 5.4): sends its optional message, then hands the conversation to
 * a human through the bridge with `handoff.requested { reason, summary, variables }`. The engine
 * sets `handed_off` and stays silent until the bridge releases it.
 *
 * `variables` carries the included variables by name, as the human agent's tools see them. The
 * summary comes from the summarizer port; if it fails, the handoff still happens with an empty
 * summary and the failure is logged on the step (and so in the trace).
 */
export const handoff: ExecutorOf<"handoff"> = async (ctx) => {
  const ev = new CardEvaluator();
  const reason = ev.template(ctx.card.reason);
  const evaluated = await ev.run(ctx.scopes, ctx.sandbox);
  const renderedReason = evaluated.text(reason);
  const messages = ctx.card.message ? await renderMessages([ctx.card.message], ctx.scopes, ctx.sandbox) : [];

  const variables: Record<string, Json> = {};
  for (const id of ctx.card.include) {
    const found = findVariable(ctx.definition, id);
    if (!found) continue;
    const scope = ctx.scopes[found.scope];
    const value =
      scope && typeof scope === "object" && !Array.isArray(scope)
        ? (scope as Record<string, Json>)[found.name]
        : undefined;
    variables[found.name] = value === undefined ? null : value;
  }

  const logs: StepLog[] = [];
  let summary = "";
  if (ctx.card.summary === "auto") {
    try {
      summary = await ctx.summarizeHandoff(renderedReason);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logs.push({ level: "warn", message: `The handoff summary could not be written: ${detail}` });
    }
  }

  return {
    outcome: { type: "handoff", reason: renderedReason, summary, variables },
    ...(messages.length > 0 ? { messages } : {}),
    ...(logs.length > 0 ? { logs } : {}),
  };
};

/** A variable by id, from the bot's manifest or any workflow's own variables. */
function findVariable(
  definition: Parameters<ExecutorOf<"handoff">>[0]["definition"],
  id: string,
): { name: string; scope: "bot" | "user" | "conversation" | "workflow" } | undefined {
  const global = definition.manifest.variables.find((v) => v.id === id);
  if (global) return { name: global.name, scope: global.scope };
  for (const workflow of definition.workflows) {
    const local = workflow.variables?.find((v) => v.id === id);
    if (local) return { name: local.name, scope: "workflow" };
  }
  return undefined;
}
