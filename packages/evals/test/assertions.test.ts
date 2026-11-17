import { Assertion, EvalCase } from "@wakeel/contracts";
import { RTL_FIXTURES } from "@wakeel/testing";
import { expect, test } from "vitest";
import { type AssertionPorts, assertTurn, GROUNDED_RUBRIC, type TurnEvidence } from "../src/index";

const evidence: TurnEvidence = {
  messages: [{ type: "text", text: "أُرسلت الفاتورة ORD-٤٥١٢٣", citationTitles: ["سِياسة الإرجاع"] }],
  calls: [{ name: "lookup", input: { id: "ORD-45123", filters: { paid: true, city: "الرياض" } } }, { name: "invoice" }],
  nodeNames: ["إرسال فاتورة"],
  exits: ["listen"],
  variables: { "conversation.order": "ORD-45123" },
  handoffRequested: true,
  latencyMs: 35,
  passages: [{ title: "سِياسة الإرجاع", text: "الإرجاع خلال ١٤ يومًا من الاستلام." }],
};
const ports: AssertionPorts = {
  // Test-only adapters take fixed fixtures. Production accepts patterns through a bounded port.
  matches: async ({ pattern, flags, text }) => new RegExp(pattern, flags).test(text),
  judge: async ({ rubric, replies }) => ({
    passed: rubric === "Send the invoice" && replies.length === 1,
    reason: `checked: ${rubric}`,
  }),
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
    critical: false,
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

test("a judge's reason becomes the assertion's detail", async () => {
  const [result] = await assertTurn({ assert: [{ type: "judge", rubric: "Send the invoice" }] }, evidence, ports);
  expect(result).toMatchObject({ passed: true, detail: "checked: Send the invoice" });
});

test("grounded asks the judge, under a fixed rubric, whether the replies stay within the passages the turn read", async () => {
  const seen: Parameters<AssertionPorts["judge"]>[0][] = [];
  const judging: AssertionPorts = {
    ...ports,
    judge: async (input) => {
      seen.push(input);
      return { passed: false, reason: "ORD-45123 is not in any passage" };
    },
  };
  const [result] = await assertTurn({ assert: [Assertion.parse({ type: "grounded" })] }, evidence, judging);
  expect(seen).toEqual([{ rubric: GROUNDED_RUBRIC, replies: evidence.messages, passages: evidence.passages }]);
  expect(result).toMatchObject({ passed: false, detail: "ORD-45123 is not in any passage" });
  // The rubric lets a reply that admits it does not know pass with no passages at all.
  expect(GROUNDED_RUBRIC).toContain("does not know");
});

test("a case is not critical unless it says so (ADR-056 G4)", () => {
  const base = { name: "سعر الكورس", turns: [{ user: "بكام؟" }] };
  expect(EvalCase.parse(base).critical).toBe(false);
  expect(EvalCase.parse({ ...base, critical: true }).critical).toBe(true);
});
