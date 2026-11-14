import { Card, type DefinitionIssue, makeIssue, type Node, parseExpression, parseTemplate } from "@wakeel/contracts";
import { ExpressionInput, TemplateInput, type VariableOption } from "@wakeel/ui";
import { ChevronDown } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useState } from "react";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { commands } from "../canvas/store/commands";

/**
 * The inspector's field plumbing (task 2.6, design system §5.2): every field validates as you type
 * and shows the fix sentence under it; edits commit to the document on blur (or at once for
 * switches and selects), so one edit is one undo step; and a card is only committed when it is
 * schema-valid, so autosave never sends a document the api would reject.
 */

/** Validation issues of the whole draft, from the worker (canvas/issues.ts). */
export const IssuesContext = createContext<readonly DefinitionIssue[]>([]);

export interface Problem {
  message: string;
  fix: string;
}

/** The validator's issue at exactly `path`, if any. */
export function useIssueAt(path: string): Problem | undefined {
  const issues = useContext(IssuesContext);
  const issue = issues.find((i) => i.path === path);
  return issue ? { message: issue.message, fix: issue.fix } : undefined;
}

export type Check = "text" | "required" | "expression" | "optional-expression";

/** What is wrong with `value` right now, before the worker has seen it. */
export function checkValue(kind: Check, value: string, nodeName: string): Problem | undefined {
  if ((kind === "required" || kind === "expression") && value.trim() === "") {
    return {
      message: "This field is empty.",
      fix: kind === "expression" ? "Enter an expression." : "Enter some text.",
    };
  }
  if (kind === "text" || kind === "required") {
    const parsed = parseTemplate(value);
    if (!parsed.ok) {
      const i = makeIssue("template_syntax", { node: nodeName, reason: parsed.reason }, { path: "" });
      return { message: i.message, fix: i.fix };
    }
  } else if (value.trim() !== "") {
    const parsed = parseExpression(value);
    if (!parsed.ok) {
      const i = makeIssue(
        "expression_syntax",
        { node: nodeName, reason: parsed.reason, expression: value },
        { path: "" },
      );
      return { message: i.message, fix: i.fix };
    }
  }
  return undefined;
}

export interface ScopedVariable extends VariableOption {
  /** Empty for workflow inputs, which are not variables a card can write to. */
  id: string;
  scope: string;
}

/** Variables a template or expression in this workflow can name, as `scope.name`. */
export function useVariables(): ScopedVariable[] {
  const manifest = useCanvas((s) => s.manifest?.doc.variables);
  const wf = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined));
  return useMemo(
    () => [
      ...(manifest ?? []).map((v) => ({ path: `${v.scope}.${v.name}`, type: v.type, id: v.id, scope: v.scope })),
      ...(wf?.variables ?? []).map((v) => ({ path: `workflow.${v.name}`, type: v.type, id: v.id, scope: v.scope })),
      ...(wf?.inputs ?? []).map((i) => ({ path: `workflow.${i.name}`, type: i.type, id: "", scope: "workflow" })),
    ],
    [manifest, wf],
  );
}

/** Commits a changed card as one undo step, only when the card is schema-valid. */
export function useCommitCard(nodeId: string) {
  const store = useCanvasStore();
  return (next: Card): boolean => {
    const parsed = Card.safeParse(next);
    if (!parsed.success) return false;
    return store.getState().execute(commands.updateCard(nodeId, parsed.data)).ok;
  };
}

/** A local copy of a value while it is edited; resets when the document changes underneath. */
export function useDraft<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return [draft, setDraft];
}

/** Label, control, and one line under it: the problem (what happened, how to fix it) or the help. */
export function FieldShell({
  label,
  help,
  problem,
  path,
  children,
}: {
  label: string;
  help?: string;
  problem: Problem | undefined;
  /** Issue path of the field: the Issues panel and `F8` focus the control inside (task 2.8). */
  path?: string;
  children: (control: { id: string; "aria-describedby"?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const hasNote = problem !== undefined || help !== undefined;
  return (
    <div className="flex flex-col gap-3" data-issue-path={path}>
      <label htmlFor={id} className="text-small font-medium text-primary">
        {label}
      </label>
      {children({ id, ...(hasNote ? { "aria-describedby": noteId } : {}), invalid: problem !== undefined })}
      {problem ? (
        <div id={noteId} role="alert" className="flex flex-col gap-1">
          <p className="text-small text-error">{problem.message}</p>
          <p className="text-small text-secondary">{problem.fix}</p>
        </div>
      ) : help ? (
        <p id={noteId} className="text-small text-tertiary">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A template or expression field bound to one string of a card. Shows the as-you-type problem, or
 * the validator's issue at `path` once the draft is committed.
 */
export function StringField({
  label,
  help,
  value,
  check,
  path,
  node,
  onCommit,
  onDraft,
  rows,
  placeholder,
}: {
  label: string;
  help?: string;
  value: string;
  check: Check;
  /** Issue path of this field, `workflows.<wf>.nodes.<node>.cards.<card>.<field>`. */
  path: string;
  node: Node;
  onCommit: (value: string) => void;
  /** Every keystroke, for live previews; the document only changes on commit. */
  onDraft?: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const variables = useVariables();
  const [draft, setDraftState] = useDraft(value);
  const setDraft = (v: string) => {
    setDraftState(v);
    onDraft?.(v);
  };
  const local = checkValue(check, draft, node.name);
  const stored = useIssueAt(path);
  const problem = local ?? (draft === value ? stored : undefined);
  const commit = () => {
    if (draft !== value && !local) onCommit(draft);
  };
  return (
    <FieldShell label={label} {...(help ? { help } : {})} problem={problem} path={path}>
      {({ id, invalid, ...rest }) =>
        check === "expression" || check === "optional-expression" ? (
          <ExpressionInput
            id={id}
            value={draft}
            onChange={setDraft}
            onCommit={commit}
            variables={variables}
            invalid={invalid}
            {...(placeholder ? { placeholder } : {})}
            {...rest}
          />
        ) : (
          <TemplateInput
            id={id}
            value={draft}
            onChange={setDraft}
            onCommit={commit}
            variables={variables}
            invalid={invalid}
            rows={rows ?? 2}
            {...(placeholder ? { placeholder } : {})}
            {...rest}
          />
        )
      }
    </FieldShell>
  );
}

const collapsedKey = (nodeType: string) => `wk.inspector.collapsed.${nodeType}`;

function readCollapsed(nodeType: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(collapsedKey(nodeType)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** A collapsible inspector section; collapsed state is remembered per node type (§5.2). */
export function Section({
  id,
  nodeType,
  title,
  action,
  children,
}: {
  id: string;
  nodeType: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !readCollapsed(nodeType).has(id));
  const toggle = () => {
    setOpen((o) => {
      const set = readCollapsed(nodeType);
      if (o) set.add(id);
      else set.delete(id);
      try {
        localStorage.setItem(collapsedKey(nodeType), JSON.stringify([...set]));
      } catch {
        // Private windows may refuse storage; the section still toggles for this session.
      }
      return !o;
    });
  };
  return (
    <section className="flex flex-col border-b border-hairline last:border-b-0">
      <div className="flex h-control-lg items-center gap-3 px-6">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex flex-1 items-center gap-3 text-start text-small font-semibold text-primary"
        >
          <ChevronDown
            className={`size-icon-sm text-tertiary transition-transform ${open ? "" : "-rotate-90"}`}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          {title}
        </button>
        {action}
      </div>
      {open ? <div className="flex flex-col gap-6 px-6 pb-6">{children}</div> : null}
    </section>
  );
}
