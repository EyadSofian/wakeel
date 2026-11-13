import type { Workflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { commands } from "./commands";
import { createCard, createNode } from "./factories";
import { seededDraft } from "./fixtures.test-utils";
import { HISTORY_LIMIT } from "./history";
import { createCanvasStore, isDirty, workflowKey } from "./store";

const loaded = () => {
  const store = createCanvasStore();
  const { manifest, main } = seededDraft();
  store.getState().load({ botId: "bot_x", manifest: { rev: 3, doc: manifest }, workflows: [{ rev: 5, doc: main }] });
  return { store, manifest, main };
};

describe("canvas store", () => {
  test("loading opens the main workflow, clean and with empty history", () => {
    const { store, main } = loaded();
    const s = store.getState();
    expect(s.activeWorkflowId).toBe(main.id);
    expect(isDirty(s.workflows[main.id] as never)).toBe(false);
    expect(s.workflows[main.id]?.rev).toBe(5);
    expect(s.undo()).toBe(false);
  });

  test("a command marks the document dirty; undoing back to the saved copy makes it clean", () => {
    const { store, main } = loaded();
    store.getState().execute(commands.renameNode(main.nodes[1]?.id ?? "", "Agent"));
    expect(isDirty(store.getState().workflows[main.id] as never)).toBe(true);
    store.getState().undo();
    expect(isDirty(store.getState().workflows[main.id] as never)).toBe(false);
  });

  test("a rejected command records nothing and reports the reason", () => {
    const { store, main } = loaded();
    const start = main.nodes[0]?.id ?? "";
    const result = store
      .getState()
      .execute(commands.connect({ nodeId: main.nodes[1]?.id ?? "", port: "error" }, start));
    expect(result).toEqual({ ok: false, reason: '"Start" cannot be the target of a transition.' });
    expect(store.getState().history[main.id]?.past).toEqual([]);
  });

  test("a new command after undo clears redo", () => {
    const { store, main } = loaded();
    const agent = main.nodes[1]?.id ?? "";
    store.getState().execute(commands.renameNode(agent, "A"));
    store.getState().undo();
    store.getState().execute(commands.renameNode(agent, "B"));
    expect(store.getState().redo()).toBe(false);
    expect((store.getState().workflows[main.id]?.doc as Workflow | undefined)?.nodes[1]?.name).toBe("B");
  });

  test("history is kept per workflow and capped", () => {
    const { store, main } = loaded();
    const agent = main.nodes[1]?.id ?? "";
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) store.getState().execute(commands.renameNode(agent, `Name ${i}`));
    expect(store.getState().history[main.id]?.past).toHaveLength(HISTORY_LIMIT);
  });

  test("selection drops what a command deleted, and a deleted card leaves the inspector", () => {
    const { store, main } = loaded();
    const node = createNode("standard");
    const card = createCard("say");
    store.getState().execute(commands.addNode(node, { x: 0, y: 200 }));
    store.getState().execute(commands.addCard(node.id, card));
    store.getState().select({ nodeIds: [node.id], card: { nodeId: node.id, cardId: card.id } });
    store.getState().execute(commands.deleteCard(node.id, card.id));
    expect(store.getState().selection.card).toBeUndefined();
    expect(store.getState().selection.nodeIds).toEqual([node.id]);
    store.getState().execute(commands.deleteNodes([node.id]));
    expect(store.getState().selection.nodeIds).toEqual([]);
    void main;
  });

  test("deleting a selection is one undo step: the node comes back with its transitions", () => {
    const { store, main } = loaded();
    const agent = main.nodes[1]?.id ?? "";
    const edges = main.edges.filter((e) => e.to.nodeId === agent).map((e) => e.id);
    store.getState().execute(commands.deleteSelection([agent], edges));
    store.getState().undo();
    const wf = store.getState().workflows[main.id]?.doc as Workflow | undefined;
    expect(wf?.nodes.map((n) => n.id)).toContain(agent);
    expect(wf?.edges.map((e) => e.id)).toEqual(main.edges.map((e) => e.id));
  });

  test("opening another workflow clears the selection", () => {
    const { store, main } = loaded();
    store.getState().select({ nodeIds: [main.nodes[0]?.id ?? ""] });
    store.getState().open(main.id);
    expect(store.getState().selection.nodeIds).toEqual([]);
  });

  test("conflict: theirs takes the server copy and forgets local history; mine keeps local changes on the new revision", () => {
    const { store, main } = loaded();
    const agent = main.nodes[1]?.id ?? "";
    const key = workflowKey(main.id);
    store.getState().execute(commands.renameNode(agent, "Mine"));
    const server = { ...main, name: "Theirs" };
    store.getState().beginSave(key);
    store.getState().failSave(key, { conflict: { rev: 9, doc: server } });
    expect(store.getState().workflows[main.id]?.conflict?.rev).toBe(9);
    // While in conflict, nothing else saves.
    expect(store.getState().beginSave(key)).toBeUndefined();

    store.getState().resolveConflict(key, "mine");
    const mine = store.getState().workflows[main.id];
    expect(mine?.rev).toBe(9);
    expect((mine?.doc as Workflow | undefined)?.nodes[1]?.name).toBe("Mine");
    expect(isDirty(mine as never)).toBe(true);

    store.getState().beginSave(key);
    store.getState().failSave(key, { conflict: { rev: 10, doc: server } });
    store.getState().resolveConflict(key, "theirs");
    const theirs = store.getState().workflows[main.id];
    expect(theirs?.rev).toBe(10);
    expect((theirs?.doc as Workflow | undefined)?.name).toBe("Theirs");
    expect(isDirty(theirs as never)).toBe(false);
    expect(store.getState().undo()).toBe(false);
  });
});
