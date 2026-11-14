import { type Card, type Node as DefNode, NON_TARGETABLE_NODE_TYPES } from "@wakeel/contracts";
import { CATEGORY_CLASSES, type Category, IconTile, useMotionTokens } from "@wakeel/ui";
import { Handle, type NodeProps, Position, type Node as RFNode, useStore, useUpdateNodeInternals } from "@xyflow/react";
import { Check, CircleAlert, Ellipsis, GripVertical, Plus, TriangleAlert } from "lucide-react";
import { type HTMLMotionProps, motion, Reorder } from "motion/react";
import { type HTMLAttributes, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useRunOverlay } from "../../trace/overlay";
import { useCanvas, useCanvasStore } from "../context";
import { nodeRows } from "../interaction/rows";
import { useUi, useUiStore } from "../interaction/ui-store";
import type { NodeIssues } from "../issues";
import { commands } from "../store/commands";
import {
  CARD_CATEGORY,
  CARD_ICONS,
  CARD_NAMES,
  cardOutputRows,
  NODE_CATEGORY,
  NODE_ICONS,
  NODE_TYPE_LABELS,
  nodeOutputRows,
  nodeSubtitle,
  type OutputRow,
  type SummaryContext,
  summarizeCard,
} from "./summaries";

/**
 * A node on the canvas (design system §4 Canvas, §5.1, ADR-017): a header with the category icon
 * tile, the name and what the node is; then one inset row per card (standard) or the instructions
 * (autonomous); then its outputs, each with a dot in the category colour on the end edge.
 * Transitions enter at the header's start edge. Below 50% zoom only the header shows.
 *
 * Task 2.5: the name renames in place (double-click, `F2`); card rows reorder by dragging their
 * grip; "Add card" opens the card menu; the keyboard cursor and connect target are drawn here.
 */
export interface CanvasNodeData extends Record<string, unknown> {
  node: DefNode;
  summary: SummaryContext;
  issues: NodeIssues | undefined;
}

export type CanvasRFNode = RFNode<CanvasNodeData, "wk">;

const COMPACT_BELOW = 0.5;

function IssueMarker({ severity, label }: { severity: "error" | "warning"; label: string }) {
  const Icon = severity === "error" ? CircleAlert : TriangleAlert;
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      <Icon
        className={`size-icon-sm ${severity === "error" ? "text-error" : "text-warning"}`}
        strokeWidth={1.5}
        aria-hidden="true"
      />
    </span>
  );
}

/** An output row with its dot. The dot's hit area is 16 px around an 8 px dot (§4 OutputDot). */
function Output({
  row,
  category,
  cursor,
  connecting,
  children,
}: {
  row: OutputRow;
  category: Category;
  cursor: boolean;
  connecting: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={[
        "relative mx-2 flex h-row items-center gap-3 rounded-sm px-4",
        cursor ? "bg-accent-subtle" : "",
        connecting ? "wk-connect-source" : "",
      ].join(" ")}
    >
      {children ?? (
        // Outputs sit on the end edge whatever the label's direction, so the margin is physical.
        <span dir="auto" className="ml-auto truncate text-small text-secondary">
          {row.label}
        </span>
      )}
      <Handle
        type="source"
        position={Position.Right}
        id={row.port}
        aria-label={`Output ${row.label}`}
        className={`wk-output ${CATEGORY_CLASSES[category].port}`}
      />
    </div>
  );
}

/** Which row the keyboard cursor and connect mode are on, for this node only. */
function useRowState(nodeId: string) {
  const cursorRow = useUi((s) => (s.cursor?.nodeId === nodeId ? s.cursor.row : -1));
  const connectingPort = useUi((s) => (s.connecting?.from.nodeId === nodeId ? s.connecting.from.port : undefined));
  const selectedCard = useCanvas((s) => (s.selection.card?.nodeId === nodeId ? s.selection.card.cardId : undefined));
  return { cursorRow, connectingPort, selectedCard };
}

function CardRow({
  card,
  summary,
  severity,
  message,
  cardIndex,
  outputIndex,
  rowState,
  dragging,
  onSelect,
}: {
  card: Card;
  summary: SummaryContext;
  severity: "error" | "warning" | undefined;
  message: string | undefined;
  cardIndex: number;
  outputIndex: (port: string) => number;
  rowState: ReturnType<typeof useRowState>;
  dragging: boolean;
  onSelect: () => void;
}) {
  const Icon = CARD_ICONS[card.type];
  const category = CARD_CATEGORY[card.type];
  const outputs = cardOutputRows(card);
  const text = summarizeCard(card, summary);
  const current = rowState.cursorRow === cardIndex || rowState.selectedCard === card.id;
  // The last emulator turn's path (§5.1 "Run overlay"): tinted, with a check when it did not fail.
  const overlay = useRunOverlay();
  const ran = overlay.cards.has(card.id);
  const ranFailed = overlay.failed.has(card.id);
  return (
    <div data-card={card.id} className={card.disabled ? "opacity-50" : ""}>
      {/* Clicking a card opens it in the inspector; the keyboard reaches cards with Enter (2.5). */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Enter on the node, then the arrows. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above. */}
      <div
        onClick={onSelect}
        className={[
          "group mx-4 flex h-row-card cursor-pointer items-center gap-3 rounded-sm border px-3",
          dragging ? "bg-surface shadow-drag" : "bg-subtle",
          severity === "error"
            ? "border-error"
            : severity === "warning"
              ? "border-warning"
              : current
                ? "border-accent"
                : ran || ranFailed
                  ? "border-accent-border"
                  : "border-transparent",
        ].join(" ")}
        {...(ran ? { "data-ran": "true" } : {})}
      >
        <GripVertical
          className="size-icon-sm shrink-0 cursor-grab text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <Icon
          className={`size-icon-sm shrink-0 ${CATEGORY_CLASSES[category].icon}`}
          strokeWidth={1.75}
          aria-label={CARD_NAMES[card.type]}
        />
        <span dir="auto" className="min-w-0 flex-1 truncate text-body text-primary">
          {text}
        </span>
        {ran ? (
          <Check
            className="size-icon-sm shrink-0 text-accent-border"
            strokeWidth={2}
            aria-label="Ran in the last test"
          />
        ) : null}
        {severity ? <IssueMarker severity={severity} label={message ?? ""} /> : null}
      </div>
      {outputs.map((row) => (
        <Output
          key={row.port}
          row={row}
          category={category}
          cursor={rowState.cursorRow === outputIndex(row.port)}
          connecting={rowState.connectingPort === row.port}
        />
      ))}
    </div>
  );
}

/**
 * The cards of a standard node. Dragging a row's grip reorders with `spring.snappy` (§5.1 motion
 * table); the new order is committed as one `moveCard` on release, so it is one undo step.
 */
function Cards({
  node,
  summary,
  issues,
  rowState,
}: {
  node: Extract<DefNode, { type: "standard" }>;
  summary: SummaryContext;
  issues: NodeIssues | undefined;
  rowState: ReturnType<typeof useRowState>;
}) {
  const store = useCanvasStore();
  const tokens = useMotionTokens();
  const ids = useMemo(() => node.cards.map((c) => c.id), [node.cards]);
  const [order, setOrder] = useState(ids);
  const [dragging, setDragging] = useState<string>();
  useEffect(() => setOrder(ids), [ids]);
  const byId = useMemo(() => new Map(node.cards.map((c) => [c.id, c])), [node.cards]);
  const rows = useMemo(() => nodeRows(node), [node]);
  const rowIndex = (pred: (r: (typeof rows)[number]) => boolean) => rows.findIndex(pred);

  const commit = (cardId: string) => {
    setDragging(undefined);
    const to = order.indexOf(cardId);
    if (to !== -1 && to !== ids.indexOf(cardId)) store.getState().execute(commands.moveCard(node.id, cardId, to));
  };

  return (
    <Reorder.Group as="div" axis="y" values={order} onReorder={setOrder} className="flex flex-col gap-2">
      {order.map((id) => {
        const card = byId.get(id);
        if (!card) return null;
        const issue = issues?.cards.get(card.id);
        return (
          <Reorder.Item
            key={id}
            as="div"
            value={id}
            // nodrag: dragging a card moves the card, not the node.
            className="nodrag relative"
            transition={tokens.spring.snappy}
            onDragStart={() => setDragging(id)}
            onDragEnd={() => commit(id)}
          >
            <CardRow
              card={card}
              summary={summary}
              severity={issue?.severity}
              message={issue?.message}
              cardIndex={rowIndex((r) => r.kind === "card" && r.cardId === id)}
              outputIndex={(port) => rowIndex((r) => r.kind === "output" && r.port === port)}
              rowState={rowState}
              dragging={dragging === id}
              onSelect={() =>
                store.getState().select({ nodeIds: [node.id], edgeIds: [], card: { nodeId: node.id, cardId: id } })
              }
            />
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
  );
}

function Body({ data, rowState }: { data: CanvasNodeData; rowState: ReturnType<typeof useRowState> }) {
  const { node, summary, issues } = data;
  const ui = useUiStore();
  switch (node.type) {
    case "standard":
      return (
        <>
          {node.cards.length === 0 ? (
            <p className="px-6 py-2 text-small text-tertiary">No cards yet</p>
          ) : (
            <Cards node={node} summary={summary} issues={issues} rowState={rowState} />
          )}
          <button
            type="button"
            data-add-card={node.id}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              ui.getState().set({ menu: { kind: "card", nodeId: node.id, at: { x: r.left, y: r.bottom + 4 } } });
            }}
            className="nodrag mx-4 flex h-control-sm items-center gap-3 rounded-sm border border-dashed border-hairline px-3 text-small text-secondary transition-colors hover:border-strong hover:text-primary"
          >
            <Plus className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
            Add card
          </button>
        </>
      );
    case "autonomous": {
      const firstLine = node.instructions
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.trim();
      return (
        <div className="mx-4 flex flex-col gap-2 rounded-sm bg-subtle px-4 py-4">
          <p dir="auto" className={`line-clamp-2 text-body ${firstLine ? "text-primary" : "text-tertiary"}`}>
            {firstLine ?? "No instructions yet"}
          </p>
          {node.tools.length > 0 ? (
            <p className="truncate text-small text-secondary">
              <span className="text-tertiary">Tools </span>
              <span className="font-mono">{node.tools.map((t) => t.name).join(" · ")}</span>
            </p>
          ) : null}
        </div>
      );
    }
    case "note":
      return node.text ? (
        <p dir="auto" className="whitespace-pre-wrap px-6 pb-2 text-body text-secondary">
          {node.text}
        </p>
      ) : null;
    default:
      return null;
  }
}

/** The name, or an input while renaming (double-click, `F2`). Enter or blur commits; Esc cancels. */
function Name({ node }: { node: DefNode }) {
  const renaming = useUi((s) => s.renaming === node.id);
  const ui = useUiStore();
  const store = useCanvasStore();
  const [draft, setDraft] = useState(node.name);
  useEffect(() => {
    if (renaming) setDraft(node.name);
  }, [renaming, node.name]);
  const done = (commit: boolean) => {
    const next = draft.trim();
    if (commit && next && next !== node.name) store.getState().execute(commands.renameNode(node.id, next));
    ui.getState().set({ renaming: undefined });
  };
  if (renaming) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: renaming starts from the keyboard or a double-click and expects typing.
        autoFocus
        aria-label="Node name"
        dir="auto"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done(true);
          else if (e.key === "Escape") done(false);
          e.stopPropagation();
        }}
        className="nodrag h-control-sm w-full rounded-xs border border-accent bg-surface px-2 text-body font-semibold text-primary"
      />
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click to rename mirrors F2, the keyboard path.
    <span
      dir="auto"
      onDoubleClick={(e) => {
        e.stopPropagation();
        ui.getState().set({ renaming: node.id });
      }}
      // The name keeps its own direction but stays next to the icon in the left-to-right chrome.
      className="truncate text-left text-body font-semibold text-primary"
    >
      {node.name}
    </span>
  );
}

function CanvasNodeView({ id, data, selected }: NodeProps<CanvasRFNode>) {
  const { node, issues } = data;
  const compact = useStore((s) => s.transform[2] < COMPACT_BELOW);
  const fresh = useUi((s) => s.fresh.has(id));
  const target = useUi((s) => s.dropTarget === id || s.connecting?.target === id);
  const ui = useUiStore();
  const rowState = useRowState(id);
  const updateInternals = useUpdateNodeInternals();
  const Icon = NODE_ICONS[node.type];
  const category = NODE_CATEGORY[node.type];
  const classes = CATEGORY_CLASSES[category];
  const targetable = !NON_TARGETABLE_NODE_TYPES.includes(node.type);
  const outputs = nodeOutputRows(node);
  const rows = useMemo(() => nodeRows(node), [node]);
  const cardCount = node.type === "standard" ? node.cards.length : 0;
  const nodeIssue = issues?.node;
  const hasBody =
    !compact && (node.type === "standard" || node.type === "autonomous" || (node.type === "note" && node.text));

  // Outputs move when cards are added, removed or reordered; xyflow re-measures handles only on
  // resize, so tell it, or transitions would stay attached to where the dots used to be. Not on
  // mount: xyflow measures new nodes itself, and 300 forced re-measures would slow opening.
  const mounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the node document is the trigger.
  useEffect(() => {
    if (mounted.current) updateInternals(id);
    mounted.current = true;
  }, [node, id, updateInternals]);

  return (
    <Shell
      fresh={fresh}
      aria-label={`${node.name}, ${NODE_TYPE_LABELS[node.type].toLowerCase()}${node.type === "standard" ? `, ${cardCount} ${cardCount === 1 ? "card" : "cards"}` : ""}`}
      className={[
        "flex w-node flex-col overflow-visible rounded-lg border bg-surface shadow-node transition-colors",
        selected ? "border-accent outline-2 outline-accent outline-offset-1" : `${classes.border} hover:border-strong`,
        nodeIssue?.severity === "error" && !selected ? "border-error" : "",
        target ? "wk-drop-target" : "",
      ].join(" ")}
    >
      <header className="relative flex items-center gap-4 px-5 py-5">
        {targetable ? (
          <Handle
            type="target"
            position={Position.Left}
            id="in"
            isConnectableStart={false}
            className={`wk-input ${classes.port}`}
          />
        ) : null}
        <IconTile category={category} icon={Icon} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Name node={node} />
          <span className="truncate text-small text-secondary">{nodeSubtitle(node)}</span>
        </div>
        {nodeIssue ? <IssueMarker severity={nodeIssue.severity} label={nodeIssue.message} /> : null}
        {compact && node.type === "standard" ? (
          <span className="text-small text-secondary tabular-nums">{cardCount}</span>
        ) : null}
        {compact ? null : (
          <button
            type="button"
            aria-label={`Actions for ${node.name}`}
            aria-haspopup="menu"
            title="Node actions"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              ui.getState().set({ menu: { kind: "actions", nodeId: node.id, at: { x: r.left, y: r.bottom + 4 } } });
            }}
            className="nodrag flex size-control-sm shrink-0 items-center justify-center rounded-sm text-tertiary hover:bg-subtle hover:text-primary"
          >
            <Ellipsis className="size-icon" strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </header>
      {compact ? (
        // Compact form keeps every output so transitions still have somewhere to attach.
        <div className="relative">
          {[...(node.type === "standard" ? node.cards.flatMap(cardOutputRows) : []), ...outputs].map((row) => (
            <Handle
              key={row.port}
              type="source"
              position={Position.Right}
              id={row.port}
              className={`wk-output ${classes.port}`}
            />
          ))}
        </div>
      ) : (
        <>
          {hasBody ? (
            <div className="flex flex-col gap-2 border-t border-hairline pt-4">
              <Body data={data} rowState={rowState} />
            </div>
          ) : null}
          {outputs.length > 0 ? (
            <div className={`flex flex-col py-2 ${hasBody ? "" : "border-t border-hairline"}`}>
              {outputs.map((row) => (
                <Output
                  key={row.port}
                  row={row}
                  category={category}
                  cursor={rowState.cursorRow === rows.findIndex((r) => r.kind === "output" && r.port === row.port)}
                  connecting={rowState.connectingPort === row.port}
                />
              ))}
            </div>
          ) : hasBody ? (
            <span className="h-4" />
          ) : null}
        </>
      )}
    </Shell>
  );
}

/**
 * The node's outer element. Only a node added a moment ago is a Motion element, for its entrance
 * (§5.1 motion table: scale 0.96 → 1 and fade in on spring.gentle); the other 299 stay plain, so
 * opening a large workflow does not create 300 Motion components.
 */
function Shell({ fresh, children, ...rest }: { fresh: boolean; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  const tokens = useMotionTokens();
  if (!fresh) return <article {...rest}>{children}</article>;
  return (
    <motion.article
      {...(rest as HTMLMotionProps<"article">)}
      initial={{ opacity: 0, scale: tokens.reduced ? 1 : 0.96 }}
      animate={{ opacity: 1, scale: 1, transition: tokens.spring.gentle }}
    >
      {children}
    </motion.article>
  );
}

export const CanvasNode = memo(CanvasNodeView);
