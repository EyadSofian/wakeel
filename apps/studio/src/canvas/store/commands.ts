import {
  type Card,
  cardPortKeys,
  type Edge,
  NON_TARGETABLE_NODE_TYPES,
  type Node,
  newElementId,
  nodePorts,
  type Workflow,
} from "@wakeel/contracts";

/**
 * The only way the canvas changes a workflow document (CLAUDE.md §6: "The canvas document changes
 * only through store commands"). A command is a pure function from one workflow to the next; the
 * store keeps the previous document for undo, so commands need no inverse of their own.
 *
 * Every command keeps the document schema-valid and keeps transitions pointing at nodes and outputs
 * that exist: deleting a node or card removes its transitions with it.
 */
export interface Command {
  /** Shown in the undo menu and the command palette: "Add card", "Delete 3 nodes". */
  label: string;
  /** True when only positions change, so the change never reaches a logic diff (ADR-006). */
  layoutOnly?: boolean;
  apply(wf: Workflow): Workflow;
}

/** A command that cannot apply to this document, with the reason shown to the builder. */
export class CommandRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRejected";
  }
}

const findNode = (wf: Workflow, nodeId: string): Node => {
  const node = wf.nodes.find((n) => n.id === nodeId);
  if (!node) throw new CommandRejected("That node no longer exists.");
  return node;
};

const replaceNode = (wf: Workflow, node: Node): Workflow => ({
  ...wf,
  nodes: wf.nodes.map((n) => (n.id === node.id ? node : n)),
});

/** Drops transitions whose source output or target node no longer exists. */
const pruneEdges = (wf: Workflow): Workflow => {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const edges = wf.edges.filter((e) => {
    const from = byId.get(e.from.nodeId);
    return from !== undefined && byId.has(e.to.nodeId) && nodePorts(from).includes(e.from.port);
  });
  return edges.length === wf.edges.length ? wf : { ...wf, edges };
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

export const commands = {
  addNode(node: Node, position: { x: number; y: number }): Command {
    return {
      label: "Add node",
      apply: (wf) => {
        if (wf.nodes.some((n) => n.id === node.id)) throw new CommandRejected("That node is already on the canvas.");
        return { ...wf, nodes: [...wf.nodes, node], layout: { ...wf.layout, [node.id]: { ...position } } };
      },
    };
  },

  deleteNodes(nodeIds: readonly string[]): Command {
    const ids = new Set(nodeIds);
    return {
      label: `Delete ${plural(ids.size, "node", "nodes")}`,
      apply: (wf) => {
        const layout = { ...wf.layout };
        for (const id of ids) delete layout[id];
        return pruneEdges({
          ...wf,
          nodes: wf.nodes.filter((n) => !ids.has(n.id)),
          edges: wf.edges.filter((e) => !ids.has(e.from.nodeId) && !ids.has(e.to.nodeId)),
          layout,
        });
      },
    };
  },

  moveNodes(positions: Readonly<Record<string, { x: number; y: number }>>): Command {
    return {
      label: "Move",
      layoutOnly: true,
      apply: (wf) => {
        const layout = { ...wf.layout };
        for (const [id, p] of Object.entries(positions)) {
          if (!wf.nodes.some((n) => n.id === id)) continue;
          layout[id] = { ...layout[id], x: p.x, y: p.y };
        }
        return { ...wf, layout };
      },
    };
  },

  renameNode(nodeId: string, name: string): Command {
    return {
      label: "Rename node",
      apply: (wf) => {
        const trimmed = name.trim();
        if (trimmed === "") throw new CommandRejected("A node needs a name.");
        return replaceNode(wf, { ...findNode(wf, nodeId), name: trimmed.slice(0, 80) });
      },
    };
  },

  /** Replaces a node's settings (inspector forms). The node keeps its id and type. */
  updateNode(nodeId: string, update: (node: Node) => Node): Command {
    return {
      label: "Edit node",
      apply: (wf) => {
        const before = findNode(wf, nodeId);
        const after = update(before);
        if (after.id !== before.id || after.type !== before.type)
          throw new CommandRejected("A node keeps its id and type.");
        return pruneEdges(replaceNode(wf, after));
      },
    };
  },

  /**
   * Connects an output to a node. One transition per output: connecting an output that already
   * has one moves it (architecture §2.3 edges).
   */
  connect(from: { nodeId: string; port: string }, toNodeId: string): Command {
    return {
      label: "Connect",
      apply: (wf) => {
        const source = findNode(wf, from.nodeId);
        const target = findNode(wf, toNodeId);
        if (!nodePorts(source).includes(from.port)) throw new CommandRejected(`"${source.name}" has no such output.`);
        if (NON_TARGETABLE_NODE_TYPES.includes(target.type)) {
          throw new CommandRejected(`"${target.name}" cannot be the target of a transition.`);
        }
        const existing = wf.edges.find((e) => e.from.nodeId === from.nodeId && e.from.port === from.port);
        const edge: Edge = { id: existing?.id ?? newElementId("edge"), from: { ...from }, to: { nodeId: toNodeId } };
        return { ...wf, edges: [...wf.edges.filter((e) => e !== existing), edge] };
      },
    };
  },

  deleteEdges(edgeIds: readonly string[]): Command {
    const ids = new Set(edgeIds);
    return {
      label: `Delete ${plural(ids.size, "transition", "transitions")}`,
      apply: (wf) => ({ ...wf, edges: wf.edges.filter((e) => !ids.has(e.id)) }),
    };
  },

  /** Points an existing transition at another node (drag the arrowhead). */
  reconnect(edgeId: string, toNodeId: string): Command {
    return {
      label: "Reconnect",
      apply: (wf) => {
        const edge = wf.edges.find((e) => e.id === edgeId);
        if (!edge) throw new CommandRejected("That transition no longer exists.");
        return commands.connect(edge.from, toNodeId).apply(wf);
      },
    };
  },

  addCard(nodeId: string, card: Card, index?: number): Command {
    return {
      label: "Add card",
      apply: (wf) => {
        const node = findNode(wf, nodeId);
        if (node.type !== "standard") throw new CommandRejected("Cards go in standard nodes.");
        if (node.cards.length >= 50) throw new CommandRejected("A node holds at most 50 cards.");
        const cards = [...node.cards];
        cards.splice(index ?? cards.length, 0, card);
        return pruneEdges(replaceNode(wf, { ...node, cards }));
      },
    };
  },

  updateCard(nodeId: string, card: Card): Command {
    return {
      label: "Edit card",
      apply: (wf) => {
        const node = findNode(wf, nodeId);
        if (node.type !== "standard" || !node.cards.some((c) => c.id === card.id)) {
          throw new CommandRejected("That card no longer exists.");
        }
        // Outputs the card no longer has (a removed branch or option) lose their transitions.
        return pruneEdges(replaceNode(wf, { ...node, cards: node.cards.map((c) => (c.id === card.id ? card : c)) }));
      },
    };
  },

  moveCard(nodeId: string, cardId: string, toIndex: number): Command {
    return {
      label: "Move card",
      apply: (wf) => {
        const node = findNode(wf, nodeId);
        if (node.type !== "standard") throw new CommandRejected("Cards go in standard nodes.");
        const from = node.cards.findIndex((c) => c.id === cardId);
        if (from === -1) throw new CommandRejected("That card no longer exists.");
        const cards = [...node.cards];
        const [card] = cards.splice(from, 1);
        if (!card) return wf;
        cards.splice(Math.max(0, Math.min(toIndex, cards.length)), 0, card);
        // Moving a card that ends the node changes whether the node has a `next` output.
        return pruneEdges(replaceNode(wf, { ...node, cards }));
      },
    };
  },

  deleteCard(nodeId: string, cardId: string): Command {
    return {
      label: "Delete card",
      apply: (wf) => {
        const node = findNode(wf, nodeId);
        if (node.type !== "standard") throw new CommandRejected("Cards go in standard nodes.");
        const card = node.cards.find((c) => c.id === cardId);
        if (!card) throw new CommandRejected("That card no longer exists.");
        const ports = new Set(cardPortKeys(card).map((k) => `card:${card.id}:${k}`));
        const pruned = replaceNode(wf, { ...node, cards: node.cards.filter((c) => c.id !== cardId) });
        return pruneEdges({
          ...pruned,
          edges: pruned.edges.filter((e) => !(e.from.nodeId === nodeId && ports.has(e.from.port))),
        });
      },
    };
  },
};
