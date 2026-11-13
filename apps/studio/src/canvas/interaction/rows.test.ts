import type { Workflow } from "@wakeel/contracts";
import { describe, expect, it } from "vitest";
import { canvasDraft } from "../../../tests/canvas-fixtures";
import { nodeRows } from "./rows";

describe("nodeRows", () => {
  const wf = canvasDraft("typical").workflows[0] as Workflow;
  it("lists cards, each followed by its outputs, then the node's outputs", () => {
    const greeting = wf.nodes[1];
    if (!greeting) throw new Error("fixture");
    const rows = nodeRows(greeting).map((r) => (r.kind === "card" ? "card" : r.label));
    // Say, Ask (+ failed), Condition (+ Order, Shipping), then next.
    expect(rows).toEqual(["card", "card", "failed", "card", "Order", "Shipping", "next"]);
  });

  it("an Autonomous node has its exits and error; Start has next", () => {
    const [start, , agent] = wf.nodes;
    if (!start || !agent) throw new Error("fixture");
    expect(nodeRows(agent).map((r) => (r.kind === "output" ? r.label : "card"))).toEqual([
      "resolved",
      "needs_person",
      "error",
    ]);
    expect(nodeRows(start).map((r) => (r.kind === "output" ? r.port : "card"))).toEqual(["next"]);
  });
});
