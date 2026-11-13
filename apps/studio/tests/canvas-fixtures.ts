import type { BotManifest, Card, Edge, Node, Workflow } from "@wakeel/contracts";
import { DEFAULT_MODELS, SCHEMA_VERSION } from "@wakeel/contracts";

/**
 * Canvas drafts for the screenshot review and the performance test (task 2.4, design system §5.1
 * and §8.1). Ids are fixed so shots are deterministic; every draft parses with the contract schemas
 * (tests/canvas-fixtures.test.ts).
 */
export type CanvasFixture = "typical" | "dense-300" | "rtl" | "issues" | "issues-rtl" | "empty";

export const BOT = "bot_01m7a256m0a13warwhczsjhx9b";

const pad = (n: number) => String(n).padStart(10, "0");
const id = <P extends string>(prefix: P, n: number) => `${prefix}_${pad(n)}` as const;

/** Node width 280 plus an 80 px gap (design system §2.3). */
const COLUMN = 360;

function manifest(name: string, mainId: string, rtl: boolean): BotManifest {
  return {
    name,
    defaultLocale: rtl ? "ar" : "en",
    locales: rtl ? ["ar", "en"] : ["en", "ar"],
    settings: {
      models: { ...DEFAULT_MODELS },
      inactivityTimeoutMinutes: 1_440,
      errorMessage: "Something went wrong on our side. Please try again in a moment.",
      quotaMessage: "This assistant is temporarily unavailable.",
      coalesceWindowMs: 0,
      transcriptTokenBudget: 6_000,
      limits: { turnSeconds: 120, stepsPerTurn: 200 },
    },
    variables: [
      { id: id("var", 1), name: "orderNumber", scope: "conversation", type: "string", sensitive: false },
      { id: id("var", 2), name: "topic", scope: "conversation", type: "string", sensitive: false },
      { id: id("var", 3), name: "email", scope: "user", type: "string", sensitive: false },
    ],
    configVars: [],
    mainWorkflowId: mainId,
  };
}

const say = (n: number, text: string): Card => ({
  id: id("card", n),
  type: "say",
  disabled: false,
  message: { type: "text", text, format: "markdown" },
});

/** A store assistant: greet, ask what the customer needs, branch, and hand orders to an agent. */
function typical(rtl: boolean, broken: boolean): Workflow {
  const t = rtl
    ? {
        greet: "ترحيب",
        hello: "أهلاً بيك في متجر إنجوسوفت. أقدر أساعدك في الطلبات والشحن والاسترجاع.",
        ask: "تحب أساعدك في إيه النهارده؟",
        agent: "مساعد الطلبات",
        instructions: "ساعد العميل يتابع طلبه. اسأل عن رقم الطلب لو مش معروف، ومتوعدش بمواعيد شحن.",
        faq: "الأسئلة الشائعة",
        faqText: "مواعيد الشحن من ٢ لـ ٥ أيام عمل داخل القاهرة الكبرى.",
        human: "تحويل لموظف",
        done: "إنهاء",
      }
    : {
        greet: "Greeting",
        hello: "Welcome to Engosoft store. I can help with orders, shipping and returns.",
        ask: "What can I help you with today?",
        agent: "Order assistant",
        instructions:
          "Help the customer track an order. Ask for the order number if it is not known. Never promise delivery dates.",
        faq: "Shipping FAQ",
        faqText: "Delivery takes 2 to 5 working days inside Greater Cairo.",
        human: "Hand off to a person",
        done: "Done",
      };
  const nodes: Node[] = [
    { id: id("node", 1), name: "Start", type: "start" },
    {
      id: id("node", 2),
      name: t.greet,
      type: "standard",
      cards: [
        say(1, t.hello),
        {
          id: id("card", 2),
          type: "capture",
          disabled: false,
          prompt: { type: "text", text: t.ask, format: "markdown" },
          kind: "text",
          into: id("var", 2),
          maxRetries: 2,
          skipIfFilled: false,
          routeByOption: false,
        },
        {
          id: id("card", 3),
          type: "branch",
          disabled: false,
          branches: [
            { id: id("br", 1), label: rtl ? "طلب" : "Order", when: 'conversation.topic.includes("order")' },
            {
              id: id("br", 2),
              label: rtl ? "شحن" : "Shipping",
              when: broken ? "conversation.topic ==" : 'conversation.topic.includes("ship")',
            },
          ],
        },
      ],
    },
    {
      id: id("node", 3),
      name: t.agent,
      type: "autonomous",
      instructions: broken ? "" : t.instructions,
      tools: [],
      variableAccess: [{ variableId: id("var", 1), mode: "write" }],
      exits: [
        { id: id("exit", 1), name: "resolved", description: "The customer has what they needed." },
        { id: id("exit", 2), name: "needs_person", description: "The customer asks for a person or is upset." },
      ],
      conversational: true,
      allowHandoff: false,
      maxIterations: 6,
      temperature: 0.3,
      messageTypes: ["text", "choice"],
    },
    { id: id("node", 4), name: t.faq, type: "standard", cards: [say(4, t.faqText)] },
    {
      id: id("node", 5),
      name: t.human,
      type: "standard",
      cards: [{ id: id("card", 5), type: "handoff", disabled: false, reason: "", summary: "auto", include: [] }],
    },
    { id: id("node", 6), name: t.done, type: "end", reason: "completed" },
  ];
  const edge = (n: number, from: number, port: string, to: number): Edge => ({
    id: id("edge", n),
    from: { nodeId: id("node", from), port },
    to: { nodeId: id("node", to) },
  });
  const edges: Edge[] = [
    edge(1, 1, "next", 2),
    edge(2, 2, `card:${id("card", 3)}:branch:${id("br", 1)}`, 3),
    edge(3, 2, `card:${id("card", 3)}:branch:${id("br", 2)}`, 4),
    edge(4, 3, `exit:${id("exit", 1)}`, 6),
    edge(5, 3, `exit:${id("exit", 2)}`, 5),
    edge(6, 4, "next", 6),
  ];
  // The Shipping branch goes nowhere: a warning next to the errors above.
  const shown = broken ? edges.filter((e) => e.id !== id("edge", 3)) : edges;
  return {
    id: id("wf", 1),
    name: "Main",
    kind: "main",
    inputs: [],
    outputs: [],
    variables: [],
    nodes,
    edges: shown,
    layout: {
      [id("node", 1)]: { x: 0, y: 120 },
      [id("node", 2)]: { x: COLUMN, y: 80 },
      [id("node", 3)]: { x: COLUMN * 2, y: 0 },
      [id("node", 4)]: { x: COLUMN * 2, y: 320 },
      [id("node", 5)]: { x: COLUMN * 3, y: 160 },
      [id("node", 6)]: { x: COLUMN * 3, y: 0 },
    },
  };
}

/** 300 nodes and 450 transitions: the design system §5.1 performance budget fixture. */
function dense(): Workflow {
  const nodes: Node[] = [{ id: id("node", 0), name: "Start", type: "start" }];
  const layout: Workflow["layout"] = { [id("node", 0)]: { x: -COLUMN, y: 0 } };
  const edges: Edge[] = [];
  const cols = 20;
  for (let i = 1; i < 300; i++) {
    // Standard nodes with a branch card so each has two outputs (next + branch).
    nodes.push({
      id: id("node", i),
      name: `Step ${i}`,
      type: "standard",
      cards: [
        say(i * 2, `Message for step ${i}`),
        {
          id: id("card", i * 2 + 1),
          type: "branch",
          disabled: false,
          branches: [{ id: id("br", i), label: "Retry", when: "conversation.topic == null" }],
        },
      ],
    });
    layout[id("node", i)] = { x: ((i - 1) % cols) * COLUMN, y: Math.floor((i - 1) / cols) * 260 };
  }
  edges.push({ id: id("edge", 0), from: { nodeId: id("node", 0), port: "next" }, to: { nodeId: id("node", 1) } });
  let e = 1;
  for (let i = 1; i < 300 && edges.length < 450; i++) {
    const next = i + 1 < 300 ? i + 1 : 1;
    edges.push({
      id: id("edge", e++),
      from: { nodeId: id("node", i), port: "next" },
      to: { nodeId: id("node", next) },
    });
    if ((i % 2 === 0 || i === 299) && edges.length < 450) {
      const back = Math.max(1, i - 21);
      edges.push({
        id: id("edge", e++),
        from: { nodeId: id("node", i), port: `card:${id("card", i * 2 + 1)}:branch:${id("br", i)}` },
        to: { nodeId: id("node", back) },
      });
    }
  }
  return { id: id("wf", 1), name: "Main", kind: "main", inputs: [], outputs: [], variables: [], nodes, edges, layout };
}

function empty(): Workflow {
  return {
    id: id("wf", 1),
    name: "Main",
    kind: "main",
    inputs: [],
    outputs: [],
    variables: [],
    nodes: [{ id: id("node", 1), name: "Start", type: "start" }],
    edges: [],
    layout: { [id("node", 1)]: { x: 0, y: 0 } },
  };
}

export function canvasDraft(kind: CanvasFixture): { manifest: BotManifest; workflows: Workflow[] } {
  const rtl = kind === "rtl" || kind === "issues-rtl";
  const issues = kind === "issues" || kind === "issues-rtl";
  const main = kind === "dense-300" ? dense() : kind === "empty" ? empty() : typical(rtl, issues);
  const name = rtl ? "مساعد متجر إنجوسوفت" : kind === "dense-300" ? "Large flow" : "Store assistant";
  return { manifest: manifest(name, main.id, rtl), workflows: [main] };
}

export const DRAFT_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * The Variables screen (task 2.7): the typical bot plus every scope, defaults of several types, a
 * sensitive variable, and a sub-workflow with inputs and outputs that Main calls. `empty` has no
 * variables anywhere.
 */
export function variablesDraft(kind: "default" | "rtl" | "empty"): { manifest: BotManifest; workflows: Workflow[] } {
  const rtl = kind === "rtl";
  const base = canvasDraft(rtl ? "rtl" : "typical");
  const main = base.workflows[0] as Workflow;
  if (kind === "empty") {
    // A new bot: a lone Start node and nothing declared.
    const blank = canvasDraft("empty");
    return { manifest: { ...blank.manifest, variables: [] }, workflows: blank.workflows };
  }
  const sub: Workflow = {
    id: id("wf", 2),
    name: rtl ? "متابعة الطلب" : "Track order",
    kind: "sub",
    inputs: [{ name: "orderNumber", type: "string", required: true }],
    outputs: [
      { name: "status", type: "string", required: true },
      { name: "eta", type: "date", required: false },
    ],
    variables: [
      { id: id("var", 20), name: "attempts", scope: "workflow", type: "number", default: 0, sensitive: false },
    ],
    nodes: [
      { id: id("node", 900), name: "Entry", type: "entry" },
      {
        id: id("node", 901),
        name: rtl ? "تم" : "Done",
        type: "exit",
        outputs: { status: "workflow.orderNumber ? 'shipped' : 'unknown'" },
      },
    ],
    edges: [{ id: id("edge", 900), from: { nodeId: id("node", 900), port: "next" }, to: { nodeId: id("node", 901) } }],
    layout: { [id("node", 900)]: { x: 0, y: 0 }, [id("node", 901)]: { x: COLUMN, y: 0 } },
  };
  const mainWithCall: Workflow = {
    ...main,
    variables: [
      { id: id("var", 10), name: "answer", scope: "workflow", type: "string", sensitive: false },
      {
        id: id("var", 11),
        name: "cart",
        scope: "workflow",
        type: "object",
        default: { items: [], total: 0 },
        sensitive: false,
      },
    ],
    nodes: main.nodes.map((n) =>
      n.type === "standard" && n.id === id("node", 2)
        ? {
            ...n,
            cards: [
              ...n.cards,
              {
                id: id("card", 900),
                type: "call_workflow",
                disabled: false,
                workflowId: sub.id,
                inputs: { orderNumber: "conversation.orderNumber" },
                outputs: { status: id("var", 2) },
              },
            ],
          }
        : n,
    ),
  };
  const manifest: BotManifest = {
    ...base.manifest,
    variables: [
      ...base.manifest.variables,
      {
        id: id("var", 4),
        name: "brand",
        scope: "bot",
        type: "string",
        default: rtl ? "متجر إنجوسوفت" : "Engosoft store",
        sensitive: false,
      },
      {
        id: id("var", 5),
        name: "plan",
        scope: "user",
        type: "enum",
        enumValues: ["basic", "pro"],
        default: "basic",
        sensitive: false,
      },
      { id: id("var", 6), name: "phone", scope: "user", type: "string", sensitive: true },
    ],
  };
  return { manifest, workflows: [mainWithCall, sub] };
}

/**
 * The Workflows panel (task 2.8): the Variables draft (Main calls Track order) plus Refunds, which
 * calls Track order too and lends it to an autonomous node as a tool, and the error workflow.
 * Deleting Track order therefore warns about three places.
 */
export function workflowsDraft(rtl: boolean): { manifest: BotManifest; workflows: Workflow[] } {
  const base = variablesDraft(rtl ? "rtl" : "default");
  const track = base.workflows[1] as Workflow;
  const refunds: Workflow = {
    id: id("wf", 3),
    name: rtl ? "الاسترجاع" : "Refunds",
    kind: "sub",
    inputs: [],
    outputs: [],
    variables: [{ id: id("var", 30), name: "status", scope: "workflow", type: "string", sensitive: false }],
    nodes: [
      { id: id("node", 950), name: "Entry", type: "entry" },
      {
        id: id("node", 951),
        name: rtl ? "تحقق من الطلب" : "Check order",
        type: "standard",
        cards: [
          {
            id: id("card", 950),
            type: "call_workflow",
            disabled: false,
            workflowId: track.id,
            inputs: { orderNumber: "conversation.orderNumber" },
            outputs: { status: id("var", 30) },
          },
        ],
      },
      {
        id: id("node", 952),
        name: rtl ? "وكيل الاسترجاع" : "Refund agent",
        type: "autonomous",
        instructions: rtl ? "ساعد العميل في استرجاع طلبه." : "Help the customer return their order.",
        tools: [
          {
            id: id("tool", 950),
            type: "workflow",
            name: "trackOrder",
            description: "Looks up where an order is.",
            workflowId: track.id,
          },
        ],
        variableAccess: [],
        exits: [{ id: id("exit", 950), name: "done", description: "The refund is settled." }],
        conversational: true,
        allowHandoff: false,
        maxIterations: 6,
        temperature: 0.3,
        messageTypes: ["text"],
      },
      { id: id("node", 953), name: "Exit", type: "exit", outputs: {} },
    ],
    edges: [
      { id: id("edge", 950), from: { nodeId: id("node", 950), port: "next" }, to: { nodeId: id("node", 951) } },
      { id: id("edge", 951), from: { nodeId: id("node", 951), port: "next" }, to: { nodeId: id("node", 952) } },
      {
        id: id("edge", 952),
        from: { nodeId: id("node", 952), port: `exit:${id("exit", 950)}` },
        to: { nodeId: id("node", 953) },
      },
    ],
    layout: {
      [id("node", 950)]: { x: 0, y: 0 },
      [id("node", 951)]: { x: COLUMN, y: 0 },
      [id("node", 952)]: { x: COLUMN * 2, y: 0 },
      [id("node", 953)]: { x: COLUMN * 3, y: 0 },
    },
  };
  const errors: Workflow = {
    id: id("wf", 4),
    name: rtl ? "معالجة الأخطاء" : "When something fails",
    kind: "error",
    inputs: [],
    outputs: [],
    variables: [],
    nodes: [
      { id: id("node", 960), name: rtl ? "خطأ" : "On error", type: "error_handler" },
      { id: id("node", 961), name: rtl ? "إنهاء" : "End", type: "end", reason: "error" },
    ],
    edges: [{ id: id("edge", 960), from: { nodeId: id("node", 960), port: "next" }, to: { nodeId: id("node", 961) } }],
    layout: { [id("node", 960)]: { x: 0, y: 0 }, [id("node", 961)]: { x: COLUMN, y: 0 } },
  };
  return {
    manifest: { ...base.manifest, errorWorkflowId: errors.id },
    workflows: [...base.workflows, refunds, errors],
  };
}

/**
 * The code drawer (task 2.9): the Variables draft with a Run code card on Greeting, a workflow
 * variable `email` and a config variable, so the code and its typings name real things. The RTL
 * variant writes Arabic messages inside the code; code itself stays left to right.
 */
export function codeDraft(rtl: boolean, empty = false): { manifest: BotManifest; workflows: Workflow[] } {
  const base = variablesDraft(rtl ? "rtl" : "default");
  const main = base.workflows[0] as Workflow;
  const reply = rtl
    ? `  await say(\`طلبك رقم \${conversation.orderNumber} حالته الآن: \${order.status}\`);`
    : `  await say(\`Order \${conversation.orderNumber} is \${order.status}.\`);`;
  const source = [
    rtl ? "// ابحث عن الطلب وأخبر العميل بحالته." : "// Look the order up and tell the customer where it is.",
    `const res = await fetch(\`\${env.SHOP_URL}/orders/\${conversation.orderNumber}\`);`,
    "if (!res.ok) {",
    '  log.warn("Order lookup failed", res.status);',
    "  return;",
    "}",
    "const order = await res.json();",
    "workflow.email = user.email;",
    "if (order.status) {",
    reply,
    "}",
  ].join("\n");
  const code = empty ? "" : source;
  const withCode: Workflow = {
    ...main,
    variables: [
      ...main.variables,
      { id: id("var", 12), name: "email", scope: "workflow", type: "string", sensitive: false },
    ],
    nodes: main.nodes.map((n) =>
      n.type === "standard" && n.id === id("node", 2)
        ? {
            ...n,
            cards: [
              ...n.cards,
              { id: id("card", 950), type: "code", disabled: false, source: code, timeoutMs: 10_000 },
            ],
          }
        : n,
    ),
  };
  return {
    manifest: {
      ...base.manifest,
      configVars: [{ key: "SHOP_URL", secret: false, description: "Base URL of the shop's API." }],
    },
    workflows: [withCode, ...base.workflows.slice(1)],
  };
}
