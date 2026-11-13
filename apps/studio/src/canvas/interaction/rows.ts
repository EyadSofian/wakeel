import type { Node } from "@wakeel/contracts";
import { cardOutputRows, nodeOutputRows } from "../view/summaries";

/**
 * The rows the keyboard cursor moves over inside a node (`Enter` on a node, §5.1): each card, then
 * that card's outputs, then the node's own outputs. The same order the node draws them in.
 */
export type Row = { kind: "card"; cardId: string } | { kind: "output"; port: string; label: string };

export function nodeRows(node: Node): Row[] {
  const rows: Row[] = [];
  if (node.type === "standard") {
    for (const card of node.cards) {
      rows.push({ kind: "card", cardId: card.id });
      for (const o of cardOutputRows(card)) rows.push({ kind: "output", port: o.port, label: o.label });
    }
  }
  for (const o of nodeOutputRows(node)) rows.push({ kind: "output", port: o.port, label: o.label });
  return rows;
}
