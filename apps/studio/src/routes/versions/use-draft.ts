import { BotDefinition, SCHEMA_VERSION } from "@wakeel/contracts";
import { useMemo } from "react";
import { useCanvas } from "../../canvas/context";

/**
 * The open bot's draft as one definition, parsed so defaults are filled in before a diff (7.4). The
 * draft lives in the bot's canvas store (BotLayout), so this follows unsaved edits too. Undefined
 * until the draft has loaded, or while it does not parse (the Issues panel says why).
 */
export function useDraftDefinition(): BotDefinition | undefined {
  const manifest = useCanvas((s) => s.manifest?.doc);
  const workflows = useCanvas((s) => s.workflows);
  return useMemo(() => {
    if (!manifest) return undefined;
    const main = manifest.mainWorkflowId;
    const list = Object.values(workflows)
      .map((w) => w.doc)
      .sort((a, b) => (a.id === main ? -1 : b.id === main ? 1 : 0));
    const parsed = BotDefinition.safeParse({ schemaVersion: SCHEMA_VERSION, manifest, workflows: list });
    return parsed.success ? parsed.data : undefined;
  }, [manifest, workflows]);
}
