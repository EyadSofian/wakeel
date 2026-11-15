import type { Workflow } from "@wakeel/contracts";
import { describe, expect, it } from "vitest";
import { canvasDraft } from "../../../tests/canvas-fixtures";
import { type Direction, fitViewport, nearestInDirection, type Rect, tidyLayout } from "./layout";

const wf = () => canvasDraft("typical").workflows[0] as Workflow;

describe("tidyLayout", () => {
  it("puts nodes in columns by distance from Start, branches top-down in output order", () => {
    const w = wf();
    const [start, greeting, agent, faq, human, done] = w.nodes.map((n) => n.id);
    const p = tidyLayout(w);
    expect(p[start ?? ""]?.x).toBe(0);
    expect(p[greeting ?? ""]?.x).toBeGreaterThan(p[start ?? ""]?.x ?? 0);
    // The agent and the FAQ are both one step after Greeting: same column, Order branch first.
    expect(p[agent ?? ""]?.x).toBe(p[faq ?? ""]?.x);
    expect(p[agent ?? ""]?.y).toBeLessThan(p[faq ?? ""]?.y ?? 0);
    // Done and the handoff follow the agent.
    expect(p[done ?? ""]?.x).toBe(p[human ?? ""]?.x);
    expect(p[done ?? ""]?.x).toBeGreaterThan(p[agent ?? ""]?.x ?? 0);
  });

  it("places every node, snaps to the 8 px grid, and never overlaps nodes in a column", () => {
    const w = wf();
    const sizes = new Map(w.nodes.map((n, i) => [n.id, { width: 288, height: 100 + i * 37 }]));
    const p = tidyLayout(w, sizes);
    expect(Object.keys(p).sort()).toEqual(w.nodes.map((n) => n.id).sort());
    for (const pos of Object.values(p)) {
      expect(pos.x % 8).toBe(0);
      expect(pos.y % 8).toBe(0);
    }
    const byColumn = new Map<number, string[]>();
    for (const [id, pos] of Object.entries(p)) byColumn.set(pos.x, [...(byColumn.get(pos.x) ?? []), id]);
    for (const ids of byColumn.values()) {
      const sorted = ids.sort((a, b) => (p[a]?.y ?? 0) - (p[b]?.y ?? 0));
      for (let i = 1; i < sorted.length; i++) {
        const above = sorted[i - 1] ?? "";
        expect(p[sorted[i] ?? ""]?.y ?? 0).toBeGreaterThanOrEqual((p[above]?.y ?? 0) + (sizes.get(above)?.height ?? 0));
      }
    }
  });

  it("survives loops and puts unreachable nodes in a last column", () => {
    const w = wf();
    const loop = {
      ...w,
      edges: [
        ...w.edges,
        {
          id: "edge_0000000099",
          from: { nodeId: w.nodes[3]?.id ?? "", port: "next" },
          to: { nodeId: w.nodes[1]?.id ?? "" },
        },
      ],
    };
    const orphan = { id: "node_0000000099", name: "Note", type: "note" as const, text: "" };
    const p = tidyLayout({ ...loop, nodes: [...loop.nodes, orphan] });
    const maxX = Math.max(...Object.values(p).map((q) => q.x));
    expect(p[orphan.id]?.x).toBe(maxX);
  });
});

describe("nearestInDirection", () => {
  const box = (x: number, y: number): Rect => ({ x, y, width: 100, height: 60 });
  const from = box(0, 0);
  const candidates = [
    { id: "right-near-off-axis", rect: box(150, 200) },
    { id: "right-far-straight", rect: box(300, 0) },
    { id: "left", rect: box(-300, 10) },
    { id: "down", rect: box(0, 300) },
    { id: "up", rect: box(20, -300) },
  ];
  it.each([
    ["right", "right-far-straight"],
    ["left", "left"],
    ["down", "down"],
    ["up", "up"],
  ] as [Direction, string][])("%s → %s", (dir, id) => {
    expect(nearestInDirection(from, candidates, dir)).toBe(id);
  });

  it("is undefined when nothing lies that way", () => {
    expect(nearestInDirection(from, [{ id: "a", rect: box(300, 0) }], "left")).toBeUndefined();
  });
});

describe("fitViewport", () => {
  const sizes = new Map<string, { width: number; height: number }>();
  it("centres the workflow and never zooms past 100%", () => {
    const w = wf();
    const v = fitViewport(w, sizes, { width: 4_000, height: 3_000 });
    expect(v.zoom).toBe(1);
  });

  it("shrinks a large workflow so all of it fits, with the padding", () => {
    const w = canvasDraft("dense-300").workflows[0] as Workflow;
    const pane = { width: 1_000, height: 700 };
    const v = fitViewport(w, sizes, pane);
    expect(v.zoom).toBeLessThan(0.5);
    // Every node's top-left lands inside the pane.
    for (const n of w.nodes) {
      const p = w.layout[n.id] ?? { x: 0, y: 0 };
      expect(p.x * v.zoom + v.x).toBeGreaterThanOrEqual(0);
      expect(p.y * v.zoom + v.y).toBeGreaterThanOrEqual(0);
      expect(p.x * v.zoom + v.x).toBeLessThanOrEqual(pane.width);
      expect(p.y * v.zoom + v.y).toBeLessThanOrEqual(pane.height);
    }
  });

  it("is the identity for an empty pane", () => {
    expect(fitViewport(wf(), sizes, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
