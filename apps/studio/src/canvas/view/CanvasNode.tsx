import { type Node as DefNode, NON_TARGETABLE_NODE_TYPES } from "@wakeel/contracts";
import { CATEGORY_CLASSES, type Category, IconTile } from "@wakeel/ui";
import { Handle, type NodeProps, Position, type Node as RFNode, useStore } from "@xyflow/react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { memo, type ReactNode } from "react";
import type { NodeIssues } from "../issues";
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
function Output({ row, category, children }: { row: OutputRow; category: Category; children?: ReactNode }) {
  return (
    <div className="relative flex h-row items-center gap-3 px-6">
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

function CardRow({
  card,
  summary,
  severity,
  message,
}: {
  card: Extract<DefNode, { type: "standard" }>["cards"][number];
  summary: SummaryContext;
  severity: "error" | "warning" | undefined;
  message: string | undefined;
}) {
  const Icon = CARD_ICONS[card.type];
  const category = CARD_CATEGORY[card.type];
  const outputs = cardOutputRows(card);
  const text = summarizeCard(card, summary);
  return (
    <div data-card={card.id} className={card.disabled ? "opacity-50" : ""}>
      <div
        className={[
          "mx-4 flex h-row-card items-center gap-4 rounded-sm border bg-subtle px-4",
          severity === "error" ? "border-error" : severity === "warning" ? "border-warning" : "border-transparent",
        ].join(" ")}
      >
        <Icon
          className={`size-icon-sm shrink-0 ${CATEGORY_CLASSES[category].icon}`}
          strokeWidth={1.75}
          aria-label={CARD_NAMES[card.type]}
        />
        <span dir="auto" className="min-w-0 flex-1 truncate text-body text-primary">
          {text}
        </span>
        {severity ? <IssueMarker severity={severity} label={message ?? ""} /> : null}
      </div>
      {outputs.map((row) => (
        <Output key={row.port} row={row} category={category} />
      ))}
    </div>
  );
}

function Body({ node, summary, issues }: CanvasNodeData) {
  switch (node.type) {
    case "standard":
      return (
        <>
          {node.cards.map((card) => {
            const issue = issues?.cards.get(card.id);
            return (
              <CardRow
                key={card.id}
                card={card}
                summary={summary}
                severity={issue?.severity}
                message={issue?.message}
              />
            );
          })}
          {node.cards.length === 0 ? <p className="px-6 py-2 text-small text-tertiary">No cards yet</p> : null}
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

function CanvasNodeView({ data, selected }: NodeProps<CanvasRFNode>) {
  const { node, issues } = data;
  const compact = useStore((s) => s.transform[2] < COMPACT_BELOW);
  const Icon = NODE_ICONS[node.type];
  const category = NODE_CATEGORY[node.type];
  const classes = CATEGORY_CLASSES[category];
  const targetable = !NON_TARGETABLE_NODE_TYPES.includes(node.type);
  const outputs = nodeOutputRows(node);
  const cardCount = node.type === "standard" ? node.cards.length : 0;
  const nodeIssue = issues?.node;
  const hasBody =
    !compact && (node.type === "standard" || node.type === "autonomous" || (node.type === "note" && node.text));

  return (
    <article
      aria-label={`${node.name}, ${NODE_TYPE_LABELS[node.type].toLowerCase()}${node.type === "standard" ? `, ${cardCount} ${cardCount === 1 ? "card" : "cards"}` : ""}`}
      className={[
        "flex w-node flex-col overflow-visible rounded-lg border bg-surface shadow-node transition-colors",
        selected ? "border-accent outline-2 outline-accent outline-offset-1" : `${classes.border} hover:border-strong`,
        nodeIssue?.severity === "error" && !selected ? "border-error" : "",
      ].join(" ")}
    >
      <header className="relative flex items-center gap-4 px-5 py-5">
        {targetable ? (
          <Handle type="target" position={Position.Left} id="in" className={`wk-input ${classes.port}`} />
        ) : null}
        <IconTile category={category} icon={Icon} />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The name keeps its own direction but stays next to the icon in the left-to-right chrome. */}
          <span dir="auto" className="truncate text-left text-body font-semibold text-primary">
            {node.name}
          </span>
          <span className="truncate text-small text-secondary">{nodeSubtitle(node)}</span>
        </div>
        {nodeIssue ? <IssueMarker severity={nodeIssue.severity} label={nodeIssue.message} /> : null}
        {compact && node.type === "standard" ? (
          <span className="text-small text-secondary tabular-nums">{cardCount}</span>
        ) : null}
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
              <Body {...data} />
            </div>
          ) : null}
          {outputs.length > 0 ? (
            <div className={`flex flex-col py-2 ${hasBody ? "" : "border-t border-hairline"}`}>
              {outputs.map((row) => (
                <Output key={row.port} row={row} category={category} />
              ))}
            </div>
          ) : hasBody ? (
            <span className="h-4" />
          ) : null}
        </>
      )}
    </article>
  );
}

export const CanvasNode = memo(CanvasNodeView);
