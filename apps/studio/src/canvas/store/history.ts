import type { Workflow } from "@wakeel/contracts";

/**
 * Undo and redo for one workflow document (task 2.3). Documents are immutable, so a history entry
 * is the document before the command; undo swaps it back. Capped so a long session does not grow
 * without bound.
 */
export const HISTORY_LIMIT = 200;

export interface HistoryEntry {
  label: string;
  before: Workflow;
  after: Workflow;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const emptyHistory = (): History => ({ past: [], future: [] });

export function record(h: History, entry: HistoryEntry): History {
  const past = [...h.past, entry];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

export function undo(h: History): { history: History; entry: HistoryEntry } | undefined {
  const entry = h.past.at(-1);
  if (!entry) return undefined;
  return { history: { past: h.past.slice(0, -1), future: [entry, ...h.future] }, entry };
}

export function redo(h: History): { history: History; entry: HistoryEntry } | undefined {
  const entry = h.future[0];
  if (!entry) return undefined;
  return { history: { past: [...h.past, entry], future: h.future.slice(1) }, entry };
}
