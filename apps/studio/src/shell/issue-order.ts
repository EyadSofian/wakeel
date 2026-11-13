import type { DefinitionIssue, Workflow } from "@wakeel/contracts";
import { CARD_NAMES } from "../canvas/view/summaries";

/**
 * The order the Issues panel lists issues in and `F8` / `⇧F8` step through them (design system
 * §5.16): errors, then warnings, each in the validator's order (workflow, node, card).
 */

export const issueKey = (i: Pick<DefinitionIssue, "code" | "path">) => `${i.code}:${i.path}`;

export function orderIssues(issues: readonly DefinitionIssue[]): DefinitionIssue[] {
  return [...issues.filter((i) => i.severity === "error"), ...issues.filter((i) => i.severity === "warning")];
}

/** Issues `F8` can jump to: those inside a workflow. Bot-level ones are listed but have nowhere to go yet. */
export const canJump = (i: DefinitionIssue): i is DefinitionIssue & { workflowId: string } =>
  i.workflowId !== undefined;

/**
 * The issue after (or before) the one at `key`, wrapping around; the first (or last) when `key` is
 * not in the list any more, for example after it was fixed.
 */
export function stepIssue(
  ordered: readonly DefinitionIssue[],
  key: string | undefined,
  direction: 1 | -1,
): DefinitionIssue | undefined {
  const list = ordered.filter(canJump);
  if (list.length === 0) return undefined;
  const at = key === undefined ? -1 : list.findIndex((i) => issueKey(i) === key);
  if (at < 0) return direction === 1 ? list[0] : list[list.length - 1];
  return list[(at + direction + list.length) % list.length];
}

/** "Main › Greeting › Send message", or "Bot settings" for issues outside every workflow. */
export function issueLocation(issue: DefinitionIssue, workflows: Readonly<Record<string, Workflow>>): string {
  if (issue.workflowId === undefined) return "Bot settings";
  const wf = workflows[issue.workflowId];
  if (!wf) return "A deleted workflow";
  const parts = [wf.name];
  const node = issue.nodeId ? wf.nodes.find((n) => n.id === issue.nodeId) : undefined;
  if (node) parts.push(node.name);
  if (node?.type === "standard" && issue.cardId) {
    const card = node.cards.find((c) => c.id === issue.cardId);
    if (card) parts.push(CARD_NAMES[card.type]);
  }
  return parts.join(" › ");
}
