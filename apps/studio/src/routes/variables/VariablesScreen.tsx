import { useNavigate } from "@tanstack/react-router";
import type { IoField, ReferenceUsage, Variable, Workflow } from "@wakeel/contracts";
import { Banner, Button, Skeleton, Table, Td, THead, Th, Tr } from "@wakeel/ui";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { useCanvas, useCanvasStore } from "../../canvas/context";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { TopBarStatus } from "../../shell/TopBarStatus";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { DeleteDialog, IoDialog, type Subject, UsagesDialog, VariableDialog } from "./Dialogs";
import { formatDefault, TYPE_LABELS, usageCounts, usesLabel, type VariableGroup, variableGroups } from "./model";

/**
 * The Variables screen (design system §5.7, task 2.7): every variable grouped by scope, then each
 * workflow with its inputs and outputs. "Used in" lists the places that refer to a variable and
 * jumps to them; a rename rewrites every reference; delete is offered only for unused ones.
 *
 * The Secrets and settings tab (config variable values per environment) arrives with task 7.5,
 * when values can be stored (7.3).
 */
export function VariablesScreen({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const state = useLoadState();
  const ready = state === "ready";
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Variables" />}
      active="Variables"
      workspaceId={workspaceId}
      botId={botId}
      actions={ready ? <TopBarStatus /> : null}
    >
      <Page>
        <PageHeader
          title="Variables"
          description="What the bot remembers while it runs. Rename one here and every reference to it follows."
        />
        {state === "loading" ? (
          <LoadingGroups />
        ) : ready ? (
          <Groups workspaceId={workspaceId} botId={botId} />
        ) : state.error instanceof ApiError ? (
          <ProblemBanner error={state.error} />
        ) : (
          <Banner tone="error" title="The variables could not be opened">
            Reload the page and try again.
          </Banner>
        )}
      </Page>
    </AppShell>
  );
}

type Open =
  | { dialog: "variable"; group: VariableGroup; variable?: Variable }
  | { dialog: "io"; workflow: Workflow; kind: "input" | "output"; field?: IoField }
  | { dialog: "usages" | "delete"; subject: Subject };

function Groups({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const manifest = useCanvas((s) => s.manifest?.doc);
  const docs = useCanvas((s) => s.workflows);
  const workflows = useMemo(() => Object.values(docs).map((d) => d.doc), [docs]);
  const groups = useMemo(() => (manifest ? variableGroups(manifest, workflows) : []), [manifest, workflows]);
  const counts = useMemo(() => (manifest ? usageCounts({ manifest, workflows }) : undefined), [manifest, workflows]);
  const [open, setOpen] = useState<Open>();
  const close = () => setOpen(undefined);
  const jump = useJump(workspaceId, botId);

  if (!manifest || !counts) return null;
  return (
    <div className="flex flex-col gap-10">
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`group-${g.key}`} className="flex flex-col gap-5">
          <div className="flex items-end justify-between gap-6">
            <div className="flex min-w-0 flex-col gap-1">
              {/* bdi, not dir="auto": an Arabic workflow name keeps its own direction but stays at the start. */}
              <h2 id={`group-${g.key}`} className="truncate text-title text-primary">
                <bdi>{g.title}</bdi>
              </h2>
              <p className="text-small text-secondary">{g.description}</p>
            </div>
            <Button
              size="compact"
              icon={<Plus className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
              aria-label={`Add ${g.workflow ? "workflow" : g.scope} variable${g.workflow ? ` to ${g.title}` : ""}`}
              onClick={() => setOpen({ dialog: "variable", group: g })}
            >
              Add variable
            </Button>
          </div>
          {g.variables.length === 0 ? (
            <Empty>No {g.workflow ? "workflow" : g.title.toLowerCase()} variables yet.</Empty>
          ) : (
            <Table label={`${g.title} variables`} fixed>
              <THead>
                <tr>
                  <Th className="w-4/12">Name</Th>
                  <Th className="w-2/12">Type</Th>
                  <Th className="w-2/12">Default</Th>
                  <Th className="w-2/12">Used in</Th>
                  <Th className="w-1/12">Sensitive</Th>
                  <Th className="w-1/12">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <tbody>
                {g.variables.map((v) => {
                  const path = `${v.scope}.${v.name}`;
                  const subject: Subject = {
                    kind: "variable",
                    variable: v,
                    path,
                    ...(g.workflow ? { workflow: g.workflow } : {}),
                  };
                  const used = counts.variable(v, g.workflow?.id);
                  return (
                    <Tr key={v.id}>
                      <Td>
                        <Path>{path}</Path>
                      </Td>
                      <Td className="text-secondary">{TYPE_LABELS[v.type]}</Td>
                      <Td className="truncate text-secondary">
                        <Default text={formatDefault(v)} />
                      </Td>
                      <Td>
                        <UsedIn count={used} name={path} onOpen={() => setOpen({ dialog: "usages", subject })} />
                      </Td>
                      <Td className="text-secondary">
                        {v.sensitive ? (
                          <span className="flex items-center gap-2">
                            <Lock className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
                            Yes
                          </span>
                        ) : (
                          <span className="text-tertiary">No</span>
                        )}
                      </Td>
                      <RowActions
                        name={path}
                        onEdit={() => setOpen({ dialog: "variable", group: g, variable: v })}
                        onDelete={() => setOpen({ dialog: "delete", subject })}
                      />
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {g.workflow?.kind === "sub" ? (
            <>
              <IoTable workflow={g.workflow} kind="input" count={counts.io} onOpen={setOpen} />
              <IoTable workflow={g.workflow} kind="output" count={counts.io} onOpen={setOpen} />
            </>
          ) : null}
        </section>
      ))}

      {open?.dialog === "variable" ? (
        <VariableDialog group={open.group} {...(open.variable ? { variable: open.variable } : {})} onClose={close} />
      ) : null}
      {open?.dialog === "io" ? (
        <IoDialog
          workflow={open.workflow}
          kind={open.kind}
          {...(open.field ? { field: open.field } : {})}
          onClose={close}
        />
      ) : null}
      {open?.dialog === "usages" ? <UsagesDialog subject={open.subject} onJump={jump} onClose={close} /> : null}
      {open?.dialog === "delete" ? <DeleteDialog subject={open.subject} onJump={jump} onClose={close} /> : null}
    </div>
  );
}

function IoTable({
  workflow,
  kind,
  count,
  onOpen,
}: {
  workflow: Workflow;
  kind: "input" | "output";
  count: (workflowId: string, kind: "input" | "output", name: string) => number;
  onOpen: (o: Open) => void;
}) {
  const fields = kind === "input" ? workflow.inputs : workflow.outputs;
  const title = kind === "input" ? "Inputs" : "Outputs";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-6">
        <h3 className="text-body font-medium text-primary">{title}</h3>
        <Button
          size="compact"
          icon={<Plus className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
          aria-label={`Add ${kind} to ${workflow.name}`}
          onClick={() => onOpen({ dialog: "io", workflow, kind })}
        >
          Add {kind}
        </Button>
      </div>
      {fields.length === 0 ? (
        <Empty>
          {kind === "input"
            ? "No inputs. Callers pass nothing in."
            : "No outputs. Exit nodes return nothing to the caller."}
        </Empty>
      ) : (
        <Table label={`${workflow.name} ${title.toLowerCase()}`} fixed>
          <THead>
            <tr>
              <Th className="w-4/12">Name</Th>
              <Th className="w-2/12">Type</Th>
              <Th className="w-2/12">Required</Th>
              <Th className="w-3/12">Used in</Th>
              <Th className="w-1/12">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {fields.map((f) => {
              const subject: Subject = { kind, workflow, name: f.name, path: `${kind} ${f.name}` };
              return (
                <Tr key={f.name}>
                  <Td>
                    <Path>{f.name}</Path>
                  </Td>
                  <Td className="text-secondary">{TYPE_LABELS[f.type]}</Td>
                  <Td className="text-secondary">{f.required ? "Yes" : <span className="text-tertiary">No</span>}</Td>
                  <Td>
                    <UsedIn
                      count={count(workflow.id, kind, f.name)}
                      name={`${kind} ${f.name}`}
                      onOpen={() => onOpen({ dialog: "usages", subject })}
                    />
                  </Td>
                  <RowActions
                    name={`${kind} ${f.name}`}
                    onEdit={() => onOpen({ dialog: "io", workflow, kind, field: f })}
                    onDelete={() => onOpen({ dialog: "delete", subject })}
                  />
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}

const Path = ({ children }: { children: ReactNode }) => (
  <span className="block truncate font-mono text-code-small text-primary" dir="ltr">
    {children}
  </span>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="rounded-lg border border-dashed border-hairline px-7 py-6 text-body text-secondary">{children}</p>
);

function Default({ text }: { text: string }) {
  if (text === "") return <span className="text-tertiary">None</span>;
  return (
    <span dir="auto" title={text}>
      {text}
    </span>
  );
}

function UsedIn({ count, name, onOpen }: { count: number; name: string; onOpen: () => void }) {
  if (count === 0) return <span className="text-tertiary">{usesLabel(0)}</span>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${name}: ${usesLabel(count)}. Show where`}
      className="rounded-xs text-accent underline-offset-2 hover:underline"
    >
      {usesLabel(count)}
    </button>
  );
}

function RowActions({ name, onEdit, onDelete }: { name: string; onEdit: () => void; onDelete: () => void }) {
  return (
    <Td className="w-px">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="compact"
          variant="ghost"
          aria-label={`Edit ${name}`}
          title="Edit"
          icon={<Pencil className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
          onClick={onEdit}
        />
        <Button
          size="compact"
          variant="ghost"
          aria-label={`Delete ${name}`}
          title="Delete"
          icon={<Trash2 className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
          onClick={onDelete}
        />
      </div>
    </Td>
  );
}

/** Opens the canvas on the workflow of a usage with its node and card selected (the inspector shows the card). */
function useJump(workspaceId: string, botId: string) {
  const store = useCanvasStore();
  const navigate = useNavigate();
  return (u: ReferenceUsage) => {
    const s = store.getState();
    s.open(u.workflowId);
    s.select({
      nodeIds: [u.nodeId],
      edgeIds: [],
      ...(u.cardId ? { card: { nodeId: u.nodeId, cardId: u.cardId } } : {}),
    });
    void navigate({ to: "/w/$workspaceId/b/$botId", params: { workspaceId, botId } });
  };
}

function LoadingGroups() {
  return (
    <div role="status" aria-busy="true" aria-label="Opening the variables" className="flex flex-col gap-10">
      {[3, 2, 1].map((rows) => (
        <div key={rows} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-11" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-6">
            {Array.from({ length: rows }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders with no identity.
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
