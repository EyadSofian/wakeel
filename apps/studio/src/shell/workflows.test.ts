import { type Node, newElementId, seedSubWorkflow, validateDefinition, type Workflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { createMenuCard, createNode } from "../canvas/store/factories";
import { seededDraft } from "../canvas/store/fixtures.test-utils";
import { callSites, copyName, deleteBlocker, duplicateBlocker, duplicateWorkflow } from "./workflows";

/** A sub-workflow with a card that stores into one of its variables, and a branch with its own ports. */
function richSub(): Workflow {
  const sub = seedSubWorkflow("طلبات الاسترجاع");
  const standard = createNode("standard", "Ask") as Extract<Node, { type: "standard" }>;
  const ask = createMenuCard("capture", sub, []);
  if (!("card" in ask) || !ask.variable) throw new Error("capture card");
  standard.cards = [ask.card];
  const entry = sub.nodes[0] as Node;
  sub.nodes = [...sub.nodes, standard];
  sub.variables = [ask.variable];
  sub.edges = [
    ...sub.edges,
    { id: newElementId("edge"), from: { nodeId: standard.id, port: "next" }, to: { nodeId: entry.id } },
  ];
  sub.layout = { ...sub.layout, [standard.id]: { x: 360, y: 200 } };
  return sub;
}

describe("duplicateWorkflow", () => {
  test("every element id is new, references follow, and the bot stays valid", () => {
    const { manifest, main } = seededDraft();
    const source = richSub();
    const created = seedSubWorkflow("ignored");
    const copy = duplicateWorkflow(source, { id: created.id, name: "طلبات الاسترجاع copy" });

    expect(copy.id).toBe(created.id);
    expect(copy.name).toBe("طلبات الاسترجاع copy");
    expect(copy.nodes.map((n) => n.name)).toEqual(source.nodes.map((n) => n.name));
    const before = JSON.stringify(source);
    for (const n of copy.nodes) expect(before).not.toContain(n.id);
    for (const e of copy.edges) expect(before).not.toContain(e.id);
    expect(before).not.toContain(copy.variables[0]?.id ?? "missing");
    // The Ask card still stores into the copy's own variable, and layout keys moved with the nodes.
    expect(JSON.stringify(copy.nodes)).toContain(copy.variables[0]?.id ?? "missing");
    expect(Object.keys(copy.layout).sort()).toEqual(copy.nodes.map((n) => n.id).sort());

    const issues = validateDefinition({ schemaVersion: 1, manifest, workflows: [main, source, copy] });
    expect(issues.filter((i) => i.code === "duplicate_id")).toEqual([]);
  });
});

describe("copyName", () => {
  test("adds copy, then a number, within 80 characters", () => {
    expect(copyName("Refunds", [])).toBe("Refunds copy");
    expect(copyName("Refunds", ["Refunds copy", "Refunds copy 2"])).toBe("Refunds copy 3");
    expect(copyName("x".repeat(80), []).length).toBeLessThanOrEqual(80);
  });
});

describe("callSites", () => {
  test("lists run workflow cards and workflow tools, worded for the delete warning", () => {
    const { manifest, main } = seededDraft();
    const sub = richSub();
    const caller = createNode("standard", "Lookup") as Extract<Node, { type: "standard" }>;
    const call = createMenuCard("call_workflow", main, [main, sub]);
    if (!("card" in call)) throw new Error("call card");
    caller.cards = [call.card];
    const agent = main.nodes.find((n) => n.type === "autonomous");
    if (agent?.type !== "autonomous") throw new Error("agent");
    agent.tools = [
      { id: newElementId("tool"), type: "workflow", name: "refund", description: "Refunds.", workflowId: sub.id },
    ];
    main.nodes = [...main.nodes, caller];
    const sites = callSites({ manifest, workflows: [main, sub] }, sub.id);
    expect(sites.map((s) => [s.workflow, s.node, s.what])).toEqual([
      ["Main", "Assistant", "Workflow tool refund"],
      ["Main", "Lookup", "Run workflow card"],
    ]);
    expect(callSites({ manifest, workflows: [main, sub] }, main.id)).toEqual([]);
  });
});

describe("blockers", () => {
  test("main cannot be deleted or duplicated; error cannot be duplicated; sub can be both", () => {
    const { main } = seededDraft();
    expect(deleteBlocker(main)).toMatch(/cannot be deleted/);
    expect(duplicateBlocker(main)).toMatch(/one main workflow/);
    expect(duplicateBlocker({ ...main, kind: "error" })).toMatch(/one error workflow/);
    const sub = seedSubWorkflow("Refunds");
    expect(deleteBlocker(sub)).toBeUndefined();
    expect(duplicateBlocker(sub)).toBeUndefined();
  });
});
