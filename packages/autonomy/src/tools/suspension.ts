import type { Json } from "@wakeel/contracts";

/**
 * A tool call that ends the run block at the call site (architecture §6.3, ADR-035 §1). It is not
 * an error the model's code may handle: the worker stops the sandbox exec when it sees one, so
 * nothing after the call runs.
 */
export interface PendingToolCall {
  toolId: string;
  name: string;
  /** Absent for a call that waits for `submitToolResult` instead of a workflow. */
  workflowId?: string;
  input: Json;
  toolCallId: string;
}

export class ToolSuspended extends Error {
  readonly pending: PendingToolCall;
  constructor(pending: PendingToolCall) {
    super(`${pending.name} suspended the run block`);
    this.name = "ToolSuspended";
    this.pending = pending;
  }
}

export function isToolSuspended(error: unknown): error is ToolSuspended {
  return error instanceof ToolSuspended;
}

/**
 * The call's id: the run's idempotency key (`turnId:stepSeq:run`) and the tool's name, so a step
 * that runs again asks for the same call (ADR-035 §3). One call can suspend per run block.
 */
export function toolCallIdFor(runKey: string, toolName: string): string {
  return `${runKey}:${toolName}`;
}
