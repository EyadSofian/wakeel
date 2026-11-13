import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  type Card,
  fill,
  ISSUE_RULES,
  type IssueCode,
  type Node,
  newElementId,
  parseCodeBody,
  parseExpression,
  parseTemplate,
  seedBot,
  validateDefinition,
  type Workflow,
} from "../src/index";

/**
 * Task 2.2: one passing and one failing fixture per rule; messages and fixes come from the table.
 * `base()` builds a bot that uses every kind of reference and must produce no issue at all; each
 * case changes one thing and must produce exactly its code.
 */

const ids = {
  email: newElementId("var"),
  orderId: newElementId("var"),
  status: newElementId("var"),
  brand: newElementId("var"),
  plan: newElementId("var"),
  found: newElementId("var"),
  sub: newElementId("wf"),
  greet: newElementId("node"),
  agent: newElementId("node"),
  entry: newElementId("node"),
  lookup: newElementId("node"),
  exit: newElementId("node"),
  say: newElementId("card"),
  capture: newElementId("card"),
  branch: newElementId("card"),
  call: newElementId("card"),
  set: newElementId("card"),
  br: newElementId("br"),
  tool: newElementId("tool"),
};

function base(): BotDefinition {
  const seeded = seedBot({ name: "متجر النور" });
  const main = seeded.main;
  const start = main.nodes[0] as Node;
  const greet: Node = {
    id: ids.greet,
    name: "Greet",
    type: "standard",
    cards: [
      {
        id: ids.say,
        type: "say",
        disabled: false,
        message: {
          type: "text",
          text: "أهلاً {{ user.email }}، عندك {{ env.CRM_TOKEN ? 'حساب' : 'ضيف' }}",
          format: "markdown",
        },
      },
      {
        id: ids.capture,
        type: "capture",
        disabled: false,
        kind: "email",
        into: ids.email,
        prompt: {
          type: "choice",
          text: "اختار طريقة التواصل",
          options: [
            { label: "Email", value: "email" },
            { label: "واتساب", value: "whatsapp" },
          ],
        },
        maxRetries: 2,
        skipIfFilled: true,
        routeByOption: false,
      },
      {
        id: ids.branch,
        type: "branch",
        disabled: false,
        branches: [{ id: ids.br, label: "Has order", when: "conversation.orderId !== '' && bot.brand.length > 0" }],
      },
      {
        id: ids.call,
        type: "call_workflow",
        disabled: false,
        workflowId: ids.sub,
        inputs: { orderId: "conversation.orderId" },
        outputs: { status: ids.status },
      },
    ],
  };
  const agent = main.nodes[1] as Extract<Node, { type: "autonomous" }>;
  agent.id = ids.agent;
  agent.instructions = "ساعد العميل في متابعة طلبه {{ conversation.orderId }}.";
  agent.tools = [
    { id: ids.tool, type: "workflow", name: "lookupOrder", description: "Find an order by id.", workflowId: ids.sub },
  ];
  main.nodes = [start, greet, agent];
  main.edges = [
    { id: newElementId("edge"), from: { nodeId: start.id, port: "next" }, to: { nodeId: ids.greet } },
    {
      id: newElementId("edge"),
      from: { nodeId: ids.greet, port: `card:${ids.branch}:branch:${ids.br}` },
      to: { nodeId: ids.agent },
    },
    { id: newElementId("edge"), from: { nodeId: ids.greet, port: "next" }, to: { nodeId: ids.agent } },
  ];
  main.layout = {};

  const sub: Workflow = {
    id: ids.sub,
    name: "Lookup order",
    kind: "sub",
    inputs: [{ name: "orderId", type: "string", required: true }],
    outputs: [{ name: "status", type: "string", required: true }],
    variables: [{ id: ids.found, name: "found", scope: "workflow", type: "boolean", sensitive: false }],
    nodes: [
      { id: ids.entry, name: "Entry", type: "entry" },
      {
        id: ids.lookup,
        name: "Lookup",
        type: "standard",
        cards: [
          {
            id: ids.set,
            type: "set_variable",
            disabled: false,
            assignments: [{ variableId: ids.found, value: "workflow.orderId.length > 0" }],
          },
        ],
      },
      { id: ids.exit, name: "Done", type: "exit", outputs: { status: "workflow.found ? 'shipped' : 'unknown'" } },
    ],
    edges: [
      { id: newElementId("edge"), from: { nodeId: ids.entry, port: "next" }, to: { nodeId: ids.lookup } },
      { id: newElementId("edge"), from: { nodeId: ids.lookup, port: "next" }, to: { nodeId: ids.exit } },
    ],
    layout: {},
  };

  const manifest = seeded.manifest;
  manifest.variables = [
    { id: ids.email, name: "email", scope: "user", type: "string", sensitive: false },
    { id: ids.orderId, name: "orderId", scope: "conversation", type: "string", sensitive: false },
    { id: ids.status, name: "status", scope: "conversation", type: "string", sensitive: false },
    { id: ids.brand, name: "brand", scope: "bot", type: "string", sensitive: false },
    { id: ids.plan, name: "plan", scope: "conversation", type: "enum", enumValues: ["basic", "pro"], sensitive: false },
  ];
  manifest.configVars = [{ key: "CRM_TOKEN", secret: true }];
  return BotDefinitionSchema.parse({ schemaVersion: 1, manifest, workflows: [main, sub] });
}

const mainOf = (d: BotDefinition) => d.workflows[0] as Workflow;
const subOf = (d: BotDefinition) => d.workflows[1] as Workflow;
const nodeOf = (w: Workflow, id: string) => w.nodes.find((n) => n.id === id) as Node;
const greetOf = (d: BotDefinition) => nodeOf(mainOf(d), ids.greet) as Extract<Node, { type: "standard" }>;
const agentOf = (d: BotDefinition) => nodeOf(mainOf(d), ids.agent) as Extract<Node, { type: "autonomous" }>;
const cardOf = <T extends Card["type"]>(d: BotDefinition, id: string) =>
  greetOf(d).cards.find((c) => c.id === id) as Extract<Card, { type: T }>;

/** One failing fixture per code. Each mutates a fresh valid definition. */
const CASES: Record<IssueCode, (d: BotDefinition) => void> = {
  main_workflow_count: (d) => {
    subOf(d).kind = "main";
  },
  main_workflow_missing: (d) => {
    d.manifest.mainWorkflowId = ids.sub;
  },
  error_workflow_count: (d) => {
    const e1 = {
      ...structuredClone(subOf(d)),
      id: newElementId("wf"),
      kind: "error" as const,
      inputs: [],
      outputs: [],
    };
    const e2 = { ...structuredClone(e1), id: newElementId("wf") };
    for (const e of [e1, e2]) {
      e.nodes = [{ id: newElementId("node"), name: "Handler", type: "error_handler" }];
      e.edges = [];
      e.variables = [];
    }
    d.workflows.push(e1, e2);
  },
  error_workflow_missing: (d) => {
    d.manifest.errorWorkflowId = ids.sub;
  },
  duplicate_id: (d) => {
    cardOf<"say">(d, ids.capture).id = ids.say;
  },
  variable_name_duplicate: (d) => {
    d.manifest.variables.push({
      id: newElementId("var"),
      name: "email",
      scope: "user",
      type: "string",
      sensitive: false,
    });
  },
  variable_scope: (d) => {
    d.manifest.variables.push({
      id: newElementId("var"),
      name: "temp",
      scope: "workflow",
      type: "string",
      sensitive: false,
    });
  },
  start_node_count: (d) => {
    mainOf(d).nodes.push({ id: newElementId("node"), name: "Start again", type: "start" });
  },
  start_outside_main: (d) => {
    subOf(d).nodes.push({ id: newElementId("node"), name: "Start", type: "start" });
  },
  entry_node_count: (d) => {
    subOf(d).nodes.push({ id: newElementId("node"), name: "Entry 2", type: "entry" });
  },
  exit_node_missing: (d) => {
    const s = subOf(d);
    s.nodes = s.nodes.filter((n) => n.type !== "exit");
    s.edges = s.edges.filter((e) => e.to.nodeId !== ids.exit);
  },
  error_handler_count: (d) => {
    mainOf(d).nodes.push(
      { id: newElementId("node"), name: "Errors", type: "error_handler" },
      { id: newElementId("node"), name: "More errors", type: "error_handler" },
    );
  },
  edge_source_missing: (d) => {
    mainOf(d).edges.push({
      id: newElementId("edge"),
      from: { nodeId: newElementId("node"), port: "next" },
      to: { nodeId: ids.agent },
    });
  },
  edge_target_missing: (d) => {
    mainOf(d).edges.push({
      id: newElementId("edge"),
      from: { nodeId: ids.agent, port: "error" },
      to: { nodeId: newElementId("node") },
    });
  },
  edge_port_missing: (d) => {
    mainOf(d).edges.push({
      id: newElementId("edge"),
      from: { nodeId: ids.agent, port: `exit:${newElementId("exit")}` },
      to: { nodeId: ids.greet },
    });
  },
  edge_target_invalid: (d) => {
    const start = mainOf(d).nodes[0] as Node;
    mainOf(d).edges.push({
      id: newElementId("edge"),
      from: { nodeId: ids.agent, port: "error" },
      to: { nodeId: start.id },
    });
  },
  edge_duplicate: (d) => {
    mainOf(d).edges.push({
      id: newElementId("edge"),
      from: { nodeId: ids.greet, port: "next" },
      to: { nodeId: ids.agent },
    });
  },
  exit_unconnected: (d) => {
    agentOf(d).exits.push({ id: newElementId("exit"), name: "done", description: "The order is found." });
  },
  tool_name_duplicate: (d) => {
    agentOf(d).tools.push({
      id: newElementId("tool"),
      type: "workflow",
      name: "lookupOrder",
      description: "Again.",
      workflowId: ids.sub,
    });
  },
  autonomous_no_exit: (d) => {
    agentOf(d).conversational = false;
  },
  routing_port_unconnected: (d) => {
    mainOf(d).edges = mainOf(d).edges.filter((e) => !e.from.port.includes(":branch:"));
  },
  card_unreachable: (d) => {
    greetOf(d).cards.splice(1, 0, { id: newElementId("card"), type: "end", disabled: false, reason: "completed" });
  },
  variable_unknown: (d) => {
    const say = cardOf<"say">(d, ids.say);
    if (say.message.type === "text") say.message.text = "مرحبا {{ user.phone }}";
  },
  variable_id_unknown: (d) => {
    cardOf<"capture">(d, ids.capture).into = newElementId("var");
  },
  variable_type_mismatch: (d) => {
    const capture = cardOf<"capture">(d, ids.capture);
    capture.kind = "number";
  },
  variable_read_only: (d) => {
    cardOf<"capture">(d, ids.capture).into = ids.brand;
  },
  config_var_unknown: (d) => {
    const say = cardOf<"say">(d, ids.say);
    if (say.message.type === "text") say.message.text = "{{ env.MISSING_KEY }}";
  },
  choice_text_empty: (d) => {
    const capture = cardOf<"capture">(d, ids.capture);
    if (capture.prompt.type === "choice") capture.prompt.text = "   ";
  },
  choice_option_empty: (d) => {
    const capture = cardOf<"capture">(d, ids.capture);
    if (capture.prompt.type === "choice") (capture.prompt.options[0] as { label: string }).label = " ";
  },
  choice_value_duplicate: (d) => {
    const capture = cardOf<"capture">(d, ids.capture);
    if (capture.prompt.type === "choice") (capture.prompt.options[1] as { value: string }).value = "email";
  },
  autonomous_instructions_empty: (d) => {
    agentOf(d).instructions = "  ";
  },
  workflow_unknown: (d) => {
    cardOf<"call_workflow">(d, ids.call).workflowId = newElementId("wf");
  },
  workflow_not_callable: (d) => {
    cardOf<"call_workflow">(d, ids.call).workflowId = mainOf(d).id;
  },
  call_input_missing: (d) => {
    cardOf<"call_workflow">(d, ids.call).inputs = {};
  },
  call_input_unknown: (d) => {
    cardOf<"call_workflow">(d, ids.call).inputs["extra"] = "1";
  },
  call_output_unknown: (d) => {
    cardOf<"call_workflow">(d, ids.call).outputs = { status: ids.status, eta: ids.orderId };
  },
  exit_output_unknown: (d) => {
    (nodeOf(subOf(d), ids.exit) as Extract<Node, { type: "exit" }>).outputs["eta"] = "'tomorrow'";
  },
  exit_output_missing: (d) => {
    (nodeOf(subOf(d), ids.exit) as Extract<Node, { type: "exit" }>).outputs = {};
  },
  kb_unknown: (d) => {
    greetOf(d).cards.push({
      id: newElementId("card"),
      type: "kb_search",
      disabled: false,
      kbIds: ["kb_01m7a256m0a13warwhczsjhx9g"],
      query: "{{ conversation.orderId }}",
      topK: 5,
    });
  },
  table_unknown: (d) => {
    greetOf(d).cards.push({
      id: newElementId("card"),
      type: "table",
      disabled: false,
      tableId: "tbl_01m7a256m0a13warwhczsjhx9g",
      operation: "insert",
      sort: [],
      limit: 10,
      values: { id: "conversation.orderId" },
    });
  },
  template_syntax: (d) => {
    const say = cardOf<"say">(d, ids.say);
    if (say.message.type === "text") say.message.text = "مرحبا {{ user.email";
  },
  expression_syntax: (d) => {
    (cardOf<"branch">(d, ids.branch).branches[0] as { when: string }).when = "conversation.orderId ===";
  },
  code_syntax: (d) => {
    greetOf(d).cards.push({
      id: newElementId("card"),
      type: "code",
      disabled: false,
      source: "const a = 1;\nreturn a +;\n",
      timeoutMs: 1000,
    });
  },
};

/** KB and table ids the Studio knows about; empty here, so references to any are unknown. */
const CTX = { knowledgeBaseIds: new Set<string>(), tableIds: new Set<string>() };

describe("validateDefinition", () => {
  test("the passing fixture has no issues at all", () => {
    expect(validateDefinition(base(), CTX)).toEqual([]);
  });

  test("a freshly seeded bot only asks for the Autonomous node's instructions", () => {
    const s = seedBot({ name: "New" });
    const issues = validateDefinition(
      BotDefinitionSchema.parse({ schemaVersion: 1, manifest: s.manifest, workflows: [s.main] }),
    );
    expect(issues.map((i) => i.code)).toEqual(["autonomous_instructions_empty"]);
  });

  test("every rule in the table has a failing fixture", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(ISSUE_RULES).sort());
  });

  test.each(Object.entries(CASES) as [IssueCode, (d: BotDefinition) => void][])("%s", (code, mutate) => {
    const d = base();
    mutate(d);
    const issues = validateDefinition(d, CTX);
    const mine = issues.filter((i) => i.code === code);
    expect(mine.length, JSON.stringify(issues.map((i) => i.code))).toBeGreaterThan(0);
    const issue = mine[0];
    if (!issue) return;
    const rule = ISSUE_RULES[code];
    expect(issue.severity).toBe(rule.severity);
    // The fix comes from the table; the message is the table's sentence with its names filled in.
    const fixPattern = new RegExp(`^${rule.fix.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{\w+\\?\}/g, ".+")}$`);
    expect(issue.fix).toMatch(fixPattern);
    const messagePattern = new RegExp(
      `^${rule.message.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{\w+\\?\}/g, ".+")}$`,
      "s",
    );
    expect(issue.message).toMatch(messagePattern);
    expect(issue.path.length).toBeGreaterThan(0);
  });

  test("issues point at the element: workflow, node and card ids", () => {
    const d = base();
    CASES.variable_unknown(d);
    const [issue] = validateDefinition(d, CTX).filter((i) => i.code === "variable_unknown");
    expect(issue).toMatchObject({ workflowId: mainOf(d).id, nodeId: ids.greet, cardId: ids.say });
    expect(issue?.message).toBe('"user.phone" in "Greet" is not a variable in this scope.');
    expect(issue?.path).toBe(`workflows.${mainOf(d).id}.nodes.${ids.greet}.cards.${ids.say}.message.text`);
  });

  test("without a context, references to knowledge bases and tables are not checked", () => {
    const d = base();
    CASES.kb_unknown(d);
    CASES.table_unknown(d);
    expect(validateDefinition(d).filter((i) => i.code === "kb_unknown" || i.code === "table_unknown")).toEqual([]);
  });

  test("an unknown variable inside a disabled card is still reported", () => {
    const d = base();
    CASES.variable_unknown(d);
    cardOf<"say">(d, ids.say).disabled = true;
    expect(validateDefinition(d, CTX).map((i) => i.code)).toContain("variable_unknown");
  });

  test("warnings do not hide errors and are reported with them", () => {
    const d = base();
    CASES.routing_port_unconnected(d);
    CASES.autonomous_instructions_empty(d);
    const severities = validateDefinition(d, CTX)
      .map((i) => i.severity)
      .sort();
    expect(severities).toEqual(["error", "warning"]);
  });
});

describe("parsing", () => {
  test.each([
    ["a path", "workflow.email", ["workflow.email"]],
    [
      "optional chaining and calls",
      "user.profile?.name?.trim() ?? conversation.fallback",
      ["user.profile", "conversation.fallback"],
    ],
    ["computed access is not a reference", "user['email']", []],
    ["Arabic strings", "conversation.city === 'القاهرة'", ["conversation.city"]],
    ["built-ins are not checked", "event.text.length > 0 && turn.index < 3", []],
    ["env", "env.CRM_TOKEN", ["env.CRM_TOKEN"]],
  ])("expression: %s", (_n, src, refs) => {
    const r = parseExpression(src);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refs.map((x) => `${x.root}.${x.name}`)).toEqual(refs);
  });

  test.each(["", "a +", "a; b", "a b", "() =>", "{"])("expression %j is refused", (src) => {
    expect(parseExpression(src).ok).toBe(false);
  });

  test.each([
    ["no placeholders", "مرحبا بك", true],
    ["two placeholders", "{{ user.name }} طلبك {{ conversation.orderId }}", true],
    ["unclosed", "مرحبا {{ user.name", false],
    ["stray close", "مرحبا }} user", false],
    ["empty placeholder", "{{ }}", false],
    ["nested", "{{ a {{ b }} }}", false],
    ["broken expression", "{{ user. }}", false],
    ["a URL with braces in a string", "{{ 'https://x.test/?q=' + conversation.q }}", true],
  ])("template: %s", (_n, text, ok) => {
    expect(parseTemplate(text).ok).toBe(ok);
  });

  test("code: reports the builder's line", () => {
    const r = parseCodeBody("const a = 1;\nconst b = ;\nreturn a;");
    expect(r).toMatchObject({ ok: false, line: 2 });
    expect(parseCodeBody("const res = await fetch(env.URL);\nreturn res.status;").ok).toBe(true);
  });
});

describe("runs in a browser worker", () => {
  test("the validate module imports nothing from Node and uses no Node globals", () => {
    const dir = fileURLToPath(new URL("../src/validate/", import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      expect(src, file).not.toMatch(/from "node:|require\(|\bprocess\.|\bBuffer\b/);
    }
  });

  test("validation never evaluates builder text", () => {
    const d = base();
    const say = cardOf<"say">(d, ids.say);
    // If this were evaluated it would throw; parsing alone accepts it.
    if (say.message.type === "text") say.message.text = "{{ (() => { throw new Error('evaluated') })() }}";
    expect(() => validateDefinition(d, CTX)).not.toThrow();
  });
});

void fill;
