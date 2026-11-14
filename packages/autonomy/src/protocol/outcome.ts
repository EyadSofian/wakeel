import type { ProtocolIssueCode, ProtocolResult, ResolvedExit } from "./types";

export type RunPrecedence = { action: "exit"; exit: ResolvedExit } | { action: "iterate"; ignoredExit?: ResolvedExit };

export function afterRun(_result: ProtocolResult, _run: { returned: boolean }): RunPrecedence {
  throw new Error("not implemented");
}

export function issueKind(_code: ProtocolIssueCode): "protocol_error" | "exit_invalid" {
  throw new Error("not implemented");
}

export function feedbackFor(
  _result: ProtocolResult,
): { kind: "protocol_error" | "exit_invalid"; text: string } | undefined {
  throw new Error("not implemented");
}
