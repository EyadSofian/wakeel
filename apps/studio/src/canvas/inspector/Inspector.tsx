import type { DefinitionIssue, Node } from "@wakeel/contracts";
import { Count, IconTile } from "@wakeel/ui";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useCanvas, useCanvasStore } from "../context";
import { commands } from "../store/commands";
import {
  CARD_CATEGORY,
  CARD_ICONS,
  CARD_NAMES,
  NODE_CATEGORY,
  NODE_ICONS,
  nodeSubtitle,
  type SummaryContext,
  summarizeCard,
} from "../view/summaries";

/**
 * The inspector (design system §5.1, ADR-017): docked on the end side while exactly one node is
 * selected. Configure edits the node through store commands, committing on blur so one edit is one
 * undo step; Issues lists what validation found on this node with each fix. Card editors and the
 * Autonomous node's tools and exits come with tasks 2.6 and 6.8.
 */
export function Inspector({ issues, summary }: { issues: readonly DefinitionIssue[]; summary: SummaryContext }) {
  const node = useCanvas((s) => {
    if (s.selection.nodeIds.length !== 1 || !s.activeWorkflowId) return undefined;
    const id = s.selection.nodeIds[0];
    return s.workflows[s.activeWorkflowId]?.doc.nodes.find((n) => n.id === id);
  });
  const clear = useCanvas((s) => s.clearSelection);
  const [tab, setTab] = useState<"configure" | "issues">("configure");
  if (!node) return null;
  const mine = issues.filter((i) => i.nodeId === node.id);
  const Icon = NODE_ICONS[node.type];

  return (
    <aside
      aria-label={`Inspector: ${node.name}`}
      className="flex w-inspector shrink-0 flex-col border-s border-hairline bg-surface"
    >
      <header className="flex items-start gap-4 px-6 pt-6">
        <IconTile category={NODE_CATEGORY[node.type]} icon={Icon} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 dir="auto" className="truncate text-title text-primary">
            {node.name}
          </h2>
          <p className="truncate text-small text-secondary">{nodeSubtitle(node)}</p>
        </div>
        <button
          type="button"
          aria-label="Close inspector"
          title="Close (Esc)"
          onClick={clear}
          className="flex size-control-sm items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
        >
          <X className="size-icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div role="tablist" aria-label="Inspector" className="mt-5 flex gap-6 border-b border-hairline px-6">
        <TabButton selected={tab === "configure"} onClick={() => setTab("configure")}>
          Configure
        </TabButton>
        <TabButton selected={tab === "issues"} onClick={() => setTab("issues")}>
          Issues
          {mine.length > 0 ? <Count>{mine.length}</Count> : null}
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "configure" ? <Configure key={node.id} node={node} summary={summary} /> : <IssueList issues={mine} />}
      </div>
    </aside>
  );
}

function TabButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={[
        "inline-flex h-control-lg items-center gap-3 border-b-2 text-body font-medium transition-colors",
        selected ? "border-accent text-primary" : "border-transparent text-secondary hover:text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

const fieldClass =
  "w-full rounded-sm border border-hairline bg-surface px-5 text-body text-primary placeholder:text-tertiary transition-colors hover:border-strong focus-visible:border-accent";

/** A labelled field whose value is committed on blur (and Enter for single-line inputs). */
function Section({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={id} className="text-small font-medium text-primary">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-small text-tertiary">{hint}</p> : null}
    </div>
  );
}

function useDraft<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return [draft, setDraft];
}

function Configure({ node, summary }: { node: Node; summary: SummaryContext }) {
  const store = useCanvasStore();
  const [name, setName] = useDraft(node.name);
  const [description, setDescription] = useDraft(node.description ?? "");
  const update = (fn: (n: Node) => Node) => store.getState().execute(commands.updateNode(node.id, fn));

  const commitName = () => {
    const next = name.trim();
    if (next && next !== node.name) store.getState().execute(commands.renameNode(node.id, next));
    else setName(node.name);
  };
  const commitDescription = () => {
    const next = description.trim();
    if (next !== (node.description ?? "")) {
      update((n) => {
        const { description: _old, ...rest } = n;
        return (next ? { ...rest, description: next } : rest) as Node;
      });
    }
  };

  return (
    <div className="flex flex-col gap-7 p-6">
      <Section label="Name">
        {(id) => (
          <input
            id={id}
            dir="auto"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className={`h-control ${fieldClass}`}
          />
        )}
      </Section>
      <Section label="Description" hint="For builders. The bot never sees it.">
        {(id) => (
          <textarea
            id={id}
            dir="auto"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            className={`resize-none py-4 ${fieldClass}`}
          />
        )}
      </Section>
      {node.type === "autonomous" ? <AutonomousFields node={node} update={update} /> : null}
      {node.type === "standard" ? <CardList node={node} summary={summary} /> : null}
    </div>
  );
}

function AutonomousFields({
  node,
  update,
}: {
  node: Extract<Node, { type: "autonomous" }>;
  update: (fn: (n: Node) => Node) => void;
}) {
  const [instructions, setInstructions] = useDraft(node.instructions);
  const set = <K extends keyof typeof node>(key: K, value: (typeof node)[K]) =>
    update((n) => (n.type === "autonomous" ? { ...n, [key]: value } : n));
  return (
    <>
      <Section label="Instructions" hint="What the agent is for, what it must never do, and when to leave.">
        {(id) => (
          <textarea
            id={id}
            dir="auto"
            rows={8}
            value={instructions}
            placeholder="Help the customer track an order…"
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => instructions !== node.instructions && set("instructions", instructions)}
            className={`resize-y py-4 ${fieldClass}`}
          />
        )}
      </Section>
      <Section label="Temperature" hint="Lower is more predictable. 0.3 suits most support agents.">
        {(id) => (
          <div className="flex items-center gap-5">
            <input
              id={id}
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={node.temperature}
              onChange={(e) => set("temperature", Number(e.target.value))}
              className="min-w-0 flex-1 accent-accent"
            />
            <output
              htmlFor={id}
              className="w-10 rounded-sm border border-hairline py-2 text-center text-body tabular-nums"
            >
              {node.temperature.toFixed(1)}
            </output>
          </div>
        )}
      </Section>
      <Section label="Steps per turn" hint="How many tool calls the agent may make before it must answer.">
        {(id) => (
          <input
            id={id}
            type="number"
            min={1}
            max={20}
            value={node.maxIterations}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 20) set("maxIterations", v);
            }}
            className={`h-control w-11 tabular-nums ${fieldClass}`}
          />
        )}
      </Section>
      <Toggle
        label="Talks with the user"
        hint="Off: runs once and must leave through an exit."
        checked={node.conversational}
        onChange={(v) => set("conversational", v)}
      />
      <Toggle
        label="Can hand off to a person"
        hint="Adds the built-in handoff exit."
        checked={node.allowHandoff}
        onChange={(v) => set("allowHandoff", v)}
      />
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-5">
      <label htmlFor={id} className="flex flex-col gap-1">
        <span className="text-small font-medium text-primary">{label}</span>
        <span className="text-small text-tertiary">{hint}</span>
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-7 w-10 shrink-0 items-center rounded-full p-1 transition-colors",
          checked ? "justify-end bg-accent" : "justify-start bg-muted",
        ].join(" ")}
      >
        <span aria-hidden="true" className="size-6 rounded-full bg-surface shadow-pop" />
      </button>
    </div>
  );
}

function CardList({ node, summary }: { node: Extract<Node, { type: "standard" }>; summary: SummaryContext }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small font-medium text-primary">Cards</p>
      {node.cards.length === 0 ? (
        <p className="rounded-md border border-dashed border-hairline px-5 py-6 text-center text-small text-secondary">
          No cards yet
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {node.cards.map((card) => {
            const Icon = CARD_ICONS[card.type];
            return (
              <li key={card.id} className="flex items-center gap-4 rounded-sm border border-hairline px-4 py-3">
                <IconTile category={CARD_CATEGORY[card.type]} icon={Icon} size="sm" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-small text-secondary">{CARD_NAMES[card.type]}</span>
                  <span dir="auto" className="truncate text-body text-primary">
                    {summarizeCard(card, summary)}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function IssueList({ issues }: { issues: readonly DefinitionIssue[] }) {
  if (issues.length === 0) {
    return <p className="px-6 py-9 text-center text-body text-secondary">Nothing to fix on this node</p>;
  }
  return (
    <ul className="flex flex-col gap-3 p-6">
      {issues.map((i) => {
        const Icon = i.severity === "error" ? CircleAlert : TriangleAlert;
        return (
          <li key={`${i.code}:${i.path}`} className="flex gap-4 rounded-md border border-hairline p-5">
            <Icon
              className={`mt-1 size-icon shrink-0 ${i.severity === "error" ? "text-error" : "text-warning"}`}
              strokeWidth={1.75}
              aria-label={i.severity === "error" ? "Error" : "Warning"}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p dir="auto" className="text-body text-primary">
                {i.message}
              </p>
              <p className="text-small text-secondary">{i.fix}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
