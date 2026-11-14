import { type Node, seedSubWorkflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { createMenuCard, createNode } from "../canvas/store/factories";
import { seededDraft } from "../canvas/store/fixtures.test-utils";
import { fuzzyFilter } from "./fuzzy";
import { goToItems } from "./palette-items";

/** Main from the seed plus an Arabic sub-workflow with a standard node that asks a question. */
function bot() {
  const { manifest, main } = seededDraft();
  const sub = seedSubWorkflow("طلبات الاسترجاع");
  const standard = createNode("standard", "اسأل عن الطلب") as Extract<Node, { type: "standard" }>;
  const ask = createMenuCard("capture", sub, []);
  if (!("card" in ask) || !ask.variable) throw new Error("capture card");
  standard.cards = [ask.card];
  sub.nodes = [...sub.nodes, standard];
  sub.variables = [ask.variable];
  return { manifest, main, sub, standard, card: ask.card, variable: ask.variable };
}

describe("goToItems (design system §5.15 Go to)", () => {
  test("every workflow, node, card and variable, and the pages around the bot", () => {
    const { manifest, main, sub, standard, card, variable } = bot();
    const items = goToItems(manifest, [sub, main]);
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds).toEqual(new Set(["Workflow", "Page", "Settings", "Node", "Card", "Variable"]));

    // Main comes first whatever order the documents arrive in.
    expect(items.filter((i) => i.kind === "Workflow").map((i) => i.label)).toEqual([main.name, sub.name]);
    for (const n of [...main.nodes, ...sub.nodes]) {
      expect(items.find((i) => i.id === `node:${n.id}`)?.target).toEqual({
        type: "node",
        workflowId: main.nodes.includes(n) ? main.id : sub.id,
        nodeId: n.id,
      });
    }
    const cardItem = items.find((i) => i.id === `card:${card.id}`);
    expect(cardItem?.label.startsWith(`${standard.name} › `)).toBe(true);
    expect(cardItem?.context).toBe(sub.name);
    expect(cardItem?.target).toEqual({ type: "node", workflowId: sub.id, nodeId: standard.id, cardId: card.id });
    expect(items.find((i) => i.id === `var:${variable.id}`)?.label).toBe(`workflow.${variable.name}`);
    expect(items.filter((i) => i.target.type === "page").map((i) => i.label)).toEqual(
      expect.arrayContaining(["Workflows", "Variables", "Home", "General", "Members", "API keys"]),
    );
  });

  test("ids are unique, so the palette can key its rows by them", () => {
    const { manifest, main, sub } = bot();
    const ids = goToItems(manifest, [main, sub]).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("Arabic queries find Arabic places with or without hamza and diacritics", () => {
    const { manifest, main, sub, standard } = bot();
    const items = goToItems(manifest, [main, sub]);
    const found = (q: string) => fuzzyFilter(items, q, (i) => i.search).map((i) => i.id);
    expect(found("اسال")[0]).toBe(`node:${standard.id}`);
    expect(found("طلبات الاسترجاع")).toContain(`wf:${sub.id}`);
    expect(found("طَلَبَات الإسترجاع")).toContain(`wf:${sub.id}`);
  });
});
