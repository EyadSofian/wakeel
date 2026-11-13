import { DisplayName, type Workflow } from "@wakeel/contracts";
import { Button, Dialog, Field, Input } from "@wakeel/ui";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { createWorkflow, deleteWorkflow } from "../api/drafts";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { commands } from "../canvas/store/commands";
import { ProblemBanner } from "./ProblemBanner";
import { useShell, useShellState } from "./shell-store";
import { useGoTo } from "./use-go-to";
import { callSites, copyName, duplicateWorkflow } from "./workflows";

/**
 * The Workflows panel's dialogs and requests (task 2.8): New, Rename and Delete workflow, and
 * Duplicate, which needs no dialog. The server creates and deletes workflow documents; the store
 * follows only once it has, so the canvas never shows a workflow that does not exist.
 */

const nameProblem = (name: string) => {
  const parsed = DisplayName.safeParse(name);
  if (parsed.success) return undefined;
  return name.trim() === "" ? "Give the workflow a name." : "Use 80 characters or fewer.";
};

/** Create, duplicate and delete, each resolving to an error to show or undefined. */
export function useWorkflowRequests() {
  const canvas = useCanvasStore();
  const { workspaceId, botId } = useShell();
  const go = useGoTo();

  const create = useCallback(
    async (name: string): Promise<unknown> => {
      try {
        const created = await createWorkflow(workspaceId, botId, name.trim());
        canvas.getState().addWorkflow({ rev: created.rev, saved: created.doc });
        go.place({ workflowId: created.doc.id });
        return undefined;
      } catch (error) {
        return error;
      }
    },
    [canvas, workspaceId, botId, go],
  );

  const duplicate = useCallback(
    async (source: Workflow): Promise<unknown> => {
      const taken = Object.values(canvas.getState().workflows).map((w) => w.doc.name);
      try {
        const created = await createWorkflow(workspaceId, botId, copyName(source.name, taken));
        // The server seeded an Entry and an Exit; the copy replaces them and autosave sends it.
        const doc = duplicateWorkflow(source, { id: created.doc.id, name: created.doc.name });
        canvas.getState().addWorkflow({ rev: created.rev, saved: created.doc, doc });
        go.place({ workflowId: doc.id });
        return undefined;
      } catch (error) {
        return error;
      }
    },
    [canvas, workspaceId, botId, go],
  );

  const remove = useCallback(
    async (workflowId: string): Promise<unknown> => {
      try {
        await deleteWorkflow(workspaceId, botId, workflowId);
        canvas.getState().removeWorkflow(workflowId);
        return undefined;
      } catch (error) {
        return error;
      }
    },
    [canvas, workspaceId, botId],
  );

  return { create, duplicate, remove };
}

export function WorkflowDialogs() {
  const { store } = useShell();
  const dialog = useShellState((s) => s.dialog);
  const workflows = useCanvas((s) => s.workflows);
  const close = () => store.getState().set({ dialog: undefined });
  if (!dialog) return null;
  if (dialog.kind === "new") return <NewDialog onClose={close} />;
  if (dialog.kind === "failed") return <FailedDialog title={dialog.title} error={dialog.error} onClose={close} />;
  const wf = workflows[dialog.workflowId]?.doc;
  if (!wf) return null;
  if (dialog.kind === "rename") return <RenameDialog workflow={wf} onClose={close} />;
  return <DeleteDialog workflow={wf} onClose={close} />;
}

function NameForm({
  id,
  value,
  onChange,
  problem,
  onSubmit,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  problem: string | undefined;
  onSubmit: () => void;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form id={id} onSubmit={submit} noValidate>
      <Field label="Name" {...(problem ? { error: problem } : {})}>
        {(control) => (
          <Input {...control} autoFocus dir="auto" value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
    </form>
  );
}

function NewDialog({ onClose }: { onClose: () => void }) {
  const { create } = useWorkflowRequests();
  const [name, setName] = useState("");
  const [shown, setShown] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const problem = nameProblem(name);
    setShown(problem);
    if (problem || busy) return;
    setBusy(true);
    const failed = await create(name);
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New workflow"
      description="A sub-workflow that Run workflow cards and autonomous nodes can call."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-workflow" disabled={busy}>
            Create workflow
          </Button>
        </>
      }
    >
      <ProblemBanner error={error} />
      <NameForm
        id="new-workflow"
        value={name}
        onChange={(v) => {
          setName(v);
          if (shown) setShown(nameProblem(v));
        }}
        problem={shown}
        onSubmit={() => void submit()}
      />
    </Dialog>
  );
}

function RenameDialog({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const canvas = useCanvasStore();
  const [name, setName] = useState(workflow.name);
  const [shown, setShown] = useState<string>();
  const submit = () => {
    const problem = nameProblem(name);
    setShown(problem);
    if (problem) return;
    const result = canvas.getState().execute(commands.renameWorkflow(name), workflow.id);
    if (result.ok) onClose();
    else setShown(result.reason);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename workflow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename-workflow">
            Rename workflow
          </Button>
        </>
      }
    >
      <NameForm
        id="rename-workflow"
        value={name}
        onChange={(v) => {
          setName(v);
          if (shown) setShown(nameProblem(v));
        }}
        problem={shown}
        onSubmit={submit}
      />
    </Dialog>
  );
}

function DeleteDialog({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const { remove } = useWorkflowRequests();
  const manifest = useCanvas((s) => s.manifest?.doc);
  const docs = useCanvas((s) => s.workflows);
  const sites = useMemo(
    () => (manifest ? callSites({ manifest, workflows: Object.values(docs).map((d) => d.doc) }, workflow.id) : []),
    [manifest, docs, workflow.id],
  );
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    const failed = await remove(workflow.id);
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };
  const consequence =
    sites.length === 0
      ? "Nothing calls it. Its nodes are deleted with it, and this cannot be undone."
      : `${sites.length === 1 ? "1 place calls it and" : `${sites.length} places call it and`} will stop working. Deleting cannot be undone.`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete workflow "${workflow.name}"?`}
      description={consequence}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
            Delete workflow
          </Button>
        </>
      }
    >
      <ProblemBanner error={error} />
      {sites.length > 0 ? (
        <ul
          aria-label="Places that call it"
          className="flex max-h-picker-height flex-col overflow-auto rounded-md border border-hairline"
        >
          {sites.map((s) => (
            <li
              key={`${s.usage.nodeId}|${s.usage.cardId ?? ""}|${s.usage.field}`}
              className="flex flex-col border-b border-hairline px-5 py-3 last:border-b-0"
            >
              <span className="truncate text-body text-primary">
                <bdi>{s.workflow}</bdi> <span className="text-tertiary">/</span> <bdi>{s.node}</bdi>
              </span>
              <span dir="auto" className="truncate text-small text-secondary">
                {s.what}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-secondary">
          {workflow.nodes.length === 1 ? "1 node" : `${workflow.nodes.length} nodes`} in this workflow.
        </p>
      )}
    </Dialog>
  );
}

function FailedDialog({ title, error, onClose }: { title: string; error: unknown; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <ProblemBanner error={error} />
    </Dialog>
  );
}
