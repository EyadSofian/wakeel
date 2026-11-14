import type { Json } from "@wakeel/contracts";

/** Feedback text is trimmed to this many characters (the engine's FEEDBACK_MAX_CHARS). */
const MAX = 4_000;

export type ToolResolution = { outputs: Record<string, Json> } | { result: Json } | { error: string };

/**
 * What the model reads when a suspended tool finishes (architecture §6.3, ADR-035 §4): its result,
 * and that the rest of the block that called it never ran.
 */
export function resumedFeedback(pending: { name: string }, resolution: ToolResolution): string {
  const after = "Code after that call did not run, and the variables it set were not kept.";
  if ("error" in resolution) return `Tool ${pending.name} failed: ${cut(resolution.error)}. ${after}`;
  const value = "outputs" in resolution ? resolution.outputs : resolution.result;
  return `Tool ${pending.name} finished with ${cut(JSON.stringify(value ?? null))}. ${after}`;
}

const cut = (text: string) => (text.length > MAX ? `${text.slice(0, MAX)}… (cut)` : text);
