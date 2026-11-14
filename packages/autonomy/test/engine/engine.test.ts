import { AppError, AutonomousNode, type AutonomyMemory, type BotDefinition } from "@wakeel/contracts";
import { FakeLlm, makeBotDefinition } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { type AutonomyStepInput, createAutonomy, type RunOutcome } from "../../src/engine";

/**
 * Task 6.5 (architecture §6.3): one iteration of the Autonomous Node, with the fake LLM and a
 * scripted sandbox. Acceptance: every branch of the loop; a rejected write is fed back and not applied.
 */

const NAME = "var_CustName00";
const ORDER = "var_OrderNo000";
const TIER = "var_TierLevel0";
const SECRET = "var_Internal00";
const base = makeBotDefinition({ name: "مساعد النور" });
const definition = {
  ...base,
  manifest: {
    ...base.manifest,
    variables: [
      { id: NAME, name: "name", scope: "user", type: "string", sensitive: false },
      { id: ORDER, name: "orderNumber", scope: "conversation", type: "string", sensitive: false },
      { id: TIER, name: "tier", scope: "conversation", type: "enum", enumValues: ["gold", "silver"], sensitive: false },
      { id: SECRET, name: "internalNote", scope: "conversation", type: "string", sensitive: false },
    ],
  },
} as unknown as BotDefinition;

const node = AutonomousNode.parse({
  id: "node_Assistant0",
  type: "autonomous",
  name: "Assistant",
  instructions: "Help with orders.",
  variableAccess: [
    { variableId: NAME, mode: "read" },
    { variableId: ORDER, mode: "write" },
    { variableId: TIER, mode: "write" },
  ],
  exits: [
    {
      id: "exit_Escalate00",
      name: "escalate",
      description: "Refund over the limit.",
      schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    },
  ],
  allowHandoff: true,
  maxIterations: 3,
});

const M = ":::";

function setup(replies: string[], runs: RunOutcome[] = []) {
  const llm = new FakeLlm();
  for (const r of replies) llm.scriptText(r);
  const codeCalls: { source: string; scopes: Record<string, unknown> }[] = [];
  const autonomy = createAutonomy({
    model: () => ({ stream: (r) => llm.stream({ model: "fake", ...r }) }),
    code: {
      run: async (req) => {
        codeCalls.push(req);
        const next = runs.shift();
        if (!next) throw new Error("no scripted run");
        return next;
      },
    },
    context: async () => ({
      definition,
      bot: { name: "مساعد النور" },
      env: {},
      transcript: [{ direction: "in", payload: { type: "text", text: "طلبي 5678 فين؟" } }],
      now: "2026-11-14T10:00:00.000Z",
    }),
  });
  const input = (memory?: AutonomyMemory, extra: Partial<AutonomyStepInput> = {}): AutonomyStepInput => ({
    node,
    location: { workflowId: definition.manifest.mainWorkflowId, nodeId: node.id },
    memory,
    scopes: { user: { name: "منى" }, conversation: {}, workflow: {}, turn: {} },
    turnId: "turn_01m7a256m0a13warwhczsjhx9b",
    stepSeq: 3,
    idempotencyKey: "turn_x:3",
    deadline: Date.parse("2026-11-14T10:02:00.000Z"),
    ...extra,
  });
  const lastPrompt = () => {
    const call = llm.calls.at(-1)?.request as { system: string; messages: { content: string }[] };
    return call.messages.map((m) => m.content).join("\n");
  };
  return { autonomy, input, codeCalls, lastPrompt, llm };
}

describe("one iteration", () => {
  test("say and listen: the messages go out and the node waits for the user", async () => {
    const s = setup([`${M}say text\nأهلاً يا منى، رقم الطلب كام؟\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.messages).toEqual([{ type: "text", text: "أهلاً يا منى، رقم الطلب كام؟", format: "markdown" }]);
    expect(r.outcome).toEqual({
      type: "wait",
      wait: { kind: "listen", nodeId: node.id, since: "2026-11-14T10:00:00.000Z" },
    });
    expect(r.memory).toMatchObject({ iteration: 0, feedback: [] });
    expect(s.lastPrompt()).toContain('user.name (read only) = "منى"');
  });

  test("a run that returns a value iterates with the value as feedback; an exit in the same reply is ignored", async () => {
    const s = setup(
      [`${M}run\nreturn await tools.lookupOrder({ orderNumber: "5678" })\n${M}exit escalate {"amount": 10}\n${M}end`],
      [{ ok: true, returned: true, value: { status: "shipped" }, patches: {} }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "next" });
    expect(r.exit).toBeUndefined();
    expect(r.memory).toMatchObject({ iteration: 1, feedback: [{ kind: "run_result", text: '{"status":"shipped"}' }] });
    expect(s.codeCalls[0]?.source).toBe('return await tools.lookupOrder({ orderNumber: "5678" })');
  });

  test("a run without return followed by an exit leaves through it, with its data and the accepted writes", async () => {
    const s = setup(
      [`${M}run\nconversation.orderNumber = "5678"\n${M}exit escalate {"amount": 2500}\n${M}end`],
      [{ ok: true, returned: false, patches: { conversation: { set: { orderNumber: "5678" } } } }],
    );
    const r = await s.autonomy.step(s.input({ iteration: 2, memo: {}, feedback: [] }));
    expect(r.outcome).toEqual({ type: "goto", port: "exit:exit_Escalate00" });
    expect(r.exit).toEqual({ name: "escalate", data: { amount: 2500 } });
    expect(r.writes).toEqual([{ scope: "conversation", variableId: ORDER, value: "5678" }]);
    expect(r.memory.iteration).toBe(0);
  });

  test("a rejected write is explained to the model and not applied; the accepted one is", async () => {
    const s = setup(
      [
        `${M}run\nuser.name = "x"; conversation.tier = "platinum"; conversation.internalNote = "y"; conversation.orderNumber = 5678; conversation.orderNumber = "5678"\n${M}end`,
      ],
      [
        {
          ok: true,
          returned: false,
          patches: {
            user: { set: { name: "حد تاني" } },
            conversation: { set: { tier: "platinum", internalNote: "y", orderNumber: "5678" } },
          },
        },
      ],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.writes).toEqual([{ scope: "conversation", variableId: ORDER, value: "5678" }]);
    expect(r.outcome).toEqual({ type: "next" });
    const fb = r.memory.feedback.find((f) => f.kind === "write_rejected")?.text ?? "";
    expect(fb).toContain("user.name was not changed: it is read only here.");
    expect(fb).toContain(
      'conversation.tier was not changed: it must be one of "gold", "silver", not string "platinum".',
    );
    expect(fb).toContain("conversation.internalNote was not changed: this node has no access to it.");
  });

  test("a wrongly typed write is rejected even when access allows it", async () => {
    const s = setup(
      [`${M}run\nconversation.orderNumber = 5678\n${M}end`],
      [{ ok: true, returned: false, patches: { conversation: { set: { orderNumber: 5678 } } } }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.writes).toBeUndefined();
    expect(r.memory.feedback[0]?.text).toBe(
      "conversation.orderNumber was not changed: it must be a string, not number 5678.",
    );
  });

  test("code that throws is fed back with its line, and nothing it changed is kept", async () => {
    const s = setup(
      [`${M}run\nthrow new Error("boom")\n${M}end`],
      [{ ok: false, error: { message: "boom", line: 1 } }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "next" });
    expect(r.writes).toBeUndefined();
    expect(r.memory.feedback).toEqual([
      { kind: "run_error", text: "Your code failed on line 1: boom. Nothing it changed was kept." },
    ]);
  });

  test("an invalid exit is fed back as exit_invalid; messages already sent are mentioned", async () => {
    const s = setup([`${M}say text\nلحظة\n${M}exit escalate {"amount": "كتير"}\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "next" });
    expect(r.messages).toHaveLength(1);
    expect(r.memory.feedback[0]?.kind).toBe("exit_invalid");
    expect(r.memory.feedback[0]?.text).toContain("1 message from that reply was already sent");
  });

  test("the handoff exit hands the conversation over with its reason", async () => {
    const s = setup([`${M}say text\nهحولك لزميل\n${M}exit handoff {"reason": "refund dispute"}\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "handoff", reason: "refund dispute", summary: "", variables: {} });
  });

  test("a reply with no directives is recovered as a message and listen, and flagged", async () => {
    const s = setup(["طلبك اتشحن امبارح."]);
    const r = await s.autonomy.step(s.input());
    expect(r.messages?.[0]).toMatchObject({ type: "text", text: "طلبك اتشحن امبارح." });
    expect(r.outcome).toMatchObject({ type: "wait" });
    expect(r.logs).toEqual([{ level: "warn", message: "protocol_recovered: the reply had no directives" }]);
  });
});

describe("across iterations", () => {
  test("feedback from the previous iteration is shown once, then cleared", async () => {
    const s = setup([`${M}say text\nتمام\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(
      s.input({ iteration: 1, memo: {}, feedback: [{ kind: "run_result", text: '{"status":"shipped"}' }] }),
    );
    expect(s.lastPrompt()).toContain('<data source="feedback:run_result">\n{"status":"shipped"}');
    expect(r.memory.feedback).toEqual([]);
  });

  test("the iteration limit fails the node with autonomy_loop_exceeded", async () => {
    const s = setup([]);
    await expect(s.autonomy.step(s.input({ iteration: 3, memo: {}, feedback: [] }))).rejects.toMatchObject({
      code: "autonomy_loop_exceeded",
    });
    expect(AppError).toBeDefined();
  });

  test("a user's reply after listen starts a fresh budget", async () => {
    const s = setup([`${M}say text\nتمام\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(
      s.input({ iteration: 3, memo: {}, feedback: [] }, { resume: { kind: "message", event: { text: "5678" } } }),
    );
    expect(r.outcome).toMatchObject({ type: "wait" });
  });

  test("memo and turn are the node's scratch space; an oversized memo is refused", async () => {
    const s = setup(
      [`${M}run\nmemo.step = 2; turn.lookups = 1\n${M}end`, `${M}run\nmemo.blob = big\n${M}end`],
      [
        { ok: true, returned: false, patches: { memo: { set: { step: 2 } }, turn: { set: { lookups: 1 } } } },
        { ok: true, returned: false, patches: { memo: { set: { blob: "x".repeat(20_000) } } } },
      ],
    );
    const first = await s.autonomy.step(s.input());
    expect(first.memory.memo).toEqual({ step: 2 });
    expect(first.turn).toEqual({ lookups: 1 });
    expect(s.codeCalls[0]?.scopes["memo"]).toEqual({});
    const second = await s.autonomy.step(s.input(first.memory));
    expect(second.memory.memo).toEqual({ step: 2 });
    expect(second.memory.feedback[0]?.text).toBe("memo was not changed: it would be over 16 KB.");
  });
});
