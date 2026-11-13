import type { BotManifest, Workflow } from "@wakeel/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { type Command, CommandRejected } from "./commands";
import { emptyHistory, type History, record, redo, undo } from "./history";

/**
 * The canvas store (task 2.3, ADR-011): the open bot's draft documents, which workflow is open,
 * what is selected, undo history per workflow, and save state per document. React reads it through
 * `useCanvas`; nothing writes a document except `execute`, `undo`, `redo` and the saver.
 */

export type DocKey = "manifest" | `workflow:${string}`;

export interface DocState<T> {
  kind: "manifest" | "workflow";
  docId: string;
  /** Revision of `saved` on the server. */
  rev: number;
  doc: T;
  /** The last copy the server accepted. `dirty` is `doc !== saved`. */
  saved: T;
  saving: boolean;
  /** The server's copy when a save hit `revision_conflict`; saving stops until it is resolved. */
  conflict?: { rev: number; doc: T };
  /** The last save failure other than a conflict (offline, server error). */
  error?: { title: string; fix: string };
}

export interface Selection {
  nodeIds: string[];
  edgeIds: string[];
  /** A card selected inside one of the selected nodes (opens it in the inspector). */
  card?: { nodeId: string; cardId: string };
}

export interface CanvasState {
  botId: string | undefined;
  manifest: DocState<BotManifest> | undefined;
  workflows: Record<string, DocState<Workflow>>;
  activeWorkflowId: string | undefined;
  selection: Selection;
  history: Record<string, History>;

  load(input: {
    botId: string;
    manifest: { rev: number; doc: BotManifest };
    workflows: { rev: number; doc: Workflow }[];
  }): void;
  open(workflowId: string): void;
  /** Runs a command on a workflow (the open one by default). Rejections leave everything as it was. */
  execute(command: Command, workflowId?: string): { ok: true } | { ok: false; reason: string };
  undo(workflowId?: string): boolean;
  redo(workflowId?: string): boolean;
  select(selection: Partial<Selection>): void;
  clearSelection(): void;
  updateManifest(update: (m: BotManifest) => BotManifest): void;

  // Used by the saver.
  docs(): { key: DocKey; state: DocState<BotManifest | Workflow> }[];
  beginSave(key: DocKey): { rev: number; doc: BotManifest | Workflow } | undefined;
  finishSave(key: DocKey, sent: BotManifest | Workflow, rev: number): void;
  failSave(
    key: DocKey,
    failure: { conflict: { rev: number; doc: unknown } } | { error: { title: string; fix: string } },
  ): void;
  /** `theirs` takes the server copy and drops local changes; `mine` keeps local changes and saves over it. */
  resolveConflict(key: DocKey, keep: "theirs" | "mine"): void;
}

export const isDirty = (d: DocState<unknown>) => d.doc !== d.saved;

const emptySelection = (): Selection => ({ nodeIds: [], edgeIds: [] });

export const workflowKey = (id: string): DocKey => `workflow:${id}`;

function docState<T>(kind: "manifest" | "workflow", docId: string, rev: number, doc: T): DocState<T> {
  return { kind, docId, rev, doc, saved: doc, saving: false };
}

/** Keeps only selected things that still exist after a change. */
function pruneSelection(sel: Selection, wf: Workflow): Selection {
  const nodes = new Set(wf.nodes.map((n) => n.id));
  const edges = new Set(wf.edges.map((e) => e.id));
  const card = sel.card;
  const cardStillThere =
    card !== undefined &&
    wf.nodes.some((n) => n.id === card.nodeId && n.type === "standard" && n.cards.some((c) => c.id === card.cardId));
  return {
    nodeIds: sel.nodeIds.filter((id) => nodes.has(id)),
    edgeIds: sel.edgeIds.filter((id) => edges.has(id)),
    ...(cardStillThere ? { card } : {}),
  };
}

export type CanvasStore = StoreApi<CanvasState>;

export function createCanvasStore(): CanvasStore {
  return createStore<CanvasState>()((set, get) => {
    const setWorkflowDoc = (id: string, doc: Workflow, history: History) => {
      const s = get();
      const current = s.workflows[id];
      if (!current) return;
      set({
        workflows: { ...s.workflows, [id]: { ...current, doc } },
        history: { ...s.history, [id]: history },
        selection: s.activeWorkflowId === id ? pruneSelection(s.selection, doc) : s.selection,
      });
    };

    const patchDoc = (
      key: DocKey,
      patch: (d: DocState<BotManifest | Workflow>) => DocState<BotManifest | Workflow>,
    ) => {
      const s = get();
      if (key === "manifest") {
        if (s.manifest) set({ manifest: patch(s.manifest) as DocState<BotManifest> });
        return;
      }
      const id = key.slice("workflow:".length);
      const d = s.workflows[id];
      if (d) set({ workflows: { ...s.workflows, [id]: patch(d) as DocState<Workflow> } });
    };

    const docAt = (key: DocKey) => {
      const s = get();
      return key === "manifest" ? s.manifest : s.workflows[key.slice("workflow:".length)];
    };

    return {
      botId: undefined,
      manifest: undefined,
      workflows: {},
      activeWorkflowId: undefined,
      selection: emptySelection(),
      history: {},

      load({ botId, manifest, workflows }) {
        set({
          botId,
          manifest: docState("manifest", "manifest", manifest.rev, manifest.doc),
          workflows: Object.fromEntries(workflows.map((w) => [w.doc.id, docState("workflow", w.doc.id, w.rev, w.doc)])),
          activeWorkflowId: manifest.doc.mainWorkflowId,
          selection: emptySelection(),
          history: Object.fromEntries(workflows.map((w) => [w.doc.id, emptyHistory()])),
        });
      },

      open(workflowId) {
        if (!get().workflows[workflowId]) return;
        set({ activeWorkflowId: workflowId, selection: emptySelection() });
      },

      execute(command, workflowId = get().activeWorkflowId) {
        if (workflowId === undefined) return { ok: false, reason: "No workflow is open." };
        const s = get();
        const current = s.workflows[workflowId];
        if (!current) return { ok: false, reason: "That workflow no longer exists." };
        let next: Workflow;
        try {
          next = command.apply(current.doc);
        } catch (e) {
          if (e instanceof CommandRejected) return { ok: false, reason: e.message };
          throw e;
        }
        if (next === current.doc) return { ok: true };
        const history = record(s.history[workflowId] ?? emptyHistory(), {
          label: command.label,
          before: current.doc,
          after: next,
        });
        setWorkflowDoc(workflowId, next, history);
        return { ok: true };
      },

      undo(workflowId = get().activeWorkflowId) {
        if (workflowId === undefined) return false;
        const step = undo(get().history[workflowId] ?? emptyHistory());
        if (!step) return false;
        setWorkflowDoc(workflowId, step.entry.before, step.history);
        return true;
      },

      redo(workflowId = get().activeWorkflowId) {
        if (workflowId === undefined) return false;
        const step = redo(get().history[workflowId] ?? emptyHistory());
        if (!step) return false;
        setWorkflowDoc(workflowId, step.entry.after, step.history);
        return true;
      },

      select(selection) {
        set({ selection: { ...get().selection, ...selection } });
      },

      clearSelection() {
        set({ selection: emptySelection() });
      },

      updateManifest(update) {
        const m = get().manifest;
        if (m) set({ manifest: { ...m, doc: update(m.doc) } });
      },

      docs() {
        const s = get();
        const out: { key: DocKey; state: DocState<BotManifest | Workflow> }[] = [];
        if (s.manifest) out.push({ key: "manifest", state: s.manifest });
        for (const [id, state] of Object.entries(s.workflows)) out.push({ key: workflowKey(id), state });
        return out;
      },

      beginSave(key) {
        const d = docAt(key);
        if (!d || d.saving || d.conflict || !isDirty(d)) return undefined;
        patchDoc(key, (x) => ({ ...x, saving: true }));
        return { rev: d.rev, doc: d.doc };
      },

      finishSave(key, sent, rev) {
        patchDoc(key, (x) => {
          const { error: _error, ...rest } = x;
          return { ...rest, saving: false, rev, saved: sent };
        });
      },

      failSave(key, failure) {
        patchDoc(key, (x) =>
          "conflict" in failure
            ? { ...x, saving: false, conflict: failure.conflict as { rev: number; doc: never } }
            : { ...x, saving: false, error: failure.error },
        );
      },

      resolveConflict(key, keep) {
        const d = docAt(key);
        if (!d?.conflict) return;
        const server = d.conflict;
        if (keep === "theirs") {
          patchDoc(key, (x) => {
            const { conflict: _c, error: _e, ...rest } = x;
            return { ...rest, rev: server.rev, doc: server.doc, saved: server.doc };
          });
          // Local history no longer applies to the document on screen.
          if (key !== "manifest") {
            const id = key.slice("workflow:".length);
            const s = get();
            set({
              history: { ...s.history, [id]: emptyHistory() },
              selection: s.activeWorkflowId === id ? pruneSelection(s.selection, server.doc as Workflow) : s.selection,
            });
          }
        } else {
          // Keep ours: adopt the server's revision so the next save overwrites it.
          patchDoc(key, (x) => {
            const { conflict: _c, ...rest } = x;
            return { ...rest, rev: server.rev, saved: server.doc };
          });
        }
      },
    };
  });
}
