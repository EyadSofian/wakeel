import { describe, expect, test } from "vitest";
import { cardId, definition, events, harness, linearBot, message, run, state, texts, varId } from "../turn/harness";

/** Task 5.4: the Handoff card (architecture §9.4, 04-contracts/card.ts HandoffCard). */

const handoff = (extra: Record<string, unknown> = {}) => ({ id: cardId(), type: "handoff", ...extra });

describe("handoff", () => {
  test("sends its message, hands off with the rendered reason, the summary and the included variables", async () => {
    const order = varId();
    const phone = varId();
    const card = handoff({
      reason: "العميل طلب موظف بخصوص الطلب {{ conversation.order }}",
      include: [order, phone],
      message: { type: "text", text: "هحولك لزميل دلوقتي" },
    });
    const bot = linearBot([card], {
      variables: [
        { id: order, name: "order", scope: "conversation", type: "string" },
        { id: phone, name: "phone", scope: "user", type: "string" },
      ],
    });
    const requests: unknown[] = [];
    const h = harness({
      handoffSummary: async (input) => {
        requests.push(input);
        return "العميل بيسأل عن طلب متأخر";
      },
    });
    const { result, commits } = await run({
      def: bot.def,
      h,
      state: state({ conversationVars: { [order]: "5678" } }),
      user: { vars: { [phone]: "01000000000" }, attributes: {} },
    });
    expect(texts(commits)).toEqual(["هحولك لزميل دلوقتي"]);
    expect(events(commits)).toEqual([
      {
        type: "handoff.requested",
        data: {
          reason: "العميل طلب موظف بخصوص الطلب 5678",
          summary: "العميل بيسأل عن طلب متأخر",
          variables: { order: "5678", phone: "01000000000" },
        },
      },
    ]);
    expect(requests).toEqual([{ turnId: expect.any(String), reason: "العميل طلب موظف بخصوص الطلب 5678" }]);
    expect(result.status).toBe("handed_off");
    expect(result.state).toMatchObject({ status: "handed_off", stack: [] });
  });

  test("a workflow variable is included by name; an id that names no variable is skipped", async () => {
    const step = varId();
    const set = { id: cardId(), type: "set_variable", assignments: [{ variableId: step, value: "event.text" }] };
    const bot = linearBot([set, handoff({ summary: "none", include: [step, varId()] })]);
    const main = { ...bot.main, variables: [{ id: step, name: "step", scope: "workflow", type: "string" }] };
    const def = definition({ workflows: [main] });
    const { commits } = await run({ def, event: message("الدفع") });
    expect(events(commits)[0]).toMatchObject({ data: { variables: { step: "الدفع" } } });
  });

  test("summary none never asks for one", async () => {
    const bot = linearBot([handoff({ summary: "none" })]);
    let asked = false;
    const h = harness({
      handoffSummary: async () => {
        asked = true;
        return "x";
      },
    });
    const { commits } = await run({ def: bot.def, h });
    expect(asked).toBe(false);
    expect(events(commits)[0]).toMatchObject({ data: { summary: "", reason: "", variables: {} } });
  });

  test("with no summarizer configured, the summary is empty", async () => {
    const { commits } = await run({ def: linearBot([handoff()]).def });
    expect(events(commits)[0]).toMatchObject({ type: "handoff.requested", data: { summary: "" } });
  });

  test("a summarizer that fails does not stop the handoff; the failure is logged on the step", async () => {
    const h = harness({
      handoffSummary: async () => {
        throw new Error("model unavailable");
      },
    });
    const { result, commits } = await run({ def: linearBot([handoff()]).def, h });
    expect(result.status).toBe("handed_off");
    expect(events(commits)[0]).toMatchObject({ data: { summary: "" } });
    expect(commits.flatMap((c) => c.logs)).toEqual([
      { level: "warn", message: "The handoff summary could not be written: model unavailable" },
    ]);
  });

  test("a message while handed off is recorded and gets no reply", async () => {
    const bot = linearBot([handoff()]);
    const first = await run({ def: bot.def });
    const { commits, result } = await run({ def: bot.def, state: first.result.state, event: message("فين الموظف؟") });
    expect(commits).toEqual([]);
    expect(result.status).toBe("handed_off");
  });
});
