import { describe, expect, test } from "vitest";
import {
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  BotDiff,
  type Card,
  diffDefinitions,
  type Node,
  type Workflow,
} from "../src/index";
import { loadFixture } from "./load-fixture";

/** Task 7.4: structural diff, workflow → node → card → field, ignoring layout. */

const MAIN = "wf_e3EcDF6eqB";
const SUB = "wf_UdZwzTnxBs";
const START = "node_lRoBm4x7yq";
const GREETING = "node_qFcKpkyCk2";
const ASSISTANT = "node_E9LhcsG1bp";
const END = "node_muKVh4n3tu";
const SAY = "card_TgMea9mbMU";
const CAPTURE = "card_RFPilKy6x7";
const BRANCH = "card_f7dYpq2Mfs";
const CALL = "card_085Pcrsntf";
const LOOKUP_TOOL = "tool_2A5MKYgaBB";
const LANG_VAR = "var_fQVXMTn0Vr";

const base: BotDefinition = BotDefinitionSchema.parse(loadFixture("bot-definition.json"));

/** A parsed copy of the fixture after `change`, so defaults are filled in as the diff expects. */
function edit(change: (def: BotDefinition) => void): BotDefinition {
  const copy = structuredClone(base);
  change(copy);
  return BotDefinitionSchema.parse(copy);
}

function workflow(def: BotDefinition, id: string): Workflow {
  const wf = def.workflows.find((w) => w.id === id);
  if (!wf) throw new Error(`No workflow ${id} in the fixture`);
  return wf;
}

function node(def: BotDefinition, wfId: string, nodeId: string): Node {
  const n = workflow(def, wfId).nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error(`No node ${nodeId} in the fixture`);
  return n;
}

function standard(def: BotDefinition, nodeId: string) {
  const n = node(def, MAIN, nodeId);
  if (n.type !== "standard") throw new Error(`${nodeId} is not a standard node`);
  return n;
}

function autonomous(def: BotDefinition, nodeId: string) {
  const n = node(def, MAIN, nodeId);
  if (n.type !== "autonomous") throw new Error(`${nodeId} is not an autonomous node`);
  return n;
}

function card(def: BotDefinition, nodeId: string, cardId: string): Card {
  const c = standard(def, nodeId).cards.find((x) => x.id === cardId);
  if (!c) throw new Error(`No card ${cardId} in the fixture`);
  return c;
}

const zero = { added: 0, removed: 0, changed: 0 };

describe("diffDefinitions: no change", () => {
  test("identical definitions produce an empty diff", () => {
    const diff = diffDefinitions(base, structuredClone(base));
    expect(diff).toEqual({
      hasChanges: false,
      manifest: [],
      workflows: [],
      summary: { workflows: zero, nodes: zero, cards: zero, edges: zero, manifestFields: 0 },
    });
  });

  test("moving every node on the canvas is not a change", () => {
    const after = edit((def) => {
      for (const wf of def.workflows) {
        wf.layout = Object.fromEntries(wf.nodes.map((n, i) => [n.id, { x: 1_000 + i * 37, y: -400 + i * 11 }]));
      }
    });
    const diff = diffDefinitions(base, after);
    expect(diff.hasChanges).toBe(false);
    expect(diff.workflows).toEqual([]);
  });

  test("resizing a note and dropping layout entries is not a change", () => {
    const withNote = edit((def) => {
      workflow(def, MAIN).nodes.push({ id: "node_NoteNode01", type: "note", name: "Note", text: "تذكير" });
      workflow(def, MAIN).layout["node_NoteNode01"] = { x: 0, y: 0, width: 200, height: 100 };
    });
    const resized = structuredClone(withNote);
    workflow(resized, MAIN).layout = { node_NoteNode01: { x: 50, y: 50, width: 320, height: 180 } };
    expect(diffDefinitions(withNote, resized).hasChanges).toBe(false);
  });

  test("an edge that only got a new id is not a change", () => {
    const after = edit((def) => {
      const e = workflow(def, MAIN).edges.find((x) => x.from.nodeId === START);
      if (e) e.id = "edge_Reconnect1";
    });
    expect(diffDefinitions(base, after).hasChanges).toBe(false);
  });

  test("the result parses with the BotDiff schema", () => {
    const after = edit((def) => {
      standard(def, GREETING).name = "الترحيب بالعميل";
    });
    const diff = diffDefinitions(base, after);
    expect(BotDiff.parse(diff)).toEqual(diff);
  });
});

describe("diffDefinitions: added", () => {
  test("a card added to a node", () => {
    const after = edit((def) => {
      standard(def, GREETING).cards.splice(1, 0, {
        id: "card_NewCard001",
        type: "say",
        disabled: false,
        message: { type: "text", text: "لحظة واحدة", format: "markdown" },
      });
    });
    const diff = diffDefinitions(base, after);
    expect(diff.workflows).toEqual([
      {
        workflowId: MAIN,
        change: "changed",
        fields: [],
        nodes: [
          {
            nodeId: GREETING,
            nodeType: "standard",
            change: "changed",
            fields: [],
            cards: [{ cardId: "card_NewCard001", cardType: "say", change: "added", fields: [] }],
          },
        ],
        edges: [],
      },
    ]);
    expect(diff.summary.cards).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(diff.summary.nodes).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  test("a node with cards and a transition into it", () => {
    const after = edit((def) => {
      const wf = workflow(def, MAIN);
      wf.nodes.push({
        id: "node_NewNode001",
        type: "standard",
        name: "تأكيد",
        cards: [
          {
            id: "card_NewCard001",
            type: "say",
            disabled: false,
            message: { type: "text", text: "تمام", format: "markdown" },
          },
          { id: "card_NewCard002", type: "end", disabled: false, reason: "completed" },
        ],
      });
      wf.edges.push({
        id: "edge_NewEdge001",
        from: { nodeId: GREETING, port: `card:${CAPTURE}:option:0` },
        to: { nodeId: "node_NewNode001" },
      });
    });
    const diff = diffDefinitions(base, after);
    const wf = diff.workflows[0];
    expect(wf?.nodes).toEqual([
      {
        nodeId: "node_NewNode001",
        nodeType: "standard",
        change: "added",
        fields: [],
        cards: [
          { cardId: "card_NewCard001", cardType: "say", change: "added", fields: [] },
          { cardId: "card_NewCard002", cardType: "end", change: "added", fields: [] },
        ],
      },
    ]);
    expect(wf?.edges).toEqual([
      {
        from: { nodeId: GREETING, port: `card:${CAPTURE}:option:0` },
        change: "added",
        toAfter: "node_NewNode001",
      },
    ]);
    expect(diff.summary).toEqual({
      workflows: { added: 0, removed: 0, changed: 1 },
      nodes: { added: 1, removed: 0, changed: 0 },
      cards: { added: 2, removed: 0, changed: 0 },
      edges: { added: 1, removed: 0, changed: 0 },
      manifestFields: 0,
    });
  });

  test("a workflow lists all its nodes, cards and edges as added", () => {
    const after = edit((def) => {
      const copy = structuredClone(workflow(def, SUB));
      copy.id = "wf_NewFlow001";
      copy.name = "نسخة";
      copy.nodes = copy.nodes.map((n, i) => ({ ...n, id: `node_CopyNode0${i}` }));
      copy.edges = [
        { id: "edge_CopyEdge01", from: { nodeId: "node_CopyNode00", port: "next" }, to: { nodeId: "node_CopyNode01" } },
      ];
      const search = copy.nodes[1];
      if (search?.type === "standard") search.cards = search.cards.map((c) => ({ ...c, id: "card_CopyCard01" }));
      def.workflows.push(copy);
    });
    const diff = diffDefinitions(base, after);
    expect(diff.workflows).toHaveLength(1);
    const wf = diff.workflows[0];
    expect(wf?.workflowId).toBe("wf_NewFlow001");
    expect(wf?.change).toBe("added");
    expect(wf?.fields).toEqual([]);
    expect(wf?.nodes.map((n) => [n.nodeId, n.change])).toEqual([
      ["node_CopyNode00", "added"],
      ["node_CopyNode01", "added"],
      ["node_CopyNode02", "added"],
    ]);
    expect(wf?.nodes[1]?.cards).toEqual([
      { cardId: "card_CopyCard01", cardType: "kb_search", change: "added", fields: [] },
    ]);
    expect(wf?.edges).toEqual([
      { from: { nodeId: "node_CopyNode00", port: "next" }, change: "added", toAfter: "node_CopyNode01" },
    ]);
    expect(diff.summary).toEqual({
      workflows: { added: 1, removed: 0, changed: 0 },
      nodes: { added: 3, removed: 0, changed: 0 },
      cards: { added: 1, removed: 0, changed: 0 },
      edges: { added: 1, removed: 0, changed: 0 },
      manifestFields: 0,
    });
  });
});

describe("diffDefinitions: removed", () => {
  test("a card removed from a node", () => {
    const after = edit((def) => {
      const n = standard(def, GREETING);
      n.cards = n.cards.filter((c) => c.id !== BRANCH);
    });
    const diff = diffDefinitions(base, after);
    expect(diff.workflows[0]?.nodes[0]?.cards).toEqual([
      { cardId: BRANCH, cardType: "branch", change: "removed", fields: [] },
    ]);
    expect(diff.summary.cards).toEqual({ added: 0, removed: 1, changed: 0 });
  });

  test("removing a card does not mark the cards after it as moved", () => {
    const after = edit((def) => {
      const n = standard(def, GREETING);
      n.cards = n.cards.filter((c) => c.id !== SAY);
    });
    const cards = diffDefinitions(base, after).workflows[0]?.nodes[0]?.cards;
    expect(cards).toEqual([{ cardId: SAY, cardType: "say", change: "removed", fields: [] }]);
  });

  test("a node and its transitions", () => {
    const after = edit((def) => {
      const wf = workflow(def, MAIN);
      wf.nodes = wf.nodes.filter((n) => n.id !== END);
      wf.edges = wf.edges.filter((e) => e.to.nodeId !== END);
    });
    const diff = diffDefinitions(base, after);
    const wf = diff.workflows[0];
    expect(wf?.nodes).toEqual([{ nodeId: END, nodeType: "end", change: "removed", fields: [], cards: [] }]);
    expect(wf?.edges.map((e) => [e.from.nodeId, e.from.port, e.change, e.toBefore, e.toAfter])).toEqual([
      [ASSISTANT, "exit:exit_2XR33TZRbi", "removed", END, undefined],
      [ASSISTANT, "exit:exit_jqvvCmDnRQ", "removed", END, undefined],
      [GREETING, `card:${CAPTURE}:failed`, "removed", END, undefined],
    ]);
    expect(diff.summary.edges).toEqual({ added: 0, removed: 3, changed: 0 });
  });

  test("a workflow is the mirror image of adding it", () => {
    const without = edit((def) => {
      def.workflows = def.workflows.filter((w) => w.id !== SUB);
    });
    const removed = diffDefinitions(base, without);
    const added = diffDefinitions(without, base);
    expect(removed.workflows[0]?.change).toBe("removed");
    expect(removed.workflows[0]?.nodes.map((n) => n.change)).toEqual(["removed", "removed", "removed"]);
    expect(removed.summary.workflows).toEqual({ added: 0, removed: 1, changed: 0 });
    expect(removed.summary.cards).toEqual({ added: 0, removed: 1, changed: 0 });
    expect(added.summary.workflows).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(added.summary.cards).toEqual({ added: 1, removed: 0, changed: 0 });
    expect(removed.workflows[0]?.nodes.map((n) => n.nodeId)).toEqual(added.workflows[0]?.nodes.map((n) => n.nodeId));
  });
});

describe("diffDefinitions: changed fields", () => {
  test("a card field, by path inside the card", () => {
    const after = edit((def) => {
      const c = card(def, GREETING, CAPTURE);
      if (c.type === "capture" && c.prompt.type === "choice" && c.prompt.options[1]) {
        c.prompt.options[1].label = "English (US)";
      }
    });
    const nodes = diffDefinitions(base, after).workflows[0]?.nodes;
    expect(nodes).toEqual([
      {
        nodeId: GREETING,
        nodeType: "standard",
        change: "changed",
        fields: [],
        cards: [
          {
            cardId: CAPTURE,
            cardType: "capture",
            change: "changed",
            fields: [{ path: ["prompt", "options", 1, "label"], before: "English", after: "English (US)" }],
          },
        ],
      },
    ]);
  });

  test("an optional card field that is set and one that is cleared", () => {
    const after = edit((def) => {
      const c = card(def, GREETING, SAY);
      c.label = "Welcome";
      c.disabled = true;
    });
    const cards = diffDefinitions(base, after).workflows[0]?.nodes[0]?.cards;
    expect(cards?.[0]?.fields).toEqual([
      { path: ["label"], after: "Welcome" },
      { path: ["disabled"], before: false, after: true },
    ]);
    const back = diffDefinitions(after, base).workflows[0]?.nodes[0]?.cards;
    expect(back?.[0]?.fields).toEqual([
      { path: ["label"], before: "Welcome" },
      { path: ["disabled"], before: true, after: false },
    ]);
  });

  test("a node field, kept apart from its cards", () => {
    const after = edit((def) => {
      standard(def, GREETING).description = "Greets and asks for the language.";
    });
    expect(diffDefinitions(base, after).workflows[0]?.nodes).toEqual([
      {
        nodeId: GREETING,
        nodeType: "standard",
        change: "changed",
        fields: [{ path: ["description"], after: "Greets and asks for the language." }],
        cards: [],
      },
    ]);
  });

  test("autonomous node tools and exits are matched by id", () => {
    const after = edit((def) => {
      const n = autonomous(def, ASSISTANT);
      const tool = n.tools.find((t) => t.id === LOOKUP_TOOL);
      if (tool) tool.description = "Get an order's status. Ask for the number first.";
      n.temperature = 0.1;
    });
    const fields = diffDefinitions(base, after).workflows[0]?.nodes[0]?.fields;
    // Fields follow the schema's key order: tools come before temperature.
    expect(fields).toEqual([
      {
        path: ["tools", LOOKUP_TOOL, "description"],
        before: "Get the status of an order by its number. Use when the customer gives an order number.",
        after: "Get an order's status. Ask for the number first.",
      },
      { path: ["temperature"], before: 0.3, after: 0.1 },
    ]);
  });

  test("a tool added to and one removed from an autonomous node", () => {
    const before = autonomous(base, ASSISTANT);
    const kept = before.tools.filter((t) => t.id !== LOOKUP_TOOL);
    const removedTool = before.tools.find((t) => t.id === LOOKUP_TOOL);
    const newTool = {
      id: "tool_NewTool001",
      type: "workflow" as const,
      name: "lookUp",
      description: "Look up an order through the sub-workflow.",
      workflowId: SUB,
    };
    const after = edit((def) => {
      autonomous(def, ASSISTANT).tools = [...kept, newTool];
    });
    const fields = diffDefinitions(base, after).workflows[0]?.nodes[0]?.fields;
    expect(fields).toEqual([
      { path: ["tools", LOOKUP_TOOL], before: removedTool },
      { path: ["tools", "tool_NewTool001"], after: newTool },
    ]);
  });

  test("reordering a keyed list reports the order once", () => {
    const after = edit((def) => {
      const n = autonomous(def, ASSISTANT);
      n.tools = [...n.tools].reverse();
    });
    const ids = autonomous(base, ASSISTANT).tools.map((t) => t.id);
    expect(diffDefinitions(base, after).workflows[0]?.nodes[0]?.fields).toEqual([
      { path: ["tools"], before: ids, after: [...ids].reverse() },
    ]);
  });

  test("a list of plain values is compared whole", () => {
    const after = edit((def) => {
      autonomous(def, ASSISTANT).messageTypes = ["text", "choice", "image"];
    });
    expect(diffDefinitions(base, after).workflows[0]?.nodes[0]?.fields).toEqual([
      { path: ["messageTypes"], before: ["text", "choice"], after: ["text", "choice", "image"] },
    ]);
  });

  test("an exit node's output mapping is compared by key", () => {
    const after = edit((def) => {
      const n = workflow(def, SUB).nodes.find((x) => x.type === "exit");
      if (n?.type === "exit") n.outputs = { ...n.outputs, found: "workflow.passages.length > 0" };
    });
    const wf = diffDefinitions(base, after).workflows[0];
    expect(wf?.workflowId).toBe(SUB);
    expect(wf?.nodes[0]?.fields).toEqual([{ path: ["outputs", "found"], after: "workflow.passages.length > 0" }]);
  });

  test("workflow fields, variables and inputs", () => {
    const after = edit((def) => {
      const wf = workflow(def, SUB);
      wf.name = "البحث عن الطلب";
      const v = wf.variables[0];
      if (v) v.description = "Search results";
      wf.inputs.push({ name: "locale", type: "string", required: false });
    });
    const before = workflow(base, SUB);
    const wf = diffDefinitions(base, after).workflows[0];
    expect(wf?.fields).toEqual([
      { path: ["name"], before: before.name, after: "البحث عن الطلب" },
      { path: ["inputs", "locale"], after: { name: "locale", type: "string", required: false } },
      { path: ["variables", "var_Ae0r9HReQO", "description"], after: "Search results" },
    ]);
    expect(wf?.nodes).toEqual([]);
  });
});

describe("diffDefinitions: cards moved within a node", () => {
  test("moving the last card to the top marks only that card", () => {
    const after = edit((def) => {
      const n = standard(def, GREETING);
      const last = n.cards.pop();
      if (last) n.cards.unshift(last);
    });
    const diff = diffDefinitions(base, after);
    expect(diff.workflows[0]?.nodes[0]?.cards).toEqual([
      { cardId: CALL, cardType: "call_workflow", change: "changed", moved: { from: 3, to: 0 }, fields: [] },
    ]);
    expect(diff.summary.cards).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  test("a card that moved and changed carries both", () => {
    const after = edit((def) => {
      const n = standard(def, GREETING);
      const [first] = n.cards.splice(0, 1);
      if (first?.type === "say" && first.message.type === "text") first.message.text = "مرحباً";
      if (first) n.cards.push(first);
    });
    const cards = diffDefinitions(base, after).workflows[0]?.nodes[0]?.cards;
    expect(cards).toEqual([
      {
        cardId: SAY,
        cardType: "say",
        change: "changed",
        moved: { from: 0, to: 3 },
        fields: [{ path: ["message", "text"], before: "أهلاً بك في متجر النور. كيف أقدر أساعدك؟", after: "مرحباً" }],
      },
    ]);
  });

  test("a card moved to another node is removed there and added here", () => {
    const after = edit((def) => {
      const from = standard(def, GREETING);
      const moved = from.cards.find((c) => c.id === SAY);
      from.cards = from.cards.filter((c) => c.id !== SAY);
      const sub = workflow(def, SUB).nodes.find((n) => n.id === "node_Vj4Dc5OSke");
      if (moved && sub?.type === "standard") sub.cards.unshift(moved);
    });
    const diff = diffDefinitions(base, after);
    expect(
      diff.workflows.map((w) => [w.workflowId, w.nodes[0]?.cards[0]?.cardId, w.nodes[0]?.cards[0]?.change]),
    ).toEqual([
      [MAIN, SAY, "removed"],
      [SUB, SAY, "added"],
    ]);
  });
});

describe("diffDefinitions: edges", () => {
  test("a transition pointed at a different node", () => {
    const after = edit((def) => {
      const e = workflow(def, MAIN).edges.find((x) => x.from.port === "next" && x.from.nodeId === GREETING);
      if (e) e.to.nodeId = END;
    });
    const diff = diffDefinitions(base, after);
    expect(diff.workflows[0]?.nodes).toEqual([]);
    expect(diff.workflows[0]?.edges).toEqual([
      { from: { nodeId: GREETING, port: "next" }, change: "changed", toBefore: ASSISTANT, toAfter: END },
    ]);
    expect(diff.summary.edges).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  test("a transition deleted and one added on another port", () => {
    const after = edit((def) => {
      const wf = workflow(def, MAIN);
      wf.edges = wf.edges.filter((e) => e.from.port !== `card:${CAPTURE}:failed`);
      wf.edges.push({
        id: "edge_NewEdge001",
        from: { nodeId: GREETING, port: `card:${CAPTURE}:option:1` },
        to: { nodeId: END },
      });
    });
    expect(diffDefinitions(base, after).workflows[0]?.edges).toEqual([
      { from: { nodeId: GREETING, port: `card:${CAPTURE}:failed` }, change: "removed", toBefore: END },
      { from: { nodeId: GREETING, port: `card:${CAPTURE}:option:1` }, change: "added", toAfter: END },
    ]);
  });
});

describe("diffDefinitions: manifest", () => {
  test("settings", () => {
    const after = edit((def) => {
      def.manifest.settings.inactivityTimeoutMinutes = 30;
      def.manifest.settings.models.default = "anthropic:claude-opus-5-5";
    });
    const diff = diffDefinitions(base, after);
    expect(diff.workflows).toEqual([]);
    expect(diff.manifest).toEqual([
      {
        path: ["settings", "models", "default"],
        before: "anthropic:claude-sonnet-5-5",
        after: "anthropic:claude-opus-5-5",
      },
      { path: ["settings", "inactivityTimeoutMinutes"], before: 60, after: 30 },
    ]);
    expect(diff.summary.manifestFields).toBe(2);
    expect(diff.hasChanges).toBe(true);
  });

  test("variables are matched by id, config variables by key", () => {
    const after = edit((def) => {
      const lang = def.manifest.variables.find((v) => v.id === LANG_VAR);
      if (lang) lang.default = "en";
      def.manifest.variables = def.manifest.variables.filter((v) => v.id !== "var_70S80b1amf");
      def.manifest.variables.push({
        id: "var_NewVar0001",
        name: "city",
        scope: "user",
        type: "string",
        sensitive: false,
      });
      def.manifest.configVars.push({ key: "SHOP_URL", secret: false });
    });
    const removed = base.manifest.variables.find((v) => v.id === "var_70S80b1amf");
    expect(diffDefinitions(base, after).manifest).toEqual([
      { path: ["variables", LANG_VAR, "default"], before: "ar", after: "en" },
      { path: ["variables", "var_70S80b1amf"], before: removed },
      {
        path: ["variables", "var_NewVar0001"],
        after: { id: "var_NewVar0001", name: "city", scope: "user", type: "string", sensitive: false },
      },
      { path: ["configVars", "SHOP_URL"], after: { key: "SHOP_URL", secret: false } },
    ]);
  });

  test("locales are compared as one list", () => {
    const after = edit((def) => {
      def.manifest.locales = ["en", "ar"];
      def.manifest.defaultLocale = "en";
    });
    expect(diffDefinitions(base, after).manifest).toEqual([
      { path: ["defaultLocale"], before: "ar", after: "en" },
      { path: ["locales"], before: ["ar", "en"], after: ["en", "ar"] },
    ]);
  });
});

describe("diffDefinitions: Arabic text (CLAUDE.md §11)", () => {
  const texts = [
    ["egyptian", "ازيك، عايز أعرف الأوردر بتاعي هيوصل امتى؟"],
    ["gulf", "شلونك؟ أبي أعرف وين وصل طلبي، صار له أسبوع."],
    ["code switch", "ممكن تبعتلي الـ invoice على الإيميل please؟ محتاجها للـ accounting."],
    ["arabic-indic digits", "رقم الطلب ٤٥١٢٣ بتاريخ ١٣/١١/٢٠٢٦ والمبلغ ٢٥٠ جنيه."],
  ] as const;

  test.each(texts)("a %s message change keeps both texts exactly", (_label, text) => {
    const after = edit((def) => {
      const c = card(def, GREETING, SAY);
      if (c.type === "say" && c.message.type === "text") c.message.text = text;
    });
    const field = diffDefinitions(base, after).workflows[0]?.nodes[0]?.cards[0]?.fields[0];
    expect(field).toEqual({
      path: ["message", "text"],
      before: "أهلاً بك في متجر النور. كيف أقدر أساعدك؟",
      after: text,
    });
  });

  test("adding only diacritics is a change: the diff does not normalise", () => {
    const withTashkeel = "أَهْلاً بِكَ فِي مَتْجَرِ النُّور. كيف أقدر أساعدك؟";
    const after = edit((def) => {
      const c = card(def, GREETING, SAY);
      if (c.type === "say" && c.message.type === "text") c.message.text = withTashkeel;
    });
    const field = diffDefinitions(base, after).workflows[0]?.nodes[0]?.cards[0]?.fields[0];
    expect(field?.after).toBe(withTashkeel);
  });

  test("swapping Arabic-Indic for Western digits is a change", () => {
    const before = edit((def) => {
      const c = card(def, GREETING, SAY);
      if (c.type === "say" && c.message.type === "text") c.message.text = "رقم الطلب ٤٥١٢٣";
    });
    const after = structuredClone(before);
    const c = card(after, GREETING, SAY);
    if (c.type === "say" && c.message.type === "text") c.message.text = "رقم الطلب 45123";
    expect(diffDefinitions(before, after).summary.cards).toEqual({ added: 0, removed: 0, changed: 1 });
  });

  test("an Arabic node rename and an Arabic choice label", () => {
    const after = edit((def) => {
      standard(def, GREETING).name = "ترحيب";
      const c = card(def, GREETING, CAPTURE);
      if (c.type === "capture" && c.prompt.type === "choice" && c.prompt.options[0]) {
        c.prompt.options[0].label = "عربي (مصر)";
      }
    });
    const n = diffDefinitions(base, after).workflows[0]?.nodes[0];
    expect(n?.fields).toEqual([{ path: ["name"], before: "الترحيب", after: "ترحيب" }]);
    expect(n?.cards[0]?.fields).toEqual([
      { path: ["prompt", "options", 0, "label"], before: "العربية", after: "عربي (مصر)" },
    ]);
  });
});
