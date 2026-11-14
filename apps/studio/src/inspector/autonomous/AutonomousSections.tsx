import { checkJsonSchema, type Exit, type Node, newElementId, type Tool, type VariableAccess } from "@wakeel/contracts";
import { Button, IconTile, Input, Select, Switch, Textarea } from "@wakeel/ui";
import { ArrowLeft, BookOpen, Braces, LogOut, Plus, Table2, Trash2, Workflow } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useMemo } from "react";
import { useCanvas } from "../../canvas/context";
import { FieldShell, Section, StringField, useDraft, useVariables } from "../fields";
import { ModelField } from "./ModelSection";

/**
 * The Autonomous Node's inspector (design system §5.2, task 6.8): instructions, tools, the variables
 * it may read or write, its exits, and the advanced settings. Selecting a tool or an exit pushes a
 * sub-view in the same panel with a back arrow; `Esc` goes back.
 */

type Auto = Extract<Node, { type: "autonomous" }>;
type Update = (fn: (n: Node) => Node) => void;
/** A tool or exit open in a sub-view; the node view holds it so the whole panel can switch. */
export type AgentView = { kind: "tool" | "exit"; id: string } | undefined;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const BUILT_IN_EXITS = new Set(["listen", "handoff"]);

const TOOL_LABELS: Record<Tool["type"], string> = {
  code: "Code",
  kb_search: "Search knowledge",
  table: "Table",
  workflow: "Workflow",
};
const TOOL_ICONS = { code: Braces, kb_search: BookOpen, table: Table2, workflow: Workflow } as const;

export function AutonomousSections({
  node,
  path,
  update,
  view,
  setView,
}: {
  node: Auto;
  path: string;
  update: Update;
  view: AgentView;
  setView: (v: AgentView) => void;
}) {
  const edit = (fn: (n: Auto) => Auto) => update((n) => (n.type === "autonomous" ? fn(n) : n));
  const tool = view?.kind === "tool" ? node.tools.find((t) => t.id === view.id) : undefined;
  const exit = view?.kind === "exit" ? node.exits.find((e) => e.id === view.id) : undefined;

  if (tool || exit) {
    const back = () => setView(undefined);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Handled here so the inspector does not also close; the field being edited commits on blur.
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      back();
    };
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the sub-view goes back (§5.2).
      <div onKeyDown={onKeyDown} className="flex flex-col">
        <div className="flex items-center gap-4 border-b border-hairline px-6 py-4">
          <button
            type="button"
            aria-label="Back to the node"
            title="Back (Esc)"
            onClick={back}
            className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
          >
            <ArrowLeft className="size-icon" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="text-small font-semibold text-primary">{tool ? "Tool" : "Exit"}</span>
        </div>
        {tool ? (
          <ToolView key={tool.id} node={node} tool={tool} edit={edit} onDeleted={back} />
        ) : exit ? (
          <ExitView key={exit.id} node={node} exit={exit} edit={edit} onDeleted={back} />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Section id="instructions" nodeType={node.type} title="Instructions">
        <StringField
          label="Instructions"
          help="What the agent is for, what it must never do, and when to leave."
          value={node.instructions}
          check="text"
          path={`${path}.instructions`}
          node={node}
          rows={8}
          placeholder="Help the customer track an order…"
          onCommit={(instructions) => edit((n) => ({ ...n, instructions }))}
        />
      </Section>
      <ToolsSection node={node} edit={edit} open={(id) => setView({ kind: "tool", id })} />
      <VariablesSection node={node} edit={edit} />
      <ExitsSection node={node} edit={edit} open={(id) => setView({ kind: "exit", id })} />
      <AdvancedSection node={node} edit={edit} />
    </>
  );
}

type Edit = (fn: (n: Auto) => Auto) => void;

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-control-sm items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
    >
      <Plus className="size-icon" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-hairline px-5 py-6 text-center text-small text-secondary">
      {children}
    </p>
  );
}

function RowButton({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-sm border border-hairline px-4 py-3 text-start transition-colors hover:border-strong hover:bg-subtle"
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-baseline justify-between gap-4">
        <span dir="ltr" className="truncate font-mono text-code-small text-primary">
          {title}
        </span>
        <span dir="auto" className="shrink-0 truncate text-small text-secondary">
          {detail}
        </span>
      </span>
    </button>
  );
}

/** `base`, then `base_2`, `base_3`… whichever is free. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

function ToolsSection({ node, edit, open }: { node: Auto; edit: Edit; open: (id: string) => void }) {
  const add = () => {
    const tool: Tool = {
      id: newElementId("tool"),
      type: "code",
      name: freeName("lookup", new Set(node.tools.map((t) => t.name))),
      description: "Say what this tool does and when to use it.",
      input: { type: "object", properties: {} },
      source: "return null;",
      sideEffects: true,
      timeoutMs: 10_000,
    };
    edit((n) => ({ ...n, tools: [...n.tools, tool] }));
    open(tool.id);
  };
  return (
    <Section
      id="tools"
      nodeType={node.type}
      title="Tools"
      action={node.tools.length < 40 ? <AddButton label="Add a code tool" onClick={add} /> : undefined}
    >
      {node.tools.length === 0 ? (
        <Empty>No tools. The agent can only talk and choose an exit.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {node.tools.map((t) => (
            <li key={t.id}>
              <RowButton
                icon={<IconTile category="ai" icon={TOOL_ICONS[t.type]} size="sm" />}
                title={t.name}
                detail={t.type === "table" ? `Table · ${t.operations.join(", ")}` : TOOL_LABELS[t.type]}
                onClick={() => open(t.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-small text-tertiary">
        Knowledge, table and workflow tools arrive with knowledge bases, tables and sub-workflow calls.
      </p>
    </Section>
  );
}

function ToolView({ node, tool, edit, onDeleted }: { node: Auto; tool: Tool; edit: Edit; onDeleted: () => void }) {
  const set = (next: Tool) => edit((n) => ({ ...n, tools: n.tools.map((t) => (t.id === tool.id ? next : t)) }));
  const others = new Set(node.tools.filter((t) => t.id !== tool.id).map((t) => t.name));
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <NameField
        label="Function name"
        help="The model calls it as tools.name(input). Use a verb: lookupOrder."
        value={tool.name}
        taken={others}
        onCommit={(name) => set({ ...tool, name })}
      />
      <TextField
        label="When to use it"
        help="Shown to the model. Say when to use it and when not to."
        value={tool.description}
        required
        onCommit={(description) => set({ ...tool, description })}
      />
      {tool.type === "code" ? (
        <>
          <SchemaField
            label="Input"
            help="JSON Schema for the input. Calls that do not match are refused before the code runs."
            value={tool.input}
            required
            onCommit={(input) => input && set({ ...tool, input })}
          />
          <SchemaField
            label="Output"
            help="Optional JSON Schema the result must match."
            value={tool.output}
            onCommit={(output) => {
              const { output: _old, ...rest } = tool;
              set(output ? { ...rest, output } : rest);
            }}
          />
          <CodeField
            label="Code"
            help="The body of async (input, ctx) => { … }. Return the result. Runs in the sandbox; it cannot change variables."
            value={tool.source}
            onCommit={(source) => set({ ...tool, source })}
          />
          <Switch
            label="Changes things outside the conversation"
            hint="On: never retried automatically, and the model is told so."
            checked={tool.sideEffects}
            onChange={(sideEffects) => set({ ...tool, sideEffects })}
          />
          <NumberField
            label="Time limit (ms)"
            min={100}
            max={60_000}
            value={tool.timeoutMs}
            onCommit={(timeoutMs) => set({ ...tool, timeoutMs })}
          />
        </>
      ) : (
        <p className="text-small text-secondary">This kind of tool cannot run yet; calls to it tell the model so.</p>
      )}
      <div>
        <Button
          variant="danger"
          icon={<Trash2 className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => {
            edit((n) => ({ ...n, tools: n.tools.filter((t) => t.id !== tool.id) }));
            onDeleted();
          }}
        >
          Delete tool
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

function VariablesSection({ node, edit }: { node: Auto; edit: Edit }) {
  const variables = useVariables().filter((v) => v.id !== "" && v.scope !== "bot");
  const listed = new Set(node.variableAccess.map((a) => a.variableId));
  const available = variables.filter((v) => !listed.has(v.id));
  const pickerId = useId();
  const setAccess = (next: VariableAccess[]) => edit((n) => ({ ...n, variableAccess: next }));
  return (
    <Section id="variables" nodeType={node.type} title="Variables">
      {node.variableAccess.length === 0 ? (
        <Empty>The agent reads and writes no variables.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {node.variableAccess.map((a) => {
            const v = variables.find((x) => x.id === a.variableId);
            return (
              <li key={a.variableId} className="flex items-center gap-3">
                <span
                  dir="ltr"
                  className={`min-w-0 flex-1 truncate font-mono text-code-small ${v ? "text-primary" : "text-error"}`}
                >
                  {v ? v.path : "a deleted variable"}
                </span>
                <Select
                  aria-label={`Access to ${v?.path ?? "the deleted variable"}`}
                  value={a.mode}
                  onChange={(e) =>
                    setAccess(
                      node.variableAccess.map((x) =>
                        x.variableId === a.variableId ? { ...x, mode: e.target.value as VariableAccess["mode"] } : x,
                      ),
                    )
                  }
                >
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                </Select>
                <button
                  type="button"
                  aria-label={`Remove ${v?.path ?? "the deleted variable"}`}
                  onClick={() => setAccess(node.variableAccess.filter((x) => x.variableId !== a.variableId))}
                  className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
                >
                  <Trash2 className="size-icon" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 ? (
        <div className="flex flex-col gap-3">
          <label htmlFor={pickerId} className="text-small font-medium text-primary">
            Give access to
          </label>
          <Select
            id={pickerId}
            value=""
            onChange={(e) => {
              if (e.target.value) setAccess([...node.variableAccess, { variableId: e.target.value, mode: "read" }]);
            }}
          >
            <option value="">Choose a variable</option>
            {available.map((v) => (
              <option key={v.id} value={v.id}>
                {v.path}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Exits                                                               */
/* ------------------------------------------------------------------ */

function ExitsSection({ node, edit, open }: { node: Auto; edit: Edit; open: (id: string) => void }) {
  // Select the workflow itself (a stable reference) and derive from it; a selector that builds a new
  // Map each time would re-render without end.
  const wf = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined));
  const targets = useMemo(() => {
    const names = new Map((wf?.nodes ?? []).map((n) => [n.id, n.name]));
    return new Map(
      (wf?.edges ?? [])
        .filter((e) => e.from.nodeId === node.id)
        .map((e) => [e.from.port, names.get(e.to.nodeId) ?? ""] as const),
    );
  }, [wf, node.id]);
  const add = () => {
    const exit: Exit = {
      id: newElementId("exit"),
      name: freeName("done", new Set([...node.exits.map((e) => e.name), ...BUILT_IN_EXITS])),
      description: "Say when the agent should leave this way.",
    };
    edit((n) => ({ ...n, exits: [...n.exits, exit] }));
    open(exit.id);
  };
  return (
    <Section
      id="exits"
      nodeType={node.type}
      title="Exits"
      action={node.exits.length < 20 ? <AddButton label="Add an exit" onClick={add} /> : undefined}
    >
      {node.exits.length === 0 ? (
        <Empty>
          {node.conversational ? "No exits: the agent keeps the conversation." : "Add an exit: this agent must leave."}
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {node.exits.map((e) => {
            const to = targets.get(`exit:${e.id}`);
            return (
              <li key={e.id}>
                <RowButton
                  icon={<IconTile category="flow" icon={LogOut} size="sm" />}
                  title={e.name}
                  detail={to ? `→ ${to}` : "Not connected"}
                  onClick={() => open(e.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ExitView({ node, exit, edit, onDeleted }: { node: Auto; exit: Exit; edit: Edit; onDeleted: () => void }) {
  const set = (next: Exit) => edit((n) => ({ ...n, exits: n.exits.map((e) => (e.id === exit.id ? next : e)) }));
  const others = new Set([...node.exits.filter((e) => e.id !== exit.id).map((e) => e.name), ...BUILT_IN_EXITS]);
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <NameField
        label="Name"
        help="The model leaves with :::exit name. It is also the output's label on the canvas."
        value={exit.name}
        taken={others}
        onCommit={(name) => set({ ...exit, name })}
      />
      <TextField
        label="When to leave"
        help="Shown to the model."
        value={exit.description}
        required
        onCommit={(description) => set({ ...exit, description })}
      />
      <SchemaField
        label="Data"
        help="Optional JSON Schema for data the model must give. Read downstream as event.exit.data."
        value={exit.schema}
        onCommit={(schema) => {
          const { schema: _old, ...rest } = exit;
          set(schema ? { ...rest, schema } : rest);
        }}
      />
      <div>
        <Button
          variant="danger"
          icon={<Trash2 className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => {
            edit((n) => ({ ...n, exits: n.exits.filter((e) => e.id !== exit.id) }));
            onDeleted();
          }}
        >
          Delete exit
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Advanced                                                            */
/* ------------------------------------------------------------------ */

const MESSAGE_TYPES = ["text", "image", "file", "choice", "dropdown", "card", "carousel", "location"] as const;

function AdvancedSection({ node, edit }: { node: Auto; edit: Edit }) {
  return (
    <Section id="advanced" nodeType={node.type} title="Advanced">
      <ModelField
        node={node}
        onChange={(model) =>
          edit((n) => {
            const { model: _old, ...rest } = n;
            return model ? { ...rest, model } : rest;
          })
        }
      />
      <label className="flex flex-col gap-3">
        <span className="text-small font-medium text-primary">Temperature</span>
        <span className="flex items-center gap-5">
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={node.temperature}
            onChange={(e) => edit((n) => ({ ...n, temperature: Number(e.target.value) }))}
            className="min-w-0 flex-1 accent-accent"
          />
          <output className="w-10 rounded-sm border border-hairline py-2 text-center text-body tabular-nums">
            {node.temperature.toFixed(1)}
          </output>
        </span>
        <span className="text-small text-tertiary">Lower is more predictable. 0.3 suits most support agents.</span>
      </label>
      <NumberField
        label="Steps per turn"
        help="How many tool calls the agent may make before it must answer."
        min={1}
        max={20}
        value={node.maxIterations}
        onCommit={(maxIterations) => edit((n) => ({ ...n, maxIterations }))}
      />
      <Switch
        label="Talks with the user"
        hint="Off: runs once and must leave through an exit."
        checked={node.conversational}
        onChange={(conversational) => edit((n) => ({ ...n, conversational }))}
      />
      <Switch
        label="Can hand off to a person"
        hint="Adds the built-in handoff exit."
        checked={node.allowHandoff}
        onChange={(allowHandoff) => edit((n) => ({ ...n, allowHandoff }))}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-small font-medium text-primary">Message types</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {MESSAGE_TYPES.map((t) => {
            const on = node.messageTypes.includes(t);
            const last = on && node.messageTypes.length === 1;
            return (
              <label key={t} className="flex items-center gap-3 text-body text-primary">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={last}
                  onChange={() =>
                    edit((n) => ({
                      ...n,
                      messageTypes: on ? n.messageTypes.filter((x) => x !== t) : [...n.messageTypes, t],
                    }))
                  }
                  className="accent-accent"
                />
                {t}
              </label>
            );
          })}
        </div>
        <span className="text-small text-tertiary">The agent may send only these. At least one stays on.</span>
      </fieldset>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

type Problem = { message: string; fix: string };

function NameField({
  label,
  help,
  value,
  taken,
  onCommit,
}: {
  label: string;
  help: string;
  value: string;
  taken: ReadonlySet<string>;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useDraft(value);
  const problem: Problem | undefined = !IDENTIFIER.test(draft)
    ? { message: "Use letters, digits and underscores, starting with a letter.", fix: "For example lookupOrder." }
    : taken.has(draft)
      ? { message: `"${draft}" is already used here.`, fix: "Choose another name." }
      : undefined;
  return (
    <FieldShell label={label} help={help} problem={problem}>
      {({ invalid, ...p }) => (
        <Input
          {...p}
          dir="ltr"
          className="font-mono"
          aria-invalid={invalid || undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => (problem ? undefined : draft !== value && onCommit(draft))}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
    </FieldShell>
  );
}

function TextField({
  label,
  help,
  value,
  required,
  onCommit,
}: {
  label: string;
  help: string;
  value: string;
  required?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useDraft(value);
  const problem: Problem | undefined =
    required && draft.trim() === ""
      ? { message: `${label} cannot be empty.`, fix: "Write one or two sentences." }
      : draft.length > 1_000
        ? { message: "This is longer than 1,000 characters.", fix: "Shorten it." }
        : undefined;
  return (
    <FieldShell label={label} help={help} problem={problem}>
      {({ invalid, ...p }) => (
        <Textarea
          {...p}
          dir="auto"
          rows={2}
          aria-invalid={invalid || undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !problem && draft.trim() !== value && onCommit(draft.trim())}
        />
      )}
    </FieldShell>
  );
}

type Schema = Record<string, unknown>;

function SchemaField({
  label,
  help,
  value,
  required,
  onCommit,
}: {
  label: string;
  help: string;
  value: Schema | undefined;
  required?: boolean;
  onCommit: (v: Schema | undefined) => void;
}) {
  const shown = value ? JSON.stringify(value, null, 2) : "";
  const [draft, setDraft] = useDraft(shown);
  let parsed: Schema | undefined;
  let problem: Problem | undefined;
  if (draft.trim() === "") {
    if (required) problem = { message: `${label} needs a schema.`, fix: 'Start from {"type": "object"}.' };
  } else {
    try {
      const json: unknown = JSON.parse(draft);
      const issues = checkJsonSchema(json);
      if (issues.length > 0) {
        const first = issues[0];
        problem = {
          message: `${first?.path ? `${first.path}: ` : ""}${first?.message ?? "This is not a valid schema."}`,
          fix: "Fix the schema; only the supported JSON Schema keywords are allowed.",
        };
      } else parsed = json as Schema;
    } catch {
      problem = { message: "This is not valid JSON.", fix: "Check the quotes, commas and brackets." };
    }
  }
  return (
    <FieldShell label={label} help={help} problem={problem}>
      {({ invalid, ...p }) => (
        <Textarea
          {...p}
          dir="ltr"
          rows={4}
          spellCheck={false}
          className="font-mono text-code-small"
          aria-invalid={invalid || undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (problem || draft === shown) return;
            onCommit(parsed);
          }}
        />
      )}
    </FieldShell>
  );
}

function CodeField({
  label,
  help,
  value,
  onCommit,
}: {
  label: string;
  help: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useDraft(value);
  const problem: Problem | undefined =
    draft.length > 100_000 ? { message: "The code is longer than 100,000 characters.", fix: "Shorten it." } : undefined;
  return (
    <FieldShell label={label} help={help} problem={problem}>
      {({ invalid, ...p }) => (
        <Textarea
          {...p}
          dir="ltr"
          rows={8}
          spellCheck={false}
          className="font-mono text-code-small"
          aria-invalid={invalid || undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !problem && draft !== value && onCommit(draft)}
        />
      )}
    </FieldShell>
  );
}

function NumberField({
  label,
  help,
  min,
  max,
  value,
  onCommit,
}: {
  label: string;
  help?: string;
  min: number;
  max: number;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useDraft(String(value));
  const n = Number(draft);
  const problem: Problem | undefined =
    !Number.isInteger(n) || n < min || n > max
      ? { message: `Use a whole number from ${min} to ${max}.`, fix: `For example ${value}.` }
      : undefined;
  return (
    <FieldShell label={label} {...(help ? { help } : {})} problem={problem}>
      {({ invalid, ...p }) => (
        <Input
          {...p}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          className="w-12 tabular-nums"
          aria-invalid={invalid || undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !problem && n !== value && onCommit(n)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
    </FieldShell>
  );
}
