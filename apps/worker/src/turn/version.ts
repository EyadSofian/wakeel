import type { BotDefinition, ConversationState, Json, Variable } from "@wakeel/contracts";
import { fitsType } from "@wakeel/engine";

/** A variable the migration dropped, named as the old definition named it. */
export interface DroppedVariable {
  scope: "conversation" | "user";
  id: string;
  name: string;
}

export interface VersionMigration {
  state: ConversationState;
  userVars: Record<string, Json>;
  /** Every stack position still exists in the new version, so the conversation carries on. */
  positionKept: boolean;
  dropped: DroppedVariable[];
}

/** Whether `wf:node` names a node of the definition. */
function hasNode(def: BotDefinition, workflowId: string, nodeId: string): boolean {
  return def.workflows.some((w) => w.id === workflowId && w.nodes.some((n) => n.id === nodeId));
}

/** Values that still fit a variable of `scope` in the new manifest; the rest are dropped. */
function keepValid(
  values: Record<string, Json>,
  scope: "conversation" | "user",
  next: readonly Variable[],
  previous: readonly Variable[],
  dropped: DroppedVariable[],
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [id, value] of Object.entries(values)) {
    const v = next.find((x) => x.id === id && x.scope === scope);
    if (v && fitsType(value, v.type, v.enumValues)) out[id] = value;
    else dropped.push({ scope, id, name: previous.find((x) => x.id === id)?.name ?? v?.name ?? id });
  }
  return out;
}

/**
 * Moves a conversation to a newly published version (architecture §3.2, task 7.2). When every
 * `(workflowId, nodeId)` on its stack exists in `next`, the conversation carries on where it was.
 * Otherwise the stack, the wait and the autonomy memory are cleared (an idle conversation, unless
 * it is handed off or ended, which it stays), and only conversation and user variables that still
 * validate against `next` are kept. `previous` (the version it ran, when known) names what was dropped.
 */
export function migrateToVersion(input: {
  state: ConversationState;
  userVars: Record<string, Json>;
  next: BotDefinition;
  previous?: BotDefinition;
}): VersionMigration {
  const { state, next } = input;
  const positionKept = state.stack.every((f) => hasNode(next, f.workflowId, f.nodeId));
  if (positionKept) return { state, userVars: input.userVars, positionKept, dropped: [] };

  const dropped: DroppedVariable[] = [];
  const before = input.previous?.manifest.variables ?? [];
  const after = next.manifest.variables;
  const conversationVars = keepValid(state.conversationVars, "conversation", after, before, dropped);
  const userVars = keepValid(input.userVars, "user", after, before, dropped);
  const { wait: _wait, ...rest } = state;
  const keepStatus = state.status === "handed_off" || state.status === "ended";
  return {
    state: { ...rest, status: keepStatus ? state.status : "idle", stack: [], autonomy: {}, conversationVars },
    userVars,
    positionKept,
    dropped,
  };
}
