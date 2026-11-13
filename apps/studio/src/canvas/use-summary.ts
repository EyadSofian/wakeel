import { useMemo } from "react";
import { useCanvas } from "./context";
import type { SummaryContext } from "./view/summaries";

/**
 * What card summaries need (variables and workflow names) for the open workflow. Keyed on those
 * values only, so moving or editing a node does not hand every node a new context and re-render it.
 */
export function useSummaryContext(): SummaryContext {
  const botVars = useCanvas((s) => s.manifest?.doc.variables);
  const wfVars = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc.variables : undefined));
  const names = useCanvas((s) =>
    Object.values(s.workflows)
      .map((w) => `${w.doc.id}\u0000${w.doc.name}`)
      .join("\u0001"),
  );
  return useMemo<SummaryContext>(
    () => ({
      variables: new Map([...(botVars ?? []), ...(wfVars ?? [])].map((v) => [v.id, v])),
      workflows: new Map(
        names
          .split("\u0001")
          .filter(Boolean)
          .map((entry) => {
            const [id = "", name = ""] = entry.split("\u0000");
            return [id, { name }];
          }),
      ),
    }),
    [botVars, wfVars, names],
  );
}
