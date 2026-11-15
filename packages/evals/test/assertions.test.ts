import { Assertion, type EvalCase } from "@wakeel/contracts";
import { RTL_FIXTURES } from "@wakeel/testing";
import { expect, test } from "vitest";
import { type AssertionPorts, assertTurn, type TurnEvidence } from "../src/index";

const evidence: TurnEvidence = {
  messages: [{ type: "text", text: "أُرسلت الفاتورة ORD-٤٥١٢٣", citationTitles: ["سِياسة الإرجاع"] }],
  calls: [{ name: "lookup", input: { id: "ORD-45123", filters: { paid: true, city: "الرياض" } } }, { name: "invoice" }],
  nodeNames: ["إرسال فاتورة"],
  exits: ["listen"],
  variables: { "conversation.order": "ORD-45123" },
  handoffRequested: true,
  latencyMs: 35,
};
const ports: AssertionPorts = {
  // Test-only adapters take fixed fixtures. Production accepts patterns through a bounded port.
  matches: async ({ pattern, flags, text }) => new RegExp(pattern, flags).test(text),
  judge: async ({ rubric, replies }) => rubric === "Send the invoice" && replies.length === 1,
};

test.each([
  [
    { type: "contains", text: "ارسلت الفاتوره ord-45123" },
    { type: "contains", text: "تفاصيل الشحن" },
  ],
  [
    { type: "notContains", text: "خطأ" },
    { type: "notContains", text: "ord-45123" },
  ],
  [
    { type: "matches", pattern: "ORD-٤[٠-٩]+" },
    { type: "matches", pattern: "INV-[0-9]+" },
  ],
  [
    { type: "judge", rubric: "Send the invoice" },
    { type: "judge", rubric: "Include a phone number" },
  ],
  [
    { type: "toolCalled", name: "lookup", input: { filters: { equals: { city: "الرياض", paid: true } } } },
    { type: "toolCalled", name: "lookup", input: { id: { contains: "wrong" } } },
  ],
  [
    { type: "toolNotCalled", name: "publish" },
    { type: "toolNotCalled", name: "invoice" },
  ],
  [
    { type: "toolOrder", names: ["lookup", "invoice"] },
    { type: "toolOrder", names: ["invoice", "lookup"] },
  ],
  [
    { type: "reachedNode", node: "إرسال فاتورة" },
    { type: "reachedNode", node: "الترحيب" },
  ],
  [
    { type: "exitTaken", exit: "listen" },
    { type: "exitTaken", exit: "done" },
  ],
  [
    { type: "variable", variable: "conversation.order", is: { matches: "^ORD-[0-9]+$" } },
    { type: "variable", variable: "conversation.order", is: { exists: false } },
  ],
  [{ type: "handoffRequested" }, { type: "handoffRequested", expected: false }],
  [
    { type: "messageType", messageType: "text" },
    { type: "messageType", messageType: "choice" },
  ],
  [
    { type: "citesDocument", title: "سياسة الارجاع" },
    { type: "citesDocument", title: "الأسعار" },
  ],
  [
    { type: "maxLatencyMs", value: 35 },
    { type: "maxLatencyMs", value: 34 },
  ],
])("evaluates %j against the observed turn", async (passing, failing) => {
  const script: EvalCase = {
    name: "فاتورة ORD-45123",
    tags: ["ar-EG"],
    turns: [
      {
        user: "وين الفاتورة؟",
        newConversation: false,
        expectSilence: false,
        assert: [Assertion.parse(passing), Assertion.parse(failing)],
      },
    ],
  };
  const turn = script.turns[0];
  if (!turn) throw new Error("the fixture has no turn");
  expect((await assertTurn(turn, evidence, ports)).map((item) => item.passed)).toEqual([true, false]);
});

test.each(RTL_FIXTURES)("preserves %s when matching replies", async ({ text }) => {
  const results = await assertTurn(
    { assert: [{ type: "contains", text: text.toUpperCase() }] },
    { ...evidence, messages: [{ type: "text", text, citationTitles: [] }] },
    ports,
  );
  expect(results[0]?.passed).toBe(true);
});
