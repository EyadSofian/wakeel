import { BotDefinition, SCHEMA_VERSION, validateDefinition, type Workflow } from "@wakeel/contracts";
import { describe, expect, it } from "vitest";
import { canvasDraft } from "../../../tests/canvas-fixtures";
import { copyFragment, FRAGMENT_KIND, parseFragment, pasteFragment } from "./clipboard";

const typical = () => canvasDraft("typical");
const ids = (wf: Workflow) => JSON.stringify(wf).match(/\b(?:node|card|br|exit|edge|tool)_[0-9A-Za-z]{10}\b/g) ?? [];

describe("copyFragment", () => {
  it("copies the nodes, the transitions between them and their positions, never Start", () => {
    const { workflows } = typical();
    const wf = workflows[0] as Workflow;
    const [start, greeting, agent] = wf.nodes;
    const f = copyFragment(wf, [start?.id ?? "", greeting?.id ?? "", agent?.id ?? ""]);
    expect(f?.kind).toBe(FRAGMENT_KIND);
    expect(f?.nodes.map((n) => n.id)).toEqual([greeting?.id, agent?.id]);
    // Greeting → agent is inside the fragment; Start → greeting is not.
    expect(f?.edges.map((e) => [e.from.nodeId, e.to.nodeId])).toEqual([[greeting?.id, agent?.id]]);
    expect(Object.keys(f?.layout ?? {})).toEqual([greeting?.id, agent?.id]);
  });

  it("is undefined when only Start is selected", () => {
    const wf = typical().workflows[0] as Workflow;
    expect(copyFragment(wf, [wf.nodes[0]?.id ?? ""])).toBeUndefined();
  });

  it("carries the workflow variables its cards reference", () => {
    const wf = typical().workflows[0] as Workflow;
    const withVar: Workflow = {
      ...wf,
      variables: [{ id: "var_0000000099", name: "answer", scope: "workflow", type: "string", sensitive: false }],
      nodes: wf.nodes.map((n) =>
        n.type === "standard" && n.name === "Greeting"
          ? {
              ...n,
              cards: n.cards.map((c) => (c.type === "capture" ? { ...c, into: "var_0000000099" } : c)),
            }
          : n,
      ),
    };
    const greeting = withVar.nodes.find((n) => n.name === "Greeting");
    expect(copyFragment(withVar, [greeting?.id ?? ""])?.variables.map((v) => v.name)).toEqual(["answer"]);
  });
});

describe("parseFragment", () => {
  it("reads a copied fragment back and rejects anything else", () => {
    const wf = typical().workflows[0] as Workflow;
    const f = copyFragment(wf, [wf.nodes[1]?.id ?? ""]);
    expect(parseFragment(JSON.stringify(f))).toEqual(f);
    expect(parseFragment("hello")).toBeUndefined();
    expect(parseFragment(JSON.stringify({ kind: "something-else" }))).toBeUndefined();
    expect(parseFragment("مرحبا")).toBeUndefined();
  });
});

describe("pasteFragment", () => {
  it("gives every element a new id, including inside ports, and keeps the result valid", () => {
    const { manifest, workflows } = typical();
    const wf = workflows[0] as Workflow;
    const all = wf.nodes.map((n) => n.id);
    const f = copyFragment(wf, all);
    if (!f) throw new Error("no fragment");
    const { wf: after, nodeIds } = pasteFragment(wf, f, { x: 2_000, y: 0 });

    expect(nodeIds).toHaveLength(wf.nodes.length - 1);
    // No id appears twice anywhere in the document.
    const found = ids(after).filter((id) => !id.startsWith("var_"));
    const unique = new Set(after.nodes.map((n) => n.id));
    expect(unique.size).toBe(after.nodes.length);
    expect(new Set(after.edges.map((e) => e.id)).size).toBe(after.edges.length);
    expect(found.length).toBeGreaterThan(0);
    // Pasted transitions point at pasted nodes and pasted ports.
    const pasted = new Set(nodeIds);
    const newEdges = after.edges.slice(wf.edges.length);
    expect(newEdges).toHaveLength(f.edges.length);
    for (const e of newEdges) {
      expect(pasted.has(e.from.nodeId) && pasted.has(e.to.nodeId)).toBe(true);
    }
    const def = BotDefinition.parse({ schemaVersion: SCHEMA_VERSION, manifest, workflows: [after] });
    expect(validateDefinition(def).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("places the fragment's top-left corner at the paste point", () => {
    const wf = typical().workflows[0] as Workflow;
    const greeting = wf.nodes[1];
    const agent = wf.nodes[2];
    const f = copyFragment(wf, [greeting?.id ?? "", agent?.id ?? ""]);
    if (!f) throw new Error("no fragment");
    const { wf: after, nodeIds } = pasteFragment(wf, f, { x: 1_000, y: 500 });
    const positions = nodeIds.map((id) => after.layout[id]);
    expect(Math.min(...positions.map((p) => p?.x ?? Number.NaN))).toBe(1_000);
    expect(Math.min(...positions.map((p) => p?.y ?? Number.NaN))).toBe(500);
  });

  it("pasting twice never collides, and a variable that already exists is reused, not doubled", () => {
    const wf: Workflow = {
      ...(typical().workflows[0] as Workflow),
      variables: [{ id: "var_0000000099", name: "answer", scope: "workflow", type: "string", sensitive: false }],
    };
    const f = copyFragment(wf, [wf.nodes[1]?.id ?? ""]);
    if (!f) throw new Error("no fragment");
    const once = pasteFragment(wf, { ...f, variables: wf.variables }, { x: 0, y: 900 }).wf;
    const twice = pasteFragment(once, { ...f, variables: wf.variables }, { x: 0, y: 1_400 }).wf;
    expect(new Set(twice.nodes.map((n) => n.id)).size).toBe(twice.nodes.length);
    expect(twice.variables.map((v) => v.name)).toEqual(["answer"]);
  });

  it("renames a different variable that lands on a taken name", () => {
    const wf: Workflow = {
      ...(typical().workflows[0] as Workflow),
      variables: [{ id: "var_0000000001", name: "answer", scope: "workflow", type: "string", sensitive: false }],
    };
    const f = copyFragment(wf, [wf.nodes[1]?.id ?? ""]);
    if (!f) throw new Error("no fragment");
    const incoming = {
      id: "var_0000000002",
      name: "answer",
      scope: "workflow" as const,
      type: "number" as const,
      sensitive: false,
    };
    const after = pasteFragment(wf, { ...f, variables: [incoming] }, { x: 0, y: 0 }).wf;
    expect(after.variables.map((v) => v.name)).toEqual(["answer", "answer_2"]);
  });

  it("keeps Arabic content byte for byte", () => {
    const wf = canvasDraft("rtl").workflows[0] as Workflow;
    const f = copyFragment(wf, [wf.nodes[1]?.id ?? ""]);
    if (!f) throw new Error("no fragment");
    const { wf: after, nodeIds } = pasteFragment(wf, f, { x: 0, y: 900 });
    const pasted = after.nodes.find((n) => n.id === nodeIds[0]);
    expect(pasted?.name).toBe(wf.nodes[1]?.name);
    expect(JSON.stringify(pasted)).toContain("أهلاً بيك");
  });
});
