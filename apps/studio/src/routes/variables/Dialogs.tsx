import {
  type BotManifest,
  findUsages,
  IoField,
  nameProblem,
  newElementId,
  type ReferenceTarget,
  type ReferenceUsage,
  renameIo,
  renameVariable,
  Variable,
  type VariableType,
  type Workflow,
} from "@wakeel/contracts";
import { Button, Dialog, Field, Input, Select, Switch, Textarea } from "@wakeel/ui";
import { type FormEvent, useMemo, useState } from "react";
import { useCanvas, useCanvasStore } from "../../canvas/context";
import { commands } from "../../canvas/store/commands";
import {
  defaultText,
  groupUsages,
  parseDefault,
  parseEnumValues,
  placesLabel,
  TYPE_LABELS,
  usageField,
  usesLabel,
  type VariableGroup,
} from "./model";

/** What a usages or delete dialog is about. */
export type Subject =
  | { kind: "variable"; variable: Variable; workflow?: Workflow; path: string }
  | { kind: "input" | "output"; workflow: Workflow; name: string; path: string };

function useDefinition(): { manifest: BotManifest; workflows: Workflow[] } | undefined {
  const manifest = useCanvas((s) => s.manifest?.doc);
  const docs = useCanvas((s) => s.workflows);
  return useMemo(
    () => (manifest ? { manifest, workflows: Object.values(docs).map((d) => d.doc) } : undefined),
    [manifest, docs],
  );
}

const target = (s: Subject): ReferenceTarget =>
  s.kind === "variable"
    ? { kind: "variable", variableId: s.variable.id }
    : { kind: s.kind, workflowId: s.workflow.id, name: s.name };

function useUsages(subject: Subject): ReferenceUsage[] {
  const def = useDefinition();
  return useMemo(() => (def ? findUsages(def, target(subject)) : []), [def, subject]);
}

/** One row per node and card: where it is, which field, how often, and a way to go there. */
function UsageList({ usages, onJump }: { usages: ReferenceUsage[]; onJump: (u: ReferenceUsage) => void }) {
  const def = useDefinition();
  const rows = useMemo(() => groupUsages(usages), [usages]);
  return (
    <ul
      aria-label="Places"
      className="flex max-h-picker-height flex-col overflow-auto rounded-md border border-hairline"
    >
      {rows.map((u) => {
        const wf = def?.workflows.find((w) => w.id === u.workflowId);
        const node = wf?.nodes.find((n) => n.id === u.nodeId);
        return (
          <li
            key={`${u.workflowId}|${u.nodeId}|${u.cardId ?? ""}|${u.field}`}
            className="flex items-center justify-between gap-5 border-b border-hairline px-5 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-body text-primary">
                <bdi>{wf?.name}</bdi> <span className="text-tertiary">/</span> <bdi>{node?.name}</bdi>
              </span>
              <span className="truncate text-small text-secondary">
                {usageField(u, wf)}
                {u.count > 1 ? ` · ${u.count} times` : ""}
              </span>
            </div>
            <Button size="compact" onClick={() => onJump(u)} aria-label={`Open ${node?.name ?? "node"} on the canvas`}>
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function UsagesDialog({
  subject,
  onJump,
  onClose,
}: {
  subject: Subject;
  onJump: (u: ReferenceUsage) => void;
  onClose: () => void;
}) {
  const usages = useUsages(subject);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Where ${subject.path} is used`}
      description={`${usesLabel(usages.length)} in ${placesLabel(groupUsages(usages).length)}. Open one to see it on the canvas.`}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <UsageList usages={usages} onJump={onJump} />
    </Dialog>
  );
}

/** Deleting is offered only when nothing uses it; otherwise the dialog lists what to change first. */
export function DeleteDialog({
  subject,
  onJump,
  onClose,
}: {
  subject: Subject;
  onJump: (u: ReferenceUsage) => void;
  onClose: () => void;
}) {
  const store = useCanvasStore();
  const usages = useUsages(subject);
  const remove = () => {
    if (subject.kind === "variable") {
      const id = subject.variable.id;
      if (subject.workflow) store.getState().execute(commands.deleteVariable(id), subject.workflow.id);
      else store.getState().updateManifest((m) => ({ ...m, variables: m.variables.filter((v) => v.id !== id) }));
    } else {
      store.getState().execute(commands.setIo(subject.kind, subject.name, undefined), subject.workflow.id);
    }
    onClose();
  };
  if (usages.length > 0) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={`${subject.path} is in use`}
        description={`It is used in ${placesLabel(groupUsages(usages).length)}. Remove it from each of them, then delete it.`}
        footer={
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <UsageList usages={usages} onJump={onJump} />
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${subject.path}?`}
      description="Nothing in the bot uses it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={remove}>
            Delete
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

const TYPES = Object.keys(TYPE_LABELS) as VariableType[];

/** Adds a variable to a group, or edits one; a new name renames every reference. */
export function VariableDialog({
  group,
  variable,
  onClose,
}: {
  group: VariableGroup;
  variable?: Variable;
  onClose: () => void;
}) {
  const store = useCanvasStore();
  const def = useDefinition();
  const [name, setName] = useState(variable?.name ?? "");
  const [type, setType] = useState<VariableType>(variable?.type ?? "string");
  const [values, setValues] = useState((variable?.enumValues ?? []).join("\n"));
  const [initial, setInitial] = useState(variable ? defaultText(variable) : "");
  const [description, setDescription] = useState(variable?.description ?? "");
  const [sensitive, setSensitive] = useState(variable?.sensitive ?? false);
  const [submitted, setSubmitted] = useState(false);

  const enumValues = parseEnumValues(values);
  const nameError =
    def &&
    nameProblem(def, name.trim(), {
      scope: group.scope,
      ...(group.workflow ? { workflowId: group.workflow.id } : {}),
      ...(variable ? { exceptVariableId: variable.id } : {}),
    });
  const enumError = type === "enum" && enumValues.length === 0 ? "Add at least one allowed value." : undefined;
  const parsed = parseDefault(type, initial, enumValues);
  const defaultError = parsed.ok ? undefined : parsed.reason;
  const scopeName = group.workflow ? "workflow" : group.scope;

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!def || nameError || enumError || !parsed.ok) return;
    const next = Variable.safeParse({
      id: variable?.id ?? newElementId("var"),
      name: name.trim(),
      scope: group.scope,
      type,
      ...(type === "enum" ? { enumValues } : {}),
      ...(parsed.value === undefined ? {} : { default: parsed.value }),
      ...(description.trim() === "" ? {} : { description: description.trim() }),
      sensitive,
    });
    if (!next.success) return;
    const s = store.getState();
    if (variable && variable.name !== next.data.name) {
      const r = renameVariable(def, variable.id, next.data.name);
      if (r) s.refactor(r);
    }
    const wf = group.workflow;
    if (wf) {
      s.execute(variable ? commands.updateVariable(next.data) : commands.addVariable(next.data), wf.id);
    } else {
      s.updateManifest((m) => ({
        ...m,
        variables: variable
          ? m.variables.map((v) => (v.id === next.data.id ? next.data : v))
          : [...m.variables, next.data],
      }));
    }
    onClose();
  };

  const show = (error: string | undefined) => (submitted ? error : undefined);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={variable ? `Edit ${variable.scope}.${variable.name}` : `New ${scopeName} variable`}
      {...(group.workflow ? { description: `In ${group.workflow.name}.` } : {})}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="variable-form">
            {variable ? "Save" : "Add variable"}
          </Button>
        </>
      }
    >
      <form id="variable-form" onSubmit={save} className="flex flex-col gap-6" noValidate>
        <Field
          label="Name"
          help={
            variable && name.trim() !== variable.name
              ? `References to ${variable.scope}.${variable.name} will change to ${variable.scope}.${name.trim() || "…"}.`
              : `Written as ${scopeName}.${name.trim() || "name"} in messages and code.`
          }
          {...(show(nameError) ? { error: show(nameError) } : {})}
        >
          {(c) => (
            <Input
              {...c}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              className="font-mono"
            />
          )}
        </Field>
        <Field label="Type">
          {(c) => (
            <Select {...c} value={type} onChange={(e) => setType(e.target.value as VariableType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {type === "enum" ? (
          <Field label="Allowed values" help="One per line." {...(show(enumError) ? { error: show(enumError) } : {})}>
            {(c) => <Textarea {...c} value={values} onChange={(e) => setValues(e.target.value)} dir="auto" />}
          </Field>
        ) : null}
        <Field
          label="Default"
          help="Used until something sets it. Leave empty for none."
          {...(show(defaultError) ? { error: show(defaultError) } : {})}
        >
          {(c) =>
            type === "boolean" || type === "enum" ? (
              <Select {...c} value={initial} onChange={(e) => setInitial(e.target.value)}>
                <option value="">No default</option>
                {type === "boolean" ? (
                  <>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </>
                ) : (
                  enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))
                )}
              </Select>
            ) : type === "object" || type === "array" || type === "any" ? (
              <Textarea
                {...c}
                value={initial}
                onChange={(e) => setInitial(e.target.value)}
                dir="ltr"
                spellCheck={false}
                className="font-mono text-code-small"
              />
            ) : (
              <Input {...c} value={initial} onChange={(e) => setInitial(e.target.value)} dir="auto" />
            )
          }
        </Field>
        <Field label="Description" help="Optional. Shown in the code editor and to autonomous nodes.">
          {(c) => <Input {...c} value={description} onChange={(e) => setDescription(e.target.value)} dir="auto" />}
        </Field>
        <Switch
          label="Sensitive"
          hint="Hidden in traces and in the emulator's variable panel."
          checked={sensitive}
          onChange={setSensitive}
        />
      </form>
    </Dialog>
  );
}

/** Adds or edits a sub-workflow input or output; a new name updates the workflow and its callers. */
export function IoDialog({
  workflow,
  kind,
  field,
  onClose,
}: {
  workflow: Workflow;
  kind: "input" | "output";
  field?: IoField;
  onClose: () => void;
}) {
  const store = useCanvasStore();
  const def = useDefinition();
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<VariableType>(field?.type ?? "string");
  const [required, setRequired] = useState(field?.required ?? true);
  const [description, setDescription] = useState(field?.description ?? "");
  const [submitted, setSubmitted] = useState(false);

  const trimmed = name.trim();
  const others = (kind === "input" ? workflow.inputs : workflow.outputs).filter((f) => f.name !== field?.name);
  const nameError =
    kind === "input" && def
      ? nameProblem(def, trimmed, {
          scope: "workflow",
          workflowId: workflow.id,
          ...(field ? { exceptIo: field.name } : {}),
        })
      : !/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(trimmed)
        ? "Use letters, digits and underscores, and start with a letter."
        : undefined;
  const error =
    nameError ??
    (others.some((f) => f.name === trimmed) ? `This workflow already has an ${kind} named "${trimmed}".` : undefined);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (error) return;
    const next = IoField.safeParse({
      name: trimmed,
      type,
      required,
      ...(description.trim() === "" ? {} : { description: description.trim() }),
    });
    if (!next.success) return;
    const s = store.getState();
    if (field && field.name !== trimmed) s.refactor(renameIo(workflow.id, kind, field.name, trimmed));
    s.execute(commands.setIo(kind, trimmed, next.data), workflow.id);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={field ? `Edit ${kind} ${field.name}` : `New ${kind}`}
      description={
        kind === "input"
          ? `Callers of ${workflow.name} pass it in; inside, it reads as workflow.${trimmed || "name"}.`
          : `Exit nodes of ${workflow.name} set it; callers save it into a variable.`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="io-form">
            {field ? "Save" : `Add ${kind}`}
          </Button>
        </>
      }
    >
      <form id="io-form" onSubmit={save} className="flex flex-col gap-6" noValidate>
        <Field label="Name" {...(submitted && error ? { error } : {})}>
          {(c) => (
            <Input
              {...c}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              className="font-mono"
            />
          )}
        </Field>
        <Field label="Type">
          {(c) => (
            <Select {...c} value={type} onChange={(e) => setType(e.target.value as VariableType)}>
              {TYPES.filter((t) => t !== "enum").map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Switch
          label="Required"
          hint={kind === "input" ? "Every caller must pass it." : "Every exit node must set it."}
          checked={required}
          onChange={setRequired}
        />
        <Field label="Description" help="Optional. Shown to autonomous nodes that call this workflow as a tool.">
          {(c) => <Input {...c} value={description} onChange={(e) => setDescription(e.target.value)} dir="auto" />}
        </Field>
      </form>
    </Dialog>
  );
}
