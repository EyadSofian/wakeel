import type { DefinitionIndex, TriggerNode } from "./definition";

export interface FoundTrigger {
  workflowId: string;
  node: TriggerNode;
}

/**
 * The Trigger node a custom event starts (architecture §4.4, event table). The workflows on the
 * stack are searched from the top down, then the Main workflow; the first node whose `on.name`
 * equals the event name wins. A workflow on the stack twice is searched once.
 */
export function findEventTrigger(
  index: DefinitionIndex,
  stackWorkflowIds: readonly string[],
  name: string,
): FoundTrigger | undefined {
  const order = [...new Set([...[...stackWorkflowIds].reverse(), index.mainWorkflowId])];
  for (const workflowId of order) {
    const node = index.triggers(workflowId).find((t) => t.on.kind === "event" && t.on.name === name);
    if (node) return { workflowId, node };
  }
  return undefined;
}

/**
 * A Main-workflow trigger for a platform event: `inactivity` (the Trigger node contract says "Main
 * workflow only") or `handoff_released`, which arrives with an empty stack.
 */
export function findMainTrigger(
  index: DefinitionIndex,
  kind: "inactivity" | "handoff_released",
): FoundTrigger | undefined {
  const node = index.triggers(index.mainWorkflowId).find((t) => t.on.kind === kind);
  return node ? { workflowId: index.mainWorkflowId, node } : undefined;
}
