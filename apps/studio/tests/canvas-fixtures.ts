import type { BotManifest, Card, Edge, Node, Workflow } from "@wakeel/contracts";
import { DEFAULT_MODELS, SCHEMA_VERSION } from "@wakeel/contracts";

/**
 * Canvas drafts for the screenshot review and the performance test (task 2.4, design system §5.1
 * and §8.1). Ids are fixed so shots are deterministic; every draft parses with the contract schemas
 * (tests/canvas-fixtures.test.ts).
 */
export type CanvasFixture = "typical" | "dense-300" | "rtl" | "issues" | "empty";

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
  const rtl = kind === "rtl";
  const main = kind === "dense-300" ? dense() : kind === "empty" ? empty() : typical(rtl, kind === "issues");
  const name = rtl ? "مساعد متجر إنجوسوفت" : kind === "dense-300" ? "Large flow" : "Store assistant";
  return { manifest: manifest(name, main.id, rtl), workflows: [main] };
}

export const DRAFT_SCHEMA_VERSION = SCHEMA_VERSION;
