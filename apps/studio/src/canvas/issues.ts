import type { BotDefinition, DefinitionIssue } from "@wakeel/contracts";
import { useEffect, useRef, useState } from "react";
import { useCanvas } from "./context";

/** Issues grouped for drawing: per node, the worst issue of the node and of each card. */
export interface NodeIssues {
  node?: { severity: "error" | "warning"; message: string };
  cards: Map<string, { severity: "error" | "warning"; message: string }>;
}

const worse = (a: "error" | "warning" | undefined, b: "error" | "warning") => (a === "error" ? a : b);

export function groupIssues(
  issues: readonly DefinitionIssue[],
  workflowId: string | undefined,
): Map<string, NodeIssues> {
  const out = new Map<string, NodeIssues>();
  for (const i of issues) {
    if (i.workflowId !== workflowId || !i.nodeId) continue;
    const entry: NodeIssues = out.get(i.nodeId) ?? { cards: new Map() };
    if (i.cardId) {
      const prev = entry.cards.get(i.cardId);
      if (!prev || prev.severity === "warning")
        entry.cards.set(i.cardId, { severity: worse(prev?.severity, i.severity), message: i.message });
    } else if (!entry.node || entry.node.severity === "warning") {
      entry.node = { severity: worse(entry.node?.severity, i.severity), message: i.message };
    }
    out.set(i.nodeId, entry);
  }
  return out;
}

const DEBOUNCE_MS = 150;

/**
 * Validates the whole draft in a web worker 150 ms after the last change and returns every issue,
 * or undefined until the first result arrives. Results from an older draft are dropped.
 */
export function useIssues(): DefinitionIssue[] | undefined {
  const manifest = useCanvas((s) => s.manifest?.doc);
  const workflows = useCanvas((s) => s.workflows);
  const [issues, setIssues] = useState<DefinitionIssue[]>();
  // Created in an effect, not a memo: StrictMode runs cleanups once in development, and a memoised
  // worker would be terminated and then reused dead.
  const [worker, setWorker] = useState<Worker>();
  const requests = useRef(0);
  useEffect(() => {
    if (typeof Worker === "undefined") return;
    const w = new Worker(new URL("./validate.worker.ts", import.meta.url), { type: "module" });
    setWorker(w);
    return () => w.terminate();
  }, []);

  useEffect(() => {
    if (!manifest || !worker) return;
    let latest = 0;
    const next = () => ++requests.current;
    const onMessage = (e: MessageEvent<{ id: number; issues: DefinitionIssue[] }>) => {
      if (e.data.id === latest) setIssues(e.data.issues);
    };
    worker.addEventListener("message", onMessage);
    const timer = setTimeout(() => {
      latest = next();
      const definition: BotDefinition = {
        schemaVersion: 1,
        manifest,
        workflows: Object.values(workflows).map((w) => w.doc),
      };
      worker.postMessage({ id: latest, definition });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
    };
  }, [manifest, workflows, worker]);

  return issues;
}
