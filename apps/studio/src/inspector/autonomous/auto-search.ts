import type { Node, Tool } from "@wakeel/contracts";

/**
 * The inspector's commands for searching before every reply (ADR-055, task 6.13). Each returns the
 * whole new node, so it goes through the canvas store like every other edit, and none leaves
 * `autoSearch` pointing at a tool the node no longer has (that would fail validation).
 */

type Auto = Extract<Node, { type: "autonomous" }>;

const knowledgeTools = (node: Auto) => node.tools.filter((t) => t.type === "kb_search");

function without(node: Auto): Auto {
  const { autoSearch: _off, ...rest } = node;
  return rest;
}

/** Adds a knowledge tool. The node's first one turns automatic search on (ADR-055: new nodes start on). */
export function withKnowledgeTool(node: Auto, tool: Tool): Auto {
  const first = knowledgeTools(node).length === 0 && node.autoSearch === undefined;
  return { ...node, tools: [...node.tools, tool], ...(first ? { autoSearch: { toolId: tool.id, rewrite: true } } : {}) };
}

/** Removes a tool; if automatic search used it, it moves to another knowledge tool or turns off. */
export function withoutTool(node: Auto, toolId: string): Auto {
  const next = { ...node, tools: node.tools.filter((t) => t.id !== toolId) };
  if (node.autoSearch?.toolId !== toolId) return next;
  const other = knowledgeTools(next)[0];
  return other ? { ...next, autoSearch: { ...node.autoSearch, toolId: other.id } } : without(next);
}

export function setAutoSearch(node: Auto, on: boolean): Auto {
  if (!on) return without(node);
  const first = knowledgeTools(node)[0];
  return first ? { ...node, autoSearch: node.autoSearch ?? { toolId: first.id, rewrite: true } } : node;
}

export function setAutoSearchTool(node: Auto, toolId: string): Auto {
  if (!node.autoSearch || !knowledgeTools(node).some((t) => t.id === toolId)) return node;
  return { ...node, autoSearch: { ...node.autoSearch, toolId } };
}

export function setAutoSearchRewrite(node: Auto, rewrite: boolean): Auto {
  return node.autoSearch ? { ...node, autoSearch: { ...node.autoSearch, rewrite } } : node;
}
