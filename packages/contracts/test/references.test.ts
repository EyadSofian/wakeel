import { describe, expect, test } from "vitest";
import {
  applyRefactor,
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  Card,
  countReferences,
  findUsages,
  mapWorkflowFields,
  type Node,
  nameProblem,
  newElementId,
  newId,
  renameIo,
  renameReference,
  renameVariable,
  seedBot,
  validateDefinition,
  type Workflow,
} from "../src/index";

/** Task 2.7: "Used in", delete-while-used and renames that rewrite references. */

describe("renameReference", () => {
  test.each([
    ["template", "أهلاً {{ user.email }}، بريدك {{user.email}}", "أهلاً {{ user.mail }}، بريدك {{user.mail}}"],
    // Plain text outside a placeholder is a sentence, not a reference.
    ["template", "Write to user.email or {{ user.email }}", "Write to user.email or {{ user.mail }}"],
    ["template", "{{ user.emailAddress }} {{ user?.email }}", "{{ user.emailAddress }} {{ user?.mail }}"],
    ["template", "{{ conversation.email }} {{ x.user.email }}", "{{ conversation.email }} {{ x.user.email }}"],
    ["template", "رقم {{ user.email ? 'نعم' : 'لا' }} done", "رقم {{ user.mail ? 'نعم' : 'لا' }} done"],
    ["expression", "user.email !== '' && user.email.includes('@')", "user.mail !== '' && user.mail.includes('@')"],
    ["expression", "'user.email' + user['email']", "'user.email' + user['email']"],
    [
      "code",
      "const e = user.email;\n// user.email in a comment\nuser.email = 'x';",
      "const e = user.mail;\n// user.email in a comment\nuser.mail = 'x';",
    ],
    // Text that does not parse is left as written; validation reports it.
    ["expression", "user.email +", "user.email +"],
    ["template", "{{ user.email", "{{ user.email"],
  ] as const)("%s %s", (kind, before, after) => {
    expect(renameReference(before, kind, "user", "email", "mail")).toBe(after);
  });

  test("counts references the same way", () => {
    expect(
      countReferences("{{user.email}} user.email {{ user.email + user.email }}", "template", "user", "email"),
    ).toBe(3);
    expect(countReferences("{{ user.email", "template", "user", "email")).toBe(0);
  });
});

/* A bot that uses every field kind once, in every card and message type. */

const ids = {
  name: newElementId("var"),
  status: newElementId("var"),
  found: newElementId("var"),
  sub: newElementId("wf"),
  entry: newElementId("node"),
  exit: newElementId("node"),
  cards: newElementId("node"),
  agent: newElementId("node"),
  end: newElementId("node"),
  call: newElementId("card"),
};

const kb = newId("kb");
const table = newId("tbl");

function cardsOfEveryType(ref: { t: string; e: string; c: string; v: string }): Card[] {
  const m = (message: Record<string, unknown>) => ({ type: "say", id: newElementId("card"), message });
  const body = {
    title: ref.t,
    subtitle: ref.t,
    imageUrl: ref.t,
    actions: [{ type: "postback", label: ref.t, value: ref.t }],
  };
  const raw: Record<string, unknown>[] = [
    m({ type: "text", text: ref.t }),
    m({ type: "image", url: ref.t, alt: ref.t, caption: ref.t }),
    m({ type: "file", url: ref.t, name: ref.t }),
    m({ type: "location", latitude: ref.e, longitude: ref.e, title: ref.t, address: ref.t }),
    m({ type: "choice", text: ref.t, options: [{ label: ref.t, value: "a" }] }),
    m({ type: "dropdown", text: ref.t, placeholder: ref.t, options: [{ label: ref.t, value: "a" }] }),
    m({ type: "card", ...body }),
    m({ type: "carousel", items: [body, body] }),
    m({ type: "custom", name: "x", data: ref.e }),
    {
      type: "capture",
      id: newElementId("card"),
      kind: "text",
      into: ref.v,
      prompt: { type: "text", text: ref.t },
      retryMessage: ref.t,
      extract: { schema: { type: "object", properties: {} }, instructions: ref.t },
      validate: { expression: ref.e, message: ref.t },
    },
    { type: "branch", id: newElementId("card"), branches: [{ id: newElementId("br"), label: "A", when: ref.e }] },
    {
      type: "ai_branch",
      id: newElementId("card"),
      input: ref.t,
      branches: [{ id: newElementId("br"), label: "A", description: "a" }],
    },
    { type: "set_variable", id: newElementId("card"), assignments: [{ variableId: ref.v, value: ref.e }] },
    { type: "code", id: newElementId("card"), source: ref.c },
    {
      type: "kb_search",
      id: newElementId("card"),
      kbIds: [kb],
      query: ref.t,
      into: ref.v,
      answer: { instructions: ref.t, into: ref.v },
    },
    {
      type: "table",
      id: newElementId("card"),
      tableId: table,
      operation: "insert",
      search: ref.t,
      values: { a: ref.e },
      into: ref.v,
    },
    {
      type: "call_workflow",
      id: ids.call,
      workflowId: ids.sub,
      inputs: { orderId: ref.e },
      outputs: { status: ref.v },
    },
    { type: "ai_generate", id: newElementId("card"), instructions: ref.t, input: ref.t, into: ref.v },
    {
      type: "ai_extract",
      id: newElementId("card"),
      input: ref.t,
      instructions: ref.t,
      schema: { type: "object", properties: {} },
      into: ref.v,
    },
    {
      type: "handoff",
      id: newElementId("card"),
      reason: ref.t,
      include: [ref.v],
      message: { type: "text", text: ref.t },
    },
    { type: "log", id: newElementId("card"), message: ref.t, data: ref.e },
    { type: "end", id: newElementId("card"), reason: ref.t },
  ];
  return raw.map((c) => Card.parse(c));
}

function fixture(
  ref = { t: "مرحبا {{ workflow.found }}", e: "workflow.found", c: "workflow.found = true;", v: ids.found },
): BotDefinition {
  const seeded = seedBot({ name: "متجر" });
  const main = seeded.main;
  main.variables = [{ id: ids.found, name: "found", scope: "workflow", type: "any", sensitive: false }];
  const start = main.nodes[0] as Node;
  main.nodes = [
    start,
    { id: ids.cards, name: "Cards", type: "standard", cards: cardsOfEveryType(ref) },
    {
      id: ids.agent,
      name: "Agent",
      type: "autonomous",
      instructions: ref.t,
      busyMessage: ref.t,
      model: undefined,
      tools: [
        {
          id: newElementId("tool"),
          type: "code",
          name: "go",
          description: "Go.",
          input: { type: "object", properties: {} },
          source: ref.c,
          sideEffects: true,
          timeoutMs: 1000,
        },
      ],
      variableAccess: [{ variableId: ref.v, mode: "write" }],
      exits: [],
      conversational: true,
      allowHandoff: false,
      maxIterations: 6,
      temperature: 0.3,
      messageTypes: ["text"],
    },
    { id: ids.end, name: "End", type: "end", reason: ref.t },
  ] as Node[];
  main.edges = [];
  const sub: Workflow = {
    id: ids.sub,
    name: "Lookup",
    kind: "sub",
    inputs: [{ name: "orderId", type: "string", required: true }],
    outputs: [{ name: "status", type: "string", required: true }],
    variables: [],
    nodes: [
      { id: ids.entry, name: "Entry", type: "entry" },
      { id: ids.exit, name: "Done", type: "exit", outputs: { status: "workflow.orderId" } },
    ],
    edges: [],
    layout: {},
  };
  const manifest = seeded.manifest;
  manifest.variables = [
    { id: ids.name, name: "name", scope: "user", type: "string", sensitive: false },
    { id: ids.status, name: "status", scope: "conversation", type: "string", sensitive: false },
  ];
  return BotDefinitionSchema.parse({ schemaVersion: 1, manifest, workflows: [main, sub] });
}

const main = (d: BotDefinition) => d.workflows[0] as Workflow;

describe("mapWorkflowFields", () => {
  test("visits every field validateDefinition checks", () => {
    // Point every text field at a variable that does not exist; the validator must report exactly
    // as many unknown references as the walker visited fields.
    let fields = 0;
    const def = fixture();
    const ghost = mapWorkflowFields(main(def), {
      text: (_v, kind) => {
        fields++;
        return kind === "template"
          ? "{{ workflow.ghost }}"
          : kind === "expression"
            ? "workflow.ghost"
            : "workflow.ghost;";
      },
    });
    const unknown = validateDefinition({ ...def, workflows: [ghost, def.workflows[1] as Workflow] }).filter(
      (i) => i.code === "variable_unknown" && i.workflowId === ghost.id,
    );
    expect(fields).toBeGreaterThan(50);
    expect(unknown).toHaveLength(fields);
  });

  test("visits every stored-variable id the validator checks", () => {
    let ids_ = 0;
    const def = fixture();
    const gone = newElementId("var");
    const changed = mapWorkflowFields(main(def), {
      variableId: () => {
        ids_++;
        return gone;
      },
    });
    const unknown = validateDefinition({ ...def, workflows: [changed, def.workflows[1] as Workflow] }).filter(
      (i) => i.code === "variable_id_unknown",
    );
    expect(ids_).toBe(unknown.length);
  });

  test("returns the same object when nothing changes", () => {
    const wf = main(fixture());
    expect(mapWorkflowFields(wf, { text: (v) => v, variableId: (v) => v })).toBe(wf);
  });

  test("keeps the definition schema-valid after a rewrite", () => {
    const def = fixture();
    const wf = mapWorkflowFields(main(def), {
      text: (v, kind) => renameReference(v, kind, "workflow", "found", "hit"),
    });
    expect(() => BotDefinitionSchema.parse({ ...def, workflows: [wf, def.workflows[1]] })).not.toThrow();
  });
});

describe("findUsages", () => {
  test("a workflow variable: by name in text and by id in stores", () => {
    const def = fixture();
    const usages = findUsages(def, { kind: "variable", variableId: ids.found });
    expect(usages.filter((u) => u.via === "id").length).toBe(10);
    expect(usages.filter((u) => u.via === "name").length).toBeGreaterThan(50);
    expect(usages.every((u) => u.workflowId === main(def).id)).toBe(true);
    expect(usages.find((u) => u.field === "assignments[0].variableId")?.via).toBe("id");
  });

  test("an unused variable has none", () => {
    expect(findUsages(fixture(), { kind: "variable", variableId: ids.name })).toEqual([]);
  });

  test("a bot-level variable is found in every workflow", () => {
    const def = fixture({ t: "{{ user.name }}", e: "user.name", c: "user.name;", v: ids.status });
    const usages = findUsages(def, { kind: "variable", variableId: ids.name });
    expect(usages.length).toBeGreaterThan(50);
    expect(findUsages(def, { kind: "variable", variableId: ids.status }).filter((u) => u.via === "id")).toHaveLength(
      10,
    );
  });

  test("inputs and outputs: references inside, exit mappings and callers", () => {
    const def = fixture();
    const input = findUsages(def, { kind: "input", workflowId: ids.sub, name: "orderId" });
    expect(input.map((u) => [u.workflowId === ids.sub, u.field, u.via])).toEqual([
      [true, "outputs.status", "name"],
      [false, "inputs.orderId", "mapping"],
    ]);
    const output = findUsages(def, { kind: "output", workflowId: ids.sub, name: "status" });
    expect(output.map((u) => [u.nodeId, u.cardId, u.field])).toEqual([
      [ids.exit, undefined, "outputs.status"],
      [ids.cards, ids.call, "outputs.status"],
    ]);
  });
});

describe("findUsages of a workflow (task 2.8)", () => {
  test("run workflow cards and workflow tools that call it, nothing else", () => {
    const def = fixture();
    const agent = main(def).nodes.find((n) => n.id === ids.agent);
    if (agent?.type !== "autonomous") throw new Error("no agent");
    agent.tools.push({
      id: newElementId("tool"),
      type: "workflow",
      name: "lookup",
      description: "Looks the order up.",
      workflowId: ids.sub,
    });
    const usages = findUsages(def, { kind: "workflow", workflowId: ids.sub });
    expect(usages.map((u) => [u.nodeId, u.cardId, u.field, u.via])).toEqual([
      [ids.cards, ids.call, "workflowId", "id"],
      [ids.agent, undefined, "tools[1].workflowId", "id"],
    ]);
    expect(findUsages(def, { kind: "workflow", workflowId: main(def).id })).toEqual([]);
  });
});

describe("renames", () => {
  test("renaming a workflow variable rewrites every reference and leaves zero issues behind", () => {
    const def = fixture();
    const before = validateDefinition(def).filter((i) => i.code.startsWith("variable"));
    const r = renameVariable(def, ids.found, "hit");
    if (!r) throw new Error("variable not found");
    const after = applyRefactor(def, r);
    expect(main(after).variables[0]?.name).toBe("hit");
    expect(findUsages(after, { kind: "variable", variableId: ids.found })).toHaveLength(
      findUsages(def, { kind: "variable", variableId: ids.found }).length,
    );
    expect(JSON.stringify(main(after))).not.toContain("workflow.found");
    expect(validateDefinition(after).filter((i) => i.code.startsWith("variable"))).toEqual(before);
    expect(() => BotDefinitionSchema.parse(after)).not.toThrow();
  });

  test("renaming a bot-level variable rewrites the manifest and every workflow", () => {
    const def = fixture({ t: "اسمك {{ user.name }}", e: "user.name", c: "user.name;", v: ids.status });
    const r = renameVariable(def, ids.name, "fullName");
    if (!r) throw new Error("variable not found");
    const after = applyRefactor(def, r);
    expect(after.manifest.variables.find((v) => v.id === ids.name)?.name).toBe("fullName");
    expect(JSON.stringify(after.workflows)).not.toContain("user.name");
    expect(JSON.stringify(after.workflows)).toContain("اسمك {{ user.fullName }}");
    expect(validateDefinition(after).filter((i) => i.code === "variable_unknown")).toEqual([]);
  });

  test("renaming an input rewrites its references and the callers' mappings", () => {
    const def = fixture();
    const after = applyRefactor(def, renameIo(ids.sub, "input", "orderId", "ref"));
    const sub = after.workflows[1] as Workflow;
    expect(sub.inputs[0]?.name).toBe("ref");
    expect(sub.nodes.find((n) => n.id === ids.exit)).toMatchObject({ outputs: { status: "workflow.ref" } });
    expect(JSON.stringify(main(after))).toContain('"inputs":{"ref":"workflow.found"}');
    expect(validateDefinition(after).filter((i) => i.code.startsWith("call_input"))).toEqual([]);
  });

  test("renaming an output rewrites exit mappings and the callers' mappings", () => {
    const def = fixture();
    const after = applyRefactor(def, renameIo(ids.sub, "output", "status", "state"));
    const sub = after.workflows[1] as Workflow;
    expect(sub.outputs[0]?.name).toBe("state");
    expect(sub.nodes.find((n) => n.id === ids.exit)).toMatchObject({ outputs: { state: "workflow.orderId" } });
    expect(JSON.stringify(main(after))).toContain(`"outputs":{"state":"${ids.found}"}`);
    expect(
      validateDefinition(after).filter((i) => i.code.startsWith("call_output") || i.code.startsWith("exit_output")),
    ).toEqual([]);
  });

  test("nameProblem rejects bad and taken names", () => {
    const def = fixture();
    expect(nameProblem(def, "1st", { scope: "user" })).toMatch(/start with a letter/);
    expect(nameProblem(def, "اسم", { scope: "user" })).toMatch(/letters, digits/);
    expect(nameProblem(def, "name", { scope: "user" })).toMatch(/already a user variable/);
    expect(nameProblem(def, "name", { scope: "user", exceptVariableId: ids.name })).toBeUndefined();
    expect(nameProblem(def, "name", { scope: "conversation" })).toBeUndefined();
    expect(nameProblem(def, "found", { scope: "workflow", workflowId: main(def).id })).toMatch(
      /already has a variable/,
    );
    expect(nameProblem(def, "orderId", { scope: "workflow", workflowId: ids.sub })).toMatch(/already has an input/);
  });
});
