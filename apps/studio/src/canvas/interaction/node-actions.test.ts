import { describe, expect, test } from "vitest";
import { seededDraft } from "../store/fixtures.test-utils";
import { deletableNodeIds, duplicateCommand, isFixedNode } from "./node-actions";

describe("node actions", () => {
  const { main } = seededDraft();
  const start = main.nodes.find((n) => n.type === "start");
  const others = main.nodes.filter((n) => !isFixedNode(n));

  test("the seeded bot has a start node and others to act on", () => {
    expect(start).toBeDefined();
    expect(others.length).toBeGreaterThan(0);
  });

  test("Start is never deletable; unknown ids are dropped", () => {
    expect(deletableNodeIds(main, [start?.id ?? "", "node_missing", ...others.map((n) => n.id)])).toEqual(
      others.map((n) => n.id),
    );
  });

  test("duplicating only Start does nothing", () => {
    expect(duplicateCommand(main, [start?.id ?? ""])).toBeUndefined();
  });

  test("a duplicate is one paste command offset from the original, with new ids", () => {
    const node = others[0];
    if (!node) throw new Error("no node");
    const command = duplicateCommand(main, [node.id]);
    // The new ids are known once the command has run.
    const after = command?.apply(main);
    expect(command?.created).toHaveLength(1);
    const copy = after?.nodes.find((n) => n.id === command?.created[0]);
    expect(copy?.id).not.toBe(node.id);
    expect(copy?.type).toBe(node.type);
    const was = main.layout[node.id];
    const now = copy ? after?.layout[copy.id] : undefined;
    expect(now).toEqual({ x: (was?.x ?? 0) + 32, y: (was?.y ?? 0) + 32 });
  });
});
