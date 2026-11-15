import type { Json } from "@wakeel/contracts";
import { evalExpressions } from "../expr/evaluate";
import type { ExecutorOf } from "./types";

/**
 * Call workflow: evaluates the inputs and asks the engine to push the sub-workflow. Inputs that
 * give `undefined` are left out, so a required one is reported as missing by the engine. The
 * engine maps the outputs back to `card.outputs` when the sub-workflow returns.
 */
export const callWorkflow: ExecutorOf<"call_workflow"> = async (ctx) => {
  const names = Object.keys(ctx.card.inputs);
  const results = await evalExpressions(Object.values(ctx.card.inputs), ctx.scopes, ctx.sandbox);
  const inputs: Record<string, Json> = {};
  for (const [i, name] of names.entries()) {
    const result = results[i];
    if (!result?.ok) throw result?.error;
    if (result.value !== undefined) inputs[name] = result.value;
  }
  return {
    outcome: { type: "call", workflowId: ctx.card.workflowId, inputs, outputs: ctx.card.outputs },
  };
};
