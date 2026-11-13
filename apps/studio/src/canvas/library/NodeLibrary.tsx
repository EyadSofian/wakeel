import type { NodeType, Workflow } from "@wakeel/contracts";
import { Chip, Count, IconTile } from "@wakeel/ui";
import { ChevronDown, Search } from "lucide-react";
import { type DragEvent, useId, useMemo, useState } from "react";
import { useCanvas } from "../context";
import { NODE_CATEGORY, NODE_ICONS, NODE_TYPE_LABELS } from "../view/summaries";

/**
 * The node library (ADR-017, design system §5.1 resource panel): every node a builder can add to
 * the open workflow, grouped by what it is for. Click adds the node at the centre of the canvas;
 * dragging it onto the canvas drops it where it lands. A second tab lists the bot's workflows.
 */
export const NODE_DRAG_TYPE = "application/x-wakeel-node";

type Group = "Triggers" | "Logic" | "AI" | "Flow";

interface Entry {
  type: NodeType;
  group: Group;
  description: string;
  /** Only offered in workflows of these kinds. */
  kinds?: Workflow["kind"][];
}

const ENTRIES: Entry[] = [
  { type: "trigger", group: "Triggers", description: "Runs on an event, a new conversation or inactivity" },
  { type: "standard", group: "Logic", description: "Runs cards in order: messages, questions, conditions" },
  { type: "autonomous", group: "AI", description: "The model decides, using only the tools you list" },
  { type: "end", group: "Flow", description: "Ends the conversation" },
  { type: "exit", group: "Flow", description: "Returns to the workflow that called this one", kinds: ["sub"] },
  { type: "error_handler", group: "Flow", description: "Runs when a step fails", kinds: ["error"] },
  { type: "note", group: "Flow", description: "A note for builders; it never runs" },
];

const GROUPS: Group[] = ["Triggers", "Logic", "AI", "Flow"];

export function NodeLibrary({ onAdd }: { onAdd: (type: NodeType) => void }) {
  const [tab, setTab] = useState<"nodes" | "workflows">("nodes");
  return (
    <aside aria-label="Library" className="flex w-resource-panel shrink-0 flex-col border-e border-hairline bg-surface">
      <div role="tablist" aria-label="Library" className="flex gap-6 border-b border-hairline px-6">
        {(
          [
            ["nodes", "Nodes"],
            ["workflows", "Workflows"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={[
              "inline-flex h-control-lg items-center border-b-2 text-body font-medium transition-colors",
              tab === id ? "border-accent text-primary" : "border-transparent text-secondary hover:text-primary",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "nodes" ? <Nodes onAdd={onAdd} /> : <Workflows />}
    </aside>
  );
}

function Nodes({ onAdd }: { onAdd: (type: NodeType) => void }) {
  const kind = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc.kind : undefined));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Group | "All">("All");
  const [closed, setClosed] = useState<ReadonlySet<Group>>(new Set());
  const searchId = useId();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ENTRIES.filter(
      (e) =>
        (!e.kinds || (kind !== undefined && e.kinds.includes(kind))) &&
        (filter === "All" || e.group === filter) &&
        (q === "" || `${NODE_TYPE_LABELS[e.type]} ${e.description}`.toLowerCase().includes(q)),
    );
  }, [query, filter, kind]);

  const toggle = (g: Group) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const onDragStart = (e: DragEvent, type: NodeType) => {
    e.dataTransfer.setData(NODE_DRAG_TYPE, type);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-5">
      <label htmlFor={searchId} className="relative block">
        <span className="sr-only">Search nodes</span>
        <Search
          className="pointer-events-none absolute start-4 top-1/2 size-icon -translate-y-1/2 text-tertiary"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes"
          dir="auto"
          className="h-control w-full rounded-sm border border-hairline bg-subtle pe-4 ps-9 text-body text-primary placeholder:text-tertiary transition-colors hover:border-strong focus-visible:border-accent"
        />
      </label>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Filter by group</legend>
        {(["All", ...GROUPS] as const).map((g) => (
          <Chip key={g} pressed={filter === g} onClick={() => setFilter(g)}>
            {g}
          </Chip>
        ))}
      </fieldset>
      {visible.length === 0 ? (
        <p className="px-2 py-6 text-center text-body text-secondary">No node matches "{query.trim()}"</p>
      ) : (
        GROUPS.map((g) => {
          const items = visible.filter((e) => e.group === g);
          if (items.length === 0) return null;
          const open = !closed.has(g);
          return (
            <section key={g} className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(g)}
                className="flex h-row items-center gap-3 rounded-sm px-2 text-body font-semibold text-primary hover:bg-subtle"
              >
                <ChevronDown
                  className={`size-icon-sm text-tertiary transition-transform ${open ? "" : "-rotate-90"}`}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="flex-1 text-start">{g}</span>
                <Count>{items.length}</Count>
              </button>
              {open
                ? items.map((e) => (
                    <button
                      key={e.type}
                      type="button"
                      draggable
                      onDragStart={(ev) => onDragStart(ev, e.type)}
                      onClick={() => onAdd(e.type)}
                      title={`Add ${NODE_TYPE_LABELS[e.type].toLowerCase()}`}
                      className="flex items-center gap-4 rounded-md border border-transparent p-3 text-start transition-colors hover:border-hairline hover:bg-subtle"
                    >
                      <IconTile category={NODE_CATEGORY[e.type]} icon={NODE_ICONS[e.type]} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-body font-medium text-primary">{NODE_TYPE_LABELS[e.type]}</span>
                        <span className="line-clamp-2 text-small text-secondary">{e.description}</span>
                      </span>
                    </button>
                  ))
                : null}
            </section>
          );
        })
      )}
    </div>
  );
}

function Workflows() {
  const workflows = useCanvas((s) => s.workflows);
  const active = useCanvas((s) => s.activeWorkflowId);
  const open = useCanvas((s) => s.open);
  const list = Object.values(workflows).map((w) => w.doc);
  return (
    <ul className="flex flex-col gap-1 p-5">
      {list.map((wf) => (
        <li key={wf.id}>
          <button
            type="button"
            aria-current={wf.id === active ? "page" : undefined}
            onClick={() => open(wf.id)}
            className={[
              "flex h-row w-full items-center gap-4 rounded-sm px-4 text-body transition-colors",
              wf.id === active ? "bg-accent-subtle text-accent-text" : "text-primary hover:bg-subtle",
            ].join(" ")}
          >
            <span dir="auto" className="min-w-0 flex-1 truncate text-start font-medium">
              {wf.name}
            </span>
            <span className="text-small text-tertiary tabular-nums">{wf.nodes.length}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
