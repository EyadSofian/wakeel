import { newElementId, renameIo, renameVariable, type Variable, type Workflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { commands } from "./commands";
import { createCard, createNode } from "./factories";
import { seededDraft } from "./fixtures.test-utils";
import { createCanvasStore, isDirty } from "./store";

/** Task 2.7: variable and input/output commands, and renames applied as refactors. */

const workflowVar = (name: string): Variable => ({
  id: newElementId("var"),
  name,
  scope: "workflow",
  type: "string",
  sensitive: false,
});

function loaded() {
  const store = createCanvasStore();
  const { manifest, main } = seededDraft();
  const sub: Workflow = {
    id: newElementId("wf"),
    name: "Lookup",
    kind: "sub",
    inputs: [{ name: "orderId", type: "string", required: true }],
    outputs: [],
    variables: [],
    nodes: [createNode("entry")],
    edges: [],
    layout: {},
  };
  store.getState().load({
    botId: "bot_x",
    manifest: { rev: 1, doc: manifest },
    workflows: [
      { rev: 1, doc: main },
      { rev: 1, doc: sub },
    ],
  });
  return { store, main, sub };
}

const doc = (store: ReturnType<typeof loaded>["store"], id: string) => store.getState().workflows[id]?.doc as Workflow;

describe("variable commands", () => {
  test("add, edit and delete a workflow variable, each undoable", () => {
    const { store, main } = loaded();
    const v = workflowVar("email");
    expect(store.getState().execute(commands.addVariable(v))).toEqual({ ok: true });
    expect(store.getState().execute(commands.updateVariable({ ...v, type: "number" }))).toEqual({ ok: true });
    expect(doc(store, main.id).variables).toEqual([{ ...v, type: "number" }]);
    store.getState().undo();
    expect(doc(store, main.id).variables).toEqual([v]);
    expect(store.getState().execute(commands.deleteVariable(v.id))).toEqual({ ok: true });
    expect(doc(store, main.id).variables).toEqual([]);
    store.getState().undo();
    expect(doc(store, main.id).variables).toEqual([v]);
  });

  test("names stay unique and change only by rename", () => {
    const { store } = loaded();
    const v = workflowVar("email");
    store.getState().execute(commands.addVariable(v));
    expect(store.getState().execute(commands.addVariable(workflowVar("email")))).toEqual({
      ok: false,
      reason: 'A variable named "email" already exists.',
    });
    expect(store.getState().execute(commands.updateVariable({ ...v, name: "mail" }))).toEqual({
      ok: false,
      reason: "Rename a variable from the Variables screen.",
    });
    expect(store.getState().execute(commands.addVariable({ ...workflowVar("x"), scope: "user" }))).toMatchObject({
      ok: false,
    });
  });

  test("inputs and outputs: only on sub-workflows; add, edit, delete", () => {
    const { store, main, sub } = loaded();
    const field = { name: "total", type: "number" as const, required: true };
    expect(store.getState().execute(commands.setIo("output", "total", field), main.id)).toEqual({
      ok: false,
      reason: "Only sub-workflows have inputs and outputs.",
    });
    expect(store.getState().execute(commands.setIo("output", "total", field), sub.id)).toEqual({ ok: true });
    store.getState().execute(commands.setIo("output", "total", { ...field, required: false }), sub.id);
    expect(doc(store, sub.id).outputs).toEqual([{ ...field, required: false }]);
    store.getState().execute(commands.setIo("input", "orderId", undefined), sub.id);
    expect(doc(store, sub.id).inputs).toEqual([]);
    store.getState().undo(sub.id);
    expect(doc(store, sub.id).inputs.map((i) => i.name)).toEqual(["orderId"]);
  });
});

describe("refactor", () => {
  test("a rename rewrites the open documents and their undo history, and marks them dirty", () => {
    const { store, main } = loaded();
    const v = workflowVar("email");
    store.getState().execute(commands.addVariable(v));
    const node = createNode("standard", "Greet") as Extract<ReturnType<typeof createNode>, { type: "standard" }>;
    const say = createCard("say");
    if (say.type !== "say") throw new Error("say");
    say.message = { type: "text", text: "بريدك {{ workflow.email }}", format: "markdown" };
    store.getState().execute(commands.addNode({ ...node, cards: [say] }, { x: 0, y: 0 }));

    const def = {
      manifest: store.getState().manifest?.doc ?? seededDraft().manifest,
      workflows: Object.values(store.getState().workflows).map((d) => d.doc),
    };
    const r = renameVariable(def, v.id, "mail");
    if (!r) throw new Error("variable not found");
    store.getState().refactor(r);

    const after = doc(store, main.id);
    expect(after.variables[0]?.name).toBe("mail");
    expect(JSON.stringify(after)).toContain("بريدك {{ workflow.mail }}");
    expect(isDirty(store.getState().workflows[main.id] as never)).toBe(true);

    // Undoing the node add and redoing it brings back the node with the new name, not the old one.
    store.getState().undo();
    expect(doc(store, main.id).variables[0]?.name).toBe("mail");
    store.getState().redo();
    expect(JSON.stringify(doc(store, main.id))).not.toContain("workflow.email");
    // Undoing the variable add removes it; nothing reintroduces "email".
    store.getState().undo();
    store.getState().undo();
    expect(JSON.stringify(doc(store, main.id))).not.toContain("email");
  });

  test("an input rename reaches the callers in other workflows", () => {
    const { store, main, sub } = loaded();
    const node = createNode("standard", "Call") as Extract<ReturnType<typeof createNode>, { type: "standard" }>;
    const call = createCard("say");
    store.getState().execute(
      commands.addNode(
        {
          ...node,
          cards: [
            {
              id: call.id,
              type: "call_workflow",
              disabled: false,
              workflowId: sub.id,
              inputs: { orderId: "'A1'" },
              outputs: {},
            },
          ],
        },
        { x: 0, y: 0 },
      ),
    );
    store.getState().refactor(renameIo(sub.id, "input", "orderId", "ref"));
    expect(doc(store, sub.id).inputs[0]?.name).toBe("ref");
    expect(JSON.stringify(doc(store, main.id))).toContain('"inputs":{"ref":"\'A1\'"}');
    expect(store.getState().workflows[sub.id]?.doc).not.toBe(store.getState().workflows[sub.id]?.saved);
  });

  test("a refactor that changes nothing keeps every document clean", () => {
    const { store } = loaded();
    store.getState().refactor(renameIo(newElementId("wf"), "input", "a", "b"));
    for (const d of store.getState().docs()) expect(isDirty(d.state)).toBe(false);
  });
});
