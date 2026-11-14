import type { ProtocolIssueCode, ProtocolResult, ResolvedExit } from "./types";

/** What to do after the run block of a reply has finished. */
export type RunPrecedence = { action: "exit"; exit: ResolvedExit } | { action: "iterate"; ignoredExit?: ResolvedExit };

/**
 * Run and exit precedence (architecture §6.2): a run block that returns a value earns another
 * iteration, and any `:::exit` in the same reply is ignored; a run without a return leaves through
 * the exit if there is one. A run with neither a return nor an exit also iterates, because there is
 * no exit to take.
 */
export function afterRun(result: ProtocolResult, run: { returned: boolean }): RunPrecedence {
  if (run.returned) return result.exit ? { action: "iterate", ignoredExit: result.exit } : { action: "iterate" };
  return result.exit ? { action: "exit", exit: result.exit } : { action: "iterate" };
}

const EXIT_ISSUES: ReadonlySet<ProtocolIssueCode> = new Set([
  "exit_name_missing",
  "exit_unknown",
  "exit_data_invalid",
  "exit_data_mismatch",
]);

/** The feedback kind (and trace status) of an issue: a bad exit choice or any other format problem. */
export function issueKind(code: ProtocolIssueCode): "protocol_error" | "exit_invalid" {
  return EXIT_ISSUES.has(code) ? "exit_invalid" : "protocol_error";
}

/**
 * The feedback for the model's next iteration after a rejected reply: what was wrong, where, and
 * which messages from that reply already reached the user so it does not send them twice.
 */
export function feedbackFor(
  result: ProtocolResult,
): { kind: "protocol_error" | "exit_invalid"; text: string } | undefined {
  const issue = result.issue;
  if (!issue) return undefined;
  const parts = [`Your last reply was not accepted. ${issue.message}`];
  if (issue.line !== undefined) parts.push(`The problem is on line ${issue.line} of that reply.`);
  const sent = result.messages.length;
  if (sent === 1) parts.push("1 message from that reply was already sent to the user; do not send it again.");
  if (sent > 1) parts.push(`${sent} messages from that reply were already sent to the user; do not send them again.`);
  return { kind: issue.kind, text: parts.join(" ") };
}
