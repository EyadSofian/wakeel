import type { Card, DefinitionIssue, Node } from "@wakeel/contracts";
import { Button, Count, IconTile, Switch, useMotionTokens } from "@wakeel/ui";
import { ArrowLeft, CircleAlert, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { useUiStore } from "../canvas/interaction/ui-store";
import { commands } from "../canvas/store/commands";
import {
  CARD_CATEGORY,
  CARD_ICONS,
  CARD_NAMES,
  NODE_CATEGORY,
  NODE_ICONS,
  nodeSubtitle,
  type SummaryContext,
  summarizeCard,
} from "../canvas/view/summaries";
import { ModelField } from "./autonomous/ModelSection";
import { AskForm, ConditionForm, EndForm, LogForm, SayForm, SetVariableForm } from "./cards/CardForms";
import { IssuesContext, Section, StringField, useCommitCard, useDraft } from "./fields";

/**
 * The inspector (design system §5.2, task 2.6): docked on the end side while exactly one node is
 * selected. The node view edits the node; selecting a card pushes a card view in the same panel
 * with a back arrow (slides 12 px and fades, `duration.slow`), and `Esc` goes back. Changing the
 * selection cross-fades the content in 120 ms; the panel itself never moves.
 */
export function Inspector({ issues, summary }: { issues: readonly DefinitionIssue[]; summary: SummaryContext }) {
  const wfId = useCanvas((s) => s.activeWorkflowId);
  const node = useCanvas((s) => {
    if (s.selection.nodeIds.length !== 1 || !s.activeWorkflowId) return undefined;
    const id = s.selection.nodeIds[0];
    return s.workflows[s.activeWorkflowId]?.doc.nodes.find((n) => n.id === id);
  });
  const cardId = useCanvas((s) => (s.selection.card?.nodeId === node?.id ? s.selection.card?.cardId : undefined));
  const store = useCanvasStore();
  const tokens = useMotionTokens();
  if (!node || !wfId) return null;
  const card = node.type === "standard" ? node.cards.find((c) => c.id === cardId) : undefined;
  const back = () => store.getState().select({ card: undefined });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    // Blur first, so the field being edited commits before its view goes away.
    (document.activeElement as HTMLElement | null)?.blur();
    if (card) back();
    else store.getState().clearSelection();
  };

  return (
    <IssuesContext.Provider value={issues}>
      <aside
        aria-label={`Inspector: ${card ? CARD_NAMES[card.type] : node.name}`}
        onKeyDown={onKeyDown}
        className="flex w-inspector shrink-0 flex-col overflow-hidden border-s border-hairline bg-surface"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={card ? `${node.id}:${card.id}` : node.id}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0, x: card ? tokens.travel + 4 : 0 }}
            animate={{ opacity: 1, x: 0, transition: { duration: card ? tokens.duration.slow : tokens.duration.fast } }}
            exit={{ opacity: 0, transition: { duration: tokens.duration.fast } }}
          >
            <Presence>
              {card && node.type === "standard" ? (
                <CardView node={node} card={card} wfId={wfId} summary={summary} onBack={back} issues={issues} />
              ) : (
                <NodeView node={node} wfId={wfId} summary={summary} issues={issues} />
              )}
            </Presence>
          </motion.div>
        </AnimatePresence>
      </aside>
    </IssuesContext.Provider>
  );
}

/**
 * While a view fades out it is still in the DOM; it must not take focus, typing or the screen
 * reader's attention, or an edit made in those 120 ms lands in the view that is leaving.
 */
function Presence({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return (
    <div inert={!present} aria-hidden={!present || undefined} className="flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  );
}

function Header({
  icon,
  title,
  subtitle,
  onBack,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  return (
    <header className="flex items-start gap-4 border-b border-hairline px-6 py-5">
      {onBack ? (
        <button
          type="button"
          aria-label="Back to the node"
          title="Back (Esc)"
          onClick={onBack}
          className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
        >
          <ArrowLeft className="size-icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 dir="auto" className="truncate text-title text-primary">
          {title}
        </h2>
        <p dir="auto" className="truncate text-small text-secondary">
          {subtitle}
        </p>
      </div>
      <button
        type="button"
        aria-label="Close inspector"
        title="Close"
        onClick={onClose}
        className="flex size-control-sm shrink-0 items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
      >
        <X className="size-icon" strokeWidth={1.75} aria-hidden="true" />
      </button>
    </header>
  );
}

function NodeView({
  node,
  wfId,
  summary,
  issues,
}: {
  node: Node;
  wfId: string;
  summary: SummaryContext;
  issues: readonly DefinitionIssue[];
}) {
  const store = useCanvasStore();
  const [tab, setTab] = useState<"configure" | "issues">("configure");
  const mine = issues.filter((i) => i.nodeId === node.id && !i.cardId);
  const Icon = NODE_ICONS[node.type];
  return (
    <>
      <Header
        icon={<IconTile category={NODE_CATEGORY[node.type]} icon={Icon} size="lg" />}
        title={node.name}
        subtitle={nodeSubtitle(node)}
        onClose={() => store.getState().clearSelection()}
      />
      <div role="tablist" aria-label="Inspector" className="flex gap-6 border-b border-hairline px-6">
        <TabButton selected={tab === "configure"} onClick={() => setTab("configure")}>
          Configure
        </TabButton>
        <TabButton selected={tab === "issues"} onClick={() => setTab("issues")}>
          Issues
          {mine.length > 0 ? <Count>{mine.length}</Count> : null}
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "configure" ? (
          <NodeConfigure key={node.id} node={node} wfId={wfId} summary={summary} />
        ) : (
          <IssueList issues={mine} />
        )}
      </div>
    </>
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

function NodeConfigure({ node, wfId, summary }: { node: Node; wfId: string; summary: SummaryContext }) {
  const store = useCanvasStore();
  const [name, setName] = useDraft(node.name);
  const [description, setDescription] = useDraft(node.description ?? "");
  const update = (fn: (n: Node) => Node) => store.getState().execute(commands.updateNode(node.id, fn));
  const path = `workflows.${wfId}.nodes.${node.id}`;

  const commitName = () => {
    const next = name.trim();
    if (next && next !== node.name) store.getState().execute(commands.renameNode(node.id, next));
    else setName(node.name);
  };
  const commitDescription = () => {
    const next = description.trim();
    if (next === (node.description ?? "")) return;
    update((n) => {
      const { description: _old, ...rest } = n;
      return (next ? { ...rest, description: next } : rest) as Node;
    });
  };

  return (
    <>
      <Section id="general" nodeType={node.type} title="General">
        <PlainField label="Name" value={name} onChange={setName} onCommit={commitName} />
        <PlainField
          label="Description"
          help="For builders. The bot never sees it."
          value={description}
          onChange={setDescription}
          onCommit={commitDescription}
          multiline
        />
      </Section>
      {node.type === "standard" ? <CardsSection node={node} summary={summary} /> : null}
      {node.type === "autonomous" ? <AutonomousSections node={node} path={path} update={update} /> : null}
      {node.type === "end" ? (
        <Section id="end" nodeType={node.type} title="End">
          <StringField
            label="Reason"
            help='Recorded on the conversation, for example "completed".'
            value={node.reason}
            check="text"
            path={`${path}.reason`}
            node={node}
            rows={1}
            onCommit={(reason) => update((n) => (n.type === "end" ? { ...n, reason: reason || "completed" } : n))}
          />
        </Section>
      ) : null}
    </>
  );
}

function PlainField({
  label,
  help,
  value,
  onChange,
  onCommit,
  multiline = false,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  multiline?: boolean;
}) {
  const id = useId();
  const cls =
    "w-full rounded-sm border border-hairline bg-surface px-5 text-body text-primary transition-colors hover:border-strong focus-visible:border-accent";
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={id} className="text-small font-medium text-primary">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          dir="auto"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          className={`${cls} resize-none py-3`}
        />
      ) : (
        <input
          id={id}
          dir="auto"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={`${cls} h-control`}
        />
      )}
      {help ? <span className="text-small text-tertiary">{help}</span> : null}
    </div>
  );
}

function CardsSection({ node, summary }: { node: Extract<Node, { type: "standard" }>; summary: SummaryContext }) {
  const store = useCanvasStore();
  const ui = useUiStore();
  return (
    <Section
      id="cards"
      nodeType={node.type}
      title="Cards"
      action={
        <button
          type="button"
          aria-label="Add card"
          title="Add card (C)"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            ui.getState().set({ menu: { kind: "card", nodeId: node.id, at: { x: r.right - 320, y: r.bottom + 4 } } });
          }}
          className="flex size-control-sm items-center justify-center rounded-sm text-secondary hover:bg-subtle hover:text-primary"
        >
          <Plus className="size-icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      }
    >
      {node.cards.length === 0 ? (
        <p className="rounded-md border border-dashed border-hairline px-5 py-6 text-center text-small text-secondary">
          No cards yet
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {node.cards.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => store.getState().select({ card: { nodeId: node.id, cardId: card.id } })}
                className={[
                  "flex w-full items-center gap-4 rounded-sm border border-hairline px-4 py-3 text-start transition-colors hover:border-strong hover:bg-subtle",
                  card.disabled ? "opacity-50" : "",
                ].join(" ")}
              >
                <IconTile category={CARD_CATEGORY[card.type]} icon={CARD_ICONS[card.type]} size="sm" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-small text-secondary">{CARD_NAMES[card.type]}</span>
                  <span dir="auto" className="truncate text-body text-primary">
                    {summarizeCard(card, summary)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function AutonomousSections({
  node,
  path,
  update,
}: {
  node: Extract<Node, { type: "autonomous" }>;
  path: string;
  update: (fn: (n: Node) => Node) => void;
}) {
  const set = <K extends keyof typeof node>(key: K, value: (typeof node)[K]) =>
    update((n) => (n.type === "autonomous" ? { ...n, [key]: value } : n));
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
          onCommit={(instructions) => set("instructions", instructions)}
        />
      </Section>
      <Section id="advanced" nodeType={node.type} title="Advanced">
        <ModelField
          node={node}
          onChange={(model) =>
            update((n) => {
              if (n.type !== "autonomous") return n;
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
              onChange={(e) => set("temperature", Number(e.target.value))}
              className="min-w-0 flex-1 accent-accent"
            />
            <output className="w-10 rounded-sm border border-hairline py-2 text-center text-body tabular-nums">
              {node.temperature.toFixed(1)}
            </output>
          </span>
          <span className="text-small text-tertiary">Lower is more predictable. 0.3 suits most support agents.</span>
        </label>
        <label className="flex flex-col gap-3">
          <span className="text-small font-medium text-primary">Steps per turn</span>
          <input
            type="number"
            min={1}
            max={20}
            value={node.maxIterations}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 20) set("maxIterations", v);
            }}
            className="h-control w-11 rounded-sm border border-hairline bg-surface px-4 text-body tabular-nums"
          />
          <span className="text-small text-tertiary">
            How many tool calls the agent may make before it must answer.
          </span>
        </label>
        <Switch
          label="Talks with the user"
          hint="Off: runs once and must leave through an exit."
          checked={node.conversational}
          onChange={(v) => set("conversational", v)}
        />
        <Switch
          label="Can hand off to a person"
          hint="Adds the built-in handoff exit."
          checked={node.allowHandoff}
          onChange={(v) => set("allowHandoff", v)}
        />
      </Section>
    </>
  );
}

/** The card sub-view: the card's form, its switch, and delete. Other card types arrive with their tasks. */
function CardView({
  node,
  card,
  wfId,
  summary,
  onBack,
  issues,
}: {
  node: Extract<Node, { type: "standard" }>;
  card: Card;
  wfId: string;
  summary: SummaryContext;
  onBack: () => void;
  issues: readonly DefinitionIssue[];
}) {
  const store = useCanvasStore();
  const commitCard = useCommitCard(node.id);
  const path = `workflows.${wfId}.nodes.${node.id}.cards.${card.id}`;
  const commit = (next: Card) => {
    commitCard(next);
  };
  const props = { node, path, commit };
  const cardIssues = issues.filter((i) => i.cardId === card.id && !i.path.startsWith(`${path}.`));
  return (
    <>
      <Header
        icon={<IconTile category={CARD_CATEGORY[card.type]} icon={CARD_ICONS[card.type]} size="lg" />}
        title={CARD_NAMES[card.type]}
        subtitle={`${node.name} · ${summarizeCard(card, summary)}`}
        onBack={onBack}
        onClose={() => store.getState().clearSelection()}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
        {cardIssues.length > 0 ? <IssueList issues={cardIssues} compact /> : null}
        {card.type === "say" ? <SayForm card={card} {...props} /> : null}
        {card.type === "capture" ? <AskForm card={card} {...props} /> : null}
        {card.type === "branch" ? <ConditionForm card={card} {...props} /> : null}
        {card.type === "set_variable" ? <SetVariableForm card={card} {...props} /> : null}
        {card.type === "log" ? <LogForm card={card} {...props} /> : null}
        {card.type === "end" ? <EndForm card={card} {...props} /> : null}
        {["say", "capture", "branch", "set_variable", "log", "end"].includes(card.type) ? null : (
          <p className="rounded-md border border-dashed border-hairline px-5 py-6 text-center text-small text-secondary">
            This card's settings are not editable here yet.
          </p>
        )}
        <div className="flex flex-col gap-5 border-t border-hairline pt-6">
          <Switch
            label="Turned off"
            hint="Skipped when the bot runs, and drawn dimmed."
            checked={card.disabled}
            onChange={(disabled) => commit({ ...card, disabled })}
          />
          <Button
            variant="danger"
            icon={<Trash2 className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => {
              store.getState().execute(commands.deleteCard(node.id, card.id));
              onBack();
            }}
            className="self-start"
          >
            Delete card
          </Button>
        </div>
      </div>
    </>
  );
}

function IssueList({ issues, compact = false }: { issues: readonly DefinitionIssue[]; compact?: boolean }) {
  if (issues.length === 0) {
    return <p className="px-6 py-9 text-center text-body text-secondary">Nothing to fix on this node</p>;
  }
  return (
    <ul className={`flex flex-col gap-3 ${compact ? "" : "p-6"}`}>
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
