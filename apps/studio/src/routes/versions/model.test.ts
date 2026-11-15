import { BotDefinition, diffDefinitions, SCHEMA_VERSION, seedBot } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { changeLines, diffRows, formatDiffPath, formatValue } from "./model";

/** Task 7.5: the publish summary and the Compare rows, from the 7.4 diff. */
const seeded = seedBot({ name: "متجر النور" });
const def = (patch: (d: BotDefinition) => BotDefinition = (d) => d) =>
  BotDefinition.parse(
    patch(BotDefinition.parse({ schemaVersion: SCHEMA_VERSION, manifest: seeded.manifest, workflows: [seeded.main] })),
  );

describe("changeLines", () => {
  test("one line per kind that changed, in a fixed order", () => {
    expect(
      changeLines({
        workflows: { added: 0, removed: 0, changed: 1 },
        nodes: { added: 2, removed: 1, changed: 0 },
        cards: { added: 0, removed: 0, changed: 0 },
        edges: { added: 1, removed: 0, changed: 0 },
        manifestFields: 1,
      }),
    ).toEqual([
      { label: "Workflows", detail: "1 changed" },
      { label: "Nodes", detail: "2 added · 1 removed" },
      { label: "Transitions", detail: "1 added" },
      { label: "Bot settings", detail: "1 field changed" },
    ]);
  });

  test("nothing changed is no lines", () => {
    const d = def();
    expect(changeLines(diffDefinitions(d, d).summary)).toEqual([]);
  });
});

describe("diffRows", () => {
  test("a renamed node and changed instructions: workflow, node, then its fields, names in Arabic, fields in the diff's order", () => {
    const before = def();
    const after = def((d) => ({
      ...d,
      workflows: d.workflows.map((w) => ({
        ...w,
        nodes: w.nodes.map((n) =>
          n.type === "autonomous" ? { ...n, name: "مساعد الطلبات", instructions: "ساعد العميل." } : n,
        ),
      })),
    }));
    const rows = diffRows(diffDefinitions(before, after), before, after);
    expect(rows.map((r) => [r.depth, r.kind, r.change, r.title])).toEqual([
      [0, "workflow", "changed", "Main"],
      [1, "node", "changed", "مساعد الطلبات"],
      [2, "field", "changed", "name"],
      [2, "field", "changed", "instructions"],
    ]);
    expect(rows.find((r) => r.title === "instructions")).toMatchObject({ before: "", after: "ساعد العميل." });
  });

  test("a removed node takes its name from the old version", () => {
    const before = def();
    const after = def((d) => ({
      ...d,
      workflows: d.workflows.map((w) => ({ ...w, nodes: w.nodes.filter((n) => n.type !== "autonomous"), edges: [] })),
    }));
    const rows = diffRows(diffDefinitions(before, after), before, after);
    const node = rows.find((r) => r.kind === "node");
    expect(node).toMatchObject({ change: "removed", detail: "Autonomous node" });
    expect(node?.title).toBe(before.workflows[0]?.nodes.find((n) => n.type === "autonomous")?.name);
    expect(rows.some((r) => r.kind === "transition" && r.change === "removed")).toBe(true);
  });
});

describe("formatting", () => {
  test("paths and values", () => {
    expect(formatDiffPath(["branches", "Order", "when"])).toBe("branches.Order.when");
    expect(formatDiffPath(["options", 2, "label"])).toBe("options[2].label");
    expect(formatDiffPath([])).toBe("value");
    expect(formatValue("نص")).toBe("نص");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue(undefined)).toBeUndefined();
  });
});
