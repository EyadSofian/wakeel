import { type Node as DefNode, NON_TARGETABLE_NODE_TYPES } from "@wakeel/contracts";
import { Handle, type NodeProps, Position, type Node as RFNode, useStore } from "@xyflow/react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { memo, type ReactNode } from "react";
import type { NodeIssues } from "../issues";
import {
  CARD_ICONS,
  CARD_NAMES,
  cardOutputRows,
  NODE_ICONS,
  NODE_TYPE_LABELS,
  nodeOutputRows,
  type OutputRow,
  type SummaryContext,
  summarizeCard,
} from "./summaries";

/**
 * A node on the canvas (design system §4 Canvas, §5.1): header with icon and name, then one row
 * per card (standard) or the instructions, tools and exits (autonomous). Outputs are dots on the
 * right edge aligned with their row; transitions enter on the left edge. Below 50% zoom the node
 * shows only its header and a card count.
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
function Output({ row, children }: { row: OutputRow; children?: ReactNode }) {
  return (
    <div className="relative flex h-row-card items-center gap-3 border-t border-hairline px-5">
      {children ?? <span className="ms-auto truncate text-small text-secondary">{row.label}</span>}
      <Handle
        type="source"
        position={Position.Right}
        id={row.port}
        aria-label={`Output ${row.label}`}
        className="wk-output"
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
  const outputs = cardOutputRows(card);
  const text = summarizeCard(card, summary);
  return (
    <div data-card={card.id} className={card.disabled ? "opacity-50" : ""}>
      <div className="flex h-row-card items-center gap-3 border-t border-hairline px-5">
        <Icon className="size-icon-sm shrink-0 text-secondary" strokeWidth={1.5} aria-label={CARD_NAMES[card.type]} />
        <span dir="auto" className="min-w-0 flex-1 truncate text-body text-primary">
          {text}
        </span>
        {severity ? <IssueMarker severity={severity} label={message ?? ""} /> : null}
      </div>
      {outputs.map((row) => (
        <Output key={row.port} row={row} />
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
          {node.cards.length === 0 ? (
            <p className="border-t border-hairline px-5 py-4 text-small text-tertiary">No cards yet</p>
          ) : null}
        </>
      );
    case "autonomous": {
      const firstLine = node.instructions
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.trim();
      return (
        <div className="flex flex-col gap-2 border-t border-hairline px-5 py-4">
          <p dir="auto" className={`truncate text-body ${firstLine ? "text-primary" : "text-tertiary"}`}>
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
        <p dir="auto" className="whitespace-pre-wrap border-t border-hairline px-5 py-4 text-body text-secondary">
          {node.text}
        </p>
      ) : null;
    case "trigger":
      return (
        <p className="truncate border-t border-hairline px-5 py-3 text-small text-secondary">
          {node.on.kind === "event" ? (
            <span className="font-mono">{node.on.name}</span>
          ) : (
            node.on.kind.replaceAll("_", " ")
          )}
        </p>
      );
    default:
      return null;
  }
}

function CanvasNodeView({ data, selected }: NodeProps<CanvasRFNode>) {
  const { node, issues } = data;
  const compact = useStore((s) => s.transform[2] < COMPACT_BELOW);
  const Icon = NODE_ICONS[node.type];
  const targetable = !NON_TARGETABLE_NODE_TYPES.includes(node.type);
  const outputs = nodeOutputRows(node);
  const cardCount = node.type === "standard" ? node.cards.length : 0;
  const nodeIssue = issues?.node;

  return (
    <article
      aria-label={`${node.name}, ${NODE_TYPE_LABELS[node.type].toLowerCase()}${node.type === "standard" ? `, ${cardCount} ${cardCount === 1 ? "card" : "cards"}` : ""}`}
      className={[
        "w-node overflow-visible rounded-md border bg-surface transition-colors",
        selected ? "border-accent-border" : "border-hairline hover:border-strong",
        node.type === "note" ? "bg-subtle" : "",
      ].join(" ")}
    >
      {targetable ? <Handle type="target" position={Position.Left} id="in" className="wk-input" /> : null}
      <header
        className={[
          "flex h-row-card items-center gap-3 rounded-t-md px-5 transition-colors",
          selected ? "bg-accent-subtle" : "",
        ].join(" ")}
      >
        <Icon className="size-icon shrink-0 text-secondary" strokeWidth={1.5} aria-hidden="true" />
        <span dir="auto" className="min-w-0 flex-1 truncate text-body font-medium text-primary">
          {node.name}
        </span>
        {nodeIssue ? <IssueMarker severity={nodeIssue.severity} label={nodeIssue.message} /> : null}
        {compact && node.type === "standard" ? (
          <span className="text-small text-secondary tabular-nums">{cardCount}</span>
        ) : null}
      </header>
      {compact ? (
        // Compact form keeps every output so transitions still have somewhere to attach.
        <div className="relative">
          {[...(node.type === "standard" ? node.cards.flatMap(cardOutputRows) : []), ...outputs].map((row) => (
            <Handle key={row.port} type="source" position={Position.Right} id={row.port} className="wk-output" />
          ))}
        </div>
      ) : (
        <>
          <Body {...data} />
          {outputs.map((row) => (
            <Output key={row.port} row={row} />
          ))}
        </>
      )}
    </article>
  );
}

export const CanvasNode = memo(CanvasNodeView);
