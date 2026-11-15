import { checkWorkflowStructure, type Node, nodePorts, Workflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { copyFragment } from "../interaction/clipboard";
import { type Command, CommandRejected, commands } from "./commands";
import { createCard, createMenuCard, createNode, type SimpleCardType } from "./factories";
import { rng, seededDraft } from "./fixtures.test-utils";
import { createCanvasStore } from "./store";

/**
 * Task 2.3: every command has do/undo tests, and 100 random command sequences keep the document
 * schema-valid. Undo and redo go through the store, as the canvas uses them.
 */

/** Runs a command in a fresh store, then undo and redo, and returns the three documents. */
function roundTrip(wf: Workflow, command: Command) {
  const store = createCanvasStore();
  const { manifest } = seededDraft();
  store.getState().load({
    botId: "bot_x",
    manifest: { rev: 0, doc: { ...manifest, mainWorkflowId: wf.id } },
    workflows: [{ rev: 0, doc: wf }],
  });
  const result = store.getState().execute(command, wf.id);
  expect(result).toEqual({ ok: true });
  const after = store.getState().workflows[wf.id]?.doc as Workflow;
  expect(store.getState().undo(wf.id)).toBe(true);
  const undone = store.getState().workflows[wf.id]?.doc as Workflow;
  expect(store.getState().redo(wf.id)).toBe(true);
  const redone = store.getState().workflows[wf.id]?.doc as Workflow;
  return { after, undone, redone };
}

/** The seeded Main workflow plus a standard node "Ask" between Start and the Assistant. */
function fixture() {
  const { main } = seededDraft();
  const [start, agent] = main.nodes as [Node, Node];
  const ask = createNode("standard", "Ask") as Extract<Node, { type: "standard" }>;
  const branch = createCard("branch");
  const say = createCard("say");
  ask.cards = [say, branch];
  const branchId = branch.type === "branch" ? (branch.branches[0]?.id ?? "") : "";
  const wf: Workflow = Workflow.parse({
    ...main,
    nodes: [start, ask, agent],
    edges: [
      { id: "edge_0000000001", from: { nodeId: start.id, port: "next" }, to: { nodeId: ask.id } },
      {
        id: "edge_0000000002",
        from: { nodeId: ask.id, port: `card:${branch.id}:branch:${branchId}` },
        to: { nodeId: agent.id },
      },
      { id: "edge_0000000003", from: { nodeId: ask.id, port: "next" }, to: { nodeId: agent.id } },
    ],
    layout: { ...main.layout, [ask.id]: { x: 180, y: 120 } },
  });
  return { wf, start, ask, agent, say, branch, branchId };
}

const edgeProblems = (wf: Workflow) => checkWorkflowStructure(wf).filter((i) => i.code.startsWith("edge_"));

describe("each command, done, undone and redone", () => {
  const cases: [
    string,
    () => { wf: Workflow; command: Command; check: (after: Workflow, before: Workflow) => void },
  ][] = [
    [
      "addNode",
      () => {
        const f = fixture();
        const node = createNode("end");
        return {
          wf: f.wf,
          command: commands.addNode(node, { x: 720, y: 0 }),
          check: (a) => {
            expect(a.nodes.at(-1)?.id).toBe(node.id);
            expect(a.layout[node.id]).toEqual({ x: 720, y: 0 });
          },
        };
      },
    ],
    [
      "deleteNodes removes their transitions and positions",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.deleteNodes([f.ask.id]),
          check: (a) => {
            expect(a.nodes.map((n) => n.id)).not.toContain(f.ask.id);
            expect(a.edges.some((e) => e.from.nodeId === f.ask.id || e.to.nodeId === f.ask.id)).toBe(false);
            expect(a.layout[f.ask.id]).toBeUndefined();
          },
        };
      },
    ],
    [
      "deleteSelection removes nodes and transitions in one step",
      () => {
        const f = fixture();
        const edge = f.wf.edges.find((e) => e.from.nodeId !== f.ask.id && e.to.nodeId !== f.ask.id);
        return {
          wf: f.wf,
          command: commands.deleteSelection([f.ask.id], edge ? [edge.id] : []),
          check: (a) => {
            expect(a.nodes.map((n) => n.id)).not.toContain(f.ask.id);
            expect(a.edges.some((e) => e.from.nodeId === f.ask.id || e.to.nodeId === f.ask.id)).toBe(false);
            if (edge) expect(a.edges.map((e) => e.id)).not.toContain(edge.id);
          },
        };
      },
    ],
    [
      "addCardWithVariable adds the card and its workflow variable together",
      () => {
        const f = fixture();
        const made = createMenuCard("capture", f.wf, [f.wf]);
        if (!("card" in made) || !made.variable) throw new Error("expected a card and a variable");
        return {
          wf: f.wf,
          command: commands.addCardWithVariable(f.ask.id, made.card, made.variable),
          check: (a) => {
            expect(a.variables.map((v) => v.name)).toEqual(["answer"]);
            const node = a.nodes.find((n) => n.id === f.ask.id);
            expect(node?.type === "standard" && node.cards.at(-1)?.id).toBe(made.card.id);
          },
        };
      },
    ],
    [
      "paste adds the copied nodes with new ids and reports them",
      () => {
        const f = fixture();
        const fragment = copyFragment(f.wf, [f.ask.id, f.agent.id]);
        if (!fragment) throw new Error("no fragment");
        const command = commands.paste(fragment, { x: 1_200, y: 400 });
        return {
          wf: f.wf,
          command,
          check: (a, b) => {
            expect(a.nodes).toHaveLength(b.nodes.length + 2);
            expect(command.created).toHaveLength(2);
            expect(command.created).not.toContain(f.ask.id);
            // The ask → agent transitions came along, pointing at the copies.
            const copies = new Set(command.created);
            expect(a.edges.filter((e) => copies.has(e.from.nodeId) && copies.has(e.to.nodeId))).toHaveLength(2);
          },
        };
      },
    ],
    [
      "addNodeFrom adds a node and wires the output to it in one step",
      () => {
        const f = fixture();
        const node = createNode("end");
        return {
          wf: f.wf,
          command: commands.addNodeFrom(node, { x: 900, y: 0 }, { nodeId: f.ask.id, port: "next" }),
          check: (a) => {
            expect(a.nodes.at(-1)?.id).toBe(node.id);
            // One transition per output: Ask's `next` now goes to the new node.
            expect(
              a.edges.filter((e) => e.from.nodeId === f.ask.id && e.from.port === "next").map((e) => e.to.nodeId),
            ).toEqual([node.id]);
          },
        };
      },
    ],
    [
      "moveNodes changes only the layout",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.moveNodes({ [f.ask.id]: { x: 200, y: 400 } }),
          check: (a, b) => {
            expect(a.layout[f.ask.id]).toEqual({ x: 200, y: 400 });
            expect(a.nodes).toBe(b.nodes);
            expect(a.edges).toBe(b.edges);
          },
        };
      },
    ],
    [
      "renameNode",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.renameNode(f.ask.id, "  اسأل عن الطلب  "),
          check: (a) => expect(a.nodes[1]?.name).toBe("اسأل عن الطلب"),
        };
      },
    ],
    [
      "updateNode",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.updateNode(f.agent.id, (n) =>
            n.type === "autonomous" ? { ...n, instructions: "ساعد العميل" } : n,
          ),
          check: (a) => expect((a.nodes[2] as Extract<Node, { type: "autonomous" }>).instructions).toBe("ساعد العميل"),
        };
      },
    ],
    [
      "connect moves an output that already has a transition",
      () => {
        const f = fixture();
        const end = createNode("end");
        const wf = commands.addNode(end, { x: 0, y: 300 }).apply(f.wf);
        return {
          wf,
          command: commands.connect({ nodeId: f.ask.id, port: "next" }, end.id),
          check: (a) => {
            const fromNext = a.edges.filter((e) => e.from.nodeId === f.ask.id && e.from.port === "next");
            expect(fromNext).toHaveLength(1);
            expect(fromNext[0]?.to.nodeId).toBe(end.id);
            expect(fromNext[0]?.id).toBe("edge_0000000003");
          },
        };
      },
    ],
    [
      "deleteEdges",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.deleteEdges(["edge_0000000002"]),
          check: (a) => expect(a.edges.map((e) => e.id)).toEqual(["edge_0000000001", "edge_0000000003"]),
        };
      },
    ],
    [
      "reconnect",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.reconnect("edge_0000000001", f.agent.id),
          check: (a) => expect(a.edges.find((e) => e.id === "edge_0000000001")?.to.nodeId).toBe(f.agent.id),
        };
      },
    ],
    [
      "addCard at an index",
      () => {
        const f = fixture();
        const card = createCard("log");
        return {
          wf: f.wf,
          command: commands.addCard(f.ask.id, card, 1),
          check: (a) => expect((a.nodes[1] as Extract<Node, { type: "standard" }>).cards[1]?.id).toBe(card.id),
        };
      },
    ],
    [
      "updateCard removes the transition of a branch that no longer exists",
      () => {
        const f = fixture();
        const changed =
          f.branch.type === "branch"
            ? { ...f.branch, branches: [{ id: "br_AAAAAAAAAA", label: "Other", when: "false" }] }
            : f.branch;
        return {
          wf: f.wf,
          command: commands.updateCard(f.ask.id, changed),
          check: (a) => {
            expect(a.edges.some((e) => e.from.port.includes(f.branchId))).toBe(false);
            expect(edgeProblems(a)).toEqual([]);
          },
        };
      },
    ],
    [
      "moveCard",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.moveCard(f.ask.id, f.branch.id, 0),
          check: (a) =>
            expect((a.nodes[1] as Extract<Node, { type: "standard" }>).cards.map((c) => c.id)).toEqual([
              f.branch.id,
              f.say.id,
            ]),
        };
      },
    ],
    [
      "moveCard of an End card to the top drops the node's next output",
      () => {
        const f = fixture();
        const end = createCard("end");
        const wf = commands.addCard(f.ask.id, end).apply(f.wf);
        return {
          wf: commands.moveCard(f.ask.id, end.id, 2).apply(wf),
          command: commands.moveCard(f.ask.id, end.id, 99),
          check: (a) => {
            const ask = a.nodes[1] as Node;
            expect(nodePorts(ask)).not.toContain("next");
            expect(a.edges.some((e) => e.from.nodeId === f.ask.id && e.from.port === "next")).toBe(false);
          },
        };
      },
    ],
    [
      "deleteCard removes the transitions from its outputs",
      () => {
        const f = fixture();
        return {
          wf: f.wf,
          command: commands.deleteCard(f.ask.id, f.branch.id),
          check: (a) => {
            expect(a.edges.map((e) => e.id)).toEqual(["edge_0000000001", "edge_0000000003"]);
          },
        };
      },
    ],
  ];

  test.each(cases)("%s", (_name, make) => {
    const { wf, command, check } = make();
    const { after, undone, redone } = roundTrip(wf, command);
    check(after, wf);
    expect(undone).toEqual(wf);
    expect(redone).toEqual(after);
    expect(() => Workflow.parse(after)).not.toThrow();
    expect(edgeProblems(after)).toEqual([]);
  });
});

describe("rejected commands", () => {
  test.each([
    [
      "connecting to Start",
      (f: ReturnType<typeof fixture>) => commands.connect({ nodeId: f.ask.id, port: "next" }, f.start.id),
      /cannot be the target/,
    ],
    [
      "an output the node does not have",
      (f: ReturnType<typeof fixture>) => commands.connect({ nodeId: f.agent.id, port: "next" }, f.ask.id),
      /no such output/,
    ],
    [
      "cards in an Autonomous node",
      (f: ReturnType<typeof fixture>) => commands.addCard(f.agent.id, createCard("say")),
      /standard nodes/,
    ],
    ["an empty name", (f: ReturnType<typeof fixture>) => commands.renameNode(f.ask.id, "   "), /needs a name/],
    [
      "changing a node's type",
      (f: ReturnType<typeof fixture>) => commands.updateNode(f.ask.id, (n) => ({ ...createNode("end"), id: n.id })),
      /keeps its id and type/,
    ],
  ])("%s is refused and changes nothing", (_name, make, reason) => {
    const f = fixture();
    expect(() => make(f).apply(f.wf)).toThrow(CommandRejected);
    expect(() => make(f).apply(f.wf)).toThrow(reason);
  });
});

describe("100 random command sequences", () => {
  const SIMPLE: SimpleCardType[] = ["say", "branch", "code", "end", "log", "set_timeout", "handoff"];
  const NODE_TYPES = ["standard", "autonomous", "end", "note", "trigger"] as const;

  function randomCommand(wf: Workflow, r: () => number): Command {
    const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)];
    const node = pick(wf.nodes);
    const standard = pick(wf.nodes.filter((n): n is Extract<Node, { type: "standard" }> => n.type === "standard"));
    switch (Math.floor(r() * 12)) {
      case 0:
        return commands.addNode(createNode(pick(NODE_TYPES) ?? "standard"), {
          x: Math.round(r() * 2000),
          y: Math.round(r() * 1200),
        });
      case 1:
        return commands.deleteNodes(node && node.type !== "start" ? [node.id] : []);
      case 2:
        return commands.moveNodes(node ? { [node.id]: { x: Math.round(r() * 2000), y: Math.round(r() * 1200) } } : {});
      case 3: {
        const from = pick(wf.nodes.filter((n) => nodePorts(n).length > 0));
        const to = pick(wf.nodes);
        return commands.connect(
          { nodeId: from?.id ?? "", port: pick(from ? nodePorts(from) : []) ?? "next" },
          to?.id ?? "",
        );
      }
      case 4:
        return commands.deleteEdges(wf.edges.length ? [pick(wf.edges)?.id ?? ""] : []);
      case 5:
        return commands.addCard(standard?.id ?? "", createCard(pick(SIMPLE) ?? "say"), Math.floor(r() * 3));
      case 6:
        return commands.moveCard(standard?.id ?? "", pick(standard?.cards ?? [])?.id ?? "", Math.floor(r() * 4));
      case 7:
        return commands.deleteCard(standard?.id ?? "", pick(standard?.cards ?? [])?.id ?? "");
      case 8:
        return commands.renameNode(node?.id ?? "", r() < 0.5 ? "عقدة جديدة" : "Renamed");
      case 10: {
        // Copy one or two nodes and paste them somewhere else (2.5).
        const fragment = copyFragment(wf, [node?.id ?? "", pick(wf.nodes)?.id ?? ""]);
        return fragment
          ? commands.paste(fragment, { x: Math.round(r() * 2000), y: Math.round(r() * 1200) })
          : commands.moveNodes({});
      }
      case 11: {
        const made = createMenuCard(r() < 0.5 ? "capture" : "set_variable", wf, [wf]);
        return "card" in made && made.variable
          ? commands.addCardWithVariable(standard?.id ?? "", made.card, made.variable)
          : commands.moveNodes({});
      }
      default:
        return commands.reconnect(pick(wf.edges)?.id ?? "", pick(wf.nodes)?.id ?? "");
    }
  }

  test.each(Array.from({ length: 100 }, (_, i) => i + 1))(
    "seed %i: 60 steps stay valid, and undoing all returns the start",
    (seed) => {
      const r = rng(seed);
      const store = createCanvasStore();
      const { manifest, main } = seededDraft();
      store
        .getState()
        .load({ botId: "bot_x", manifest: { rev: 0, doc: manifest }, workflows: [{ rev: 0, doc: main }] });
      let applied = 0;
      for (let step = 0; step < 60; step++) {
        const wf = store.getState().workflows[main.id]?.doc as Workflow;
        const result = store.getState().execute(randomCommand(wf, r));
        const now = store.getState().workflows[main.id]?.doc as Workflow;
        if (result.ok && now !== wf) applied++;
        // Schema-valid, and no transition points at something missing, after every step.
        const parsed = Workflow.safeParse(now);
        expect(parsed.success, `seed ${seed} step ${step}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect(edgeProblems(now), `seed ${seed} step ${step}`).toEqual([]);
      }
      for (let i = 0; i < applied; i++) store.getState().undo();
      expect(store.getState().workflows[main.id]?.doc).toEqual(main);
      expect(store.getState().undo()).toBe(false);
    },
  );
});

describe("createMenuCard", () => {
  test.each(["say", "capture", "branch", "set_variable", "code", "handoff", "end", "log"] as const)(
    "%s makes a schema-valid card",
    (type) => {
      const { wf } = fixture();
      const made = createMenuCard(type, wf, [wf]);
      expect("card" in made).toBe(true);
    },
  );

  test("names a new variable that does not collide: answer, answer_2", () => {
    const { wf } = fixture();
    const first = createMenuCard("capture", wf, [wf]);
    if (!("card" in first) || !first.variable) throw new Error("expected a variable");
    const withOne = { ...wf, variables: [first.variable] };
    const second = createMenuCard("capture", withOne, [withOne]);
    expect("card" in second && second.variable?.name).toBe("answer_2");
  });

  test("cards that need something the bot does not have yet say what to create", () => {
    const { wf } = fixture();
    expect(createMenuCard("kb_search", wf, [wf])).toEqual({ unavailable: "Create a knowledge base first" });
    expect(createMenuCard("table", wf, [wf])).toEqual({ unavailable: "Create a table first" });
    expect(createMenuCard("call_workflow", wf, [wf])).toEqual({ unavailable: "Create a sub-workflow first" });
  });
});
