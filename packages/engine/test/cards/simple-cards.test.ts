import { RTL_FIXTURES } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import {
  cardId,
  definition,
  edge,
  events,
  harness,
  linearBot,
  nodeId,
  run,
  standard,
  state,
  texts,
  varId,
  workflow,
} from "../turn/harness";

/** Say, Branch, Set variable, Log, End and Set timeout, run by the engine's own executors (4.3). */

const say = (message: unknown) => ({ id: cardId(), type: "say", message });

describe("say", () => {
  test("a template of paths renders without the sandbox", async () => {
    const name = varId();
    const bot = linearBot([say({ type: "text", text: "أهلاً {{ user.name }}، طلبك {{ event.text }}" })], {
      variables: [{ id: name, name: "name", scope: "user", type: "string" }],
    });
    const { commits, batches } = await run({ def: bot.def, user: { vars: { [name]: "منى" }, attributes: {} } });
    expect(commits[0]?.messages).toEqual([{ type: "text", text: "أهلاً منى، طلبك مرحبا", format: "markdown" }]);
    expect(batches).toEqual([]);
  });

  test("every field of a card is filled in with one sandbox call", async () => {
    const bot = linearBot([
      say({
        type: "card",
        title: "طلب {{ env.ORDER }}",
        subtitle: "الإجمالي {{ env.TOTAL * 2 }} جنيه",
        imageUrl: "https://cdn.example.com/{{ env.ORDER }}.png",
        actions: [{ type: "postback", label: "تتبع {{ env.ORDER.toLowerCase() }}", value: "track" }],
      }),
    ]);
    const h = harness({
      sandboxAnswers: {
        "env.TOTAL * 2": { ok: true, value: 300 },
        "env.ORDER.toLowerCase()": { ok: true, value: "ord-1" },
      },
    });
    const { commits } = await run({ def: bot.def, h, env: { ORDER: "ORD-1", TOTAL: 150 } });
    expect(commits[0]?.messages).toEqual([
      {
        type: "card",
        title: "طلب ORD-1",
        subtitle: "الإجمالي 300 جنيه",
        imageUrl: "https://cdn.example.com/ORD-1.png",
        actions: [{ type: "postback", label: "تتبع ord-1", value: "track" }],
      },
    ]);
    expect(h.batches).toHaveLength(1);
  });

  test("location coordinates and custom data are expressions", async () => {
    const bot = linearBot([
      say({ type: "location", latitude: "env.LAT", longitude: "env.LNG", title: "فرع {{ env.BRANCH }}" }),
      say({ type: "custom", name: "order_summary", data: "env.SUMMARY" }),
    ]);
    const { commits } = await run({
      def: bot.def,
      env: { LAT: 30.0444, LNG: 31.2357, BRANCH: "المعادي", SUMMARY: { items: 2 } },
    });
    expect(commits.flatMap((c) => c.messages)).toEqual([
      { type: "location", latitude: 30.0444, longitude: 31.2357, title: "فرع المعادي" },
      { type: "custom", name: "order_summary", data: { items: 2 } },
    ]);
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f.text] as const))("%s is sent unchanged", async (_id, text) => {
    const bot = linearBot([say({ type: "text", text: "{{ env.TEXT }}" })]);
    const { commits } = await run({ def: bot.def, env: { TEXT: text } });
    expect(texts(commits)).toEqual([text]);
  });

  test("a placeholder that fails is template_error", async () => {
    const bot = linearBot([say({ type: "text", text: "{{ env.MISSING.trim() }}" })]);
    const { result } = await run({ def: bot.def });
    expect(result.error?.code).toBe("template_error");
  });

  test("a message that renders empty is message_invalid", async () => {
    const bot = linearBot([say({ type: "text", text: "{{ env.EMPTY }}" })]);
    const { result } = await run({ def: bot.def, env: { EMPTY: "" } });
    expect(result.error?.code).toBe("message_invalid");
    expect(result.error?.message).toMatch(/^The message could not be sent because text/);
  });

  test("an image URL that is not http is message_invalid", async () => {
    const bot = linearBot([say({ type: "image", url: "{{ env.URL }}" })]);
    const { result } = await run({ def: bot.def, env: { URL: "javascript:alert(1)" } });
    expect(result.error?.code).toBe("message_invalid");
  });

  test("a location expression that fails is expression_error", async () => {
    const bot = linearBot([say({ type: "location", latitude: "env.LAT.x.y", longitude: "1" })]);
    const { result } = await run({ def: bot.def });
    expect(result.error?.code).toBe("expression_error");
  });
});

describe("branch", () => {
  function branchBot(whens: string[]) {
    const branch = cardId();
    const after = cardId();
    const start = nodeId();
    const node = nodeId();
    const branches = whens.map((when, i) => ({ id: `br_BRANCH000${i}`, label: `B${i}`, when }));
    const targets = branches.map(() => nodeId());
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        standard(node, [
          { id: branch, type: "branch", branches },
          { id: after, type: "log", message: "none" },
        ]),
        ...targets.map((t, i) => standard(t, [{ id: cardId(), type: "log", message: `B${i}` }])),
      ],
      edges: [
        edge(start, "next", node),
        ...branches.map((b, i) => edge(node, `card:${branch}:branch:${b.id}`, targets[i] as string)),
      ],
    });
    return definition({ workflows: [main] });
  }
  const logged = (commits: { logs: { message: string }[] }[]) => commits.flatMap((c) => c.logs.map((l) => l.message));

  test("the first true branch is followed", async () => {
    const { commits } = await run({
      def: branchBot(["env.VIP", "env.NEW", "env.ANY"]),
      env: { VIP: false, NEW: true, ANY: true },
    });
    expect(logged(commits)).toEqual(["B1"]);
  });

  test("when none is true, the next card runs", async () => {
    const { commits } = await run({ def: branchBot(["env.VIP"]), env: { VIP: false } });
    expect(logged(commits)).toEqual(["none"]);
  });

  test("computed conditions share one sandbox call", async () => {
    const h = harness({
      sandboxAnswers: { "env.N > 5": { ok: true, value: false }, "env.N > 1": { ok: true, value: true } },
    });
    const { commits } = await run({ def: branchBot(["env.N > 5", "env.N > 1"]), h, env: { N: 3 } });
    expect(logged(commits)).toEqual(["B1"]);
    expect(h.batches.map((b) => b.expressions)).toEqual([["env.N > 5", "env.N > 1"]]);
  });

  test("a condition that is not a boolean is expression_error", async () => {
    const { result } = await run({ def: branchBot(["env.NAME"]), env: { NAME: "منى" } });
    expect(result.error?.code).toBe("expression_error");
    expect(result.error?.message).toBe(
      "An expression failed: env.NAME gave a string; a condition must be true or false",
    );
  });

  test("a condition that throws is expression_error", async () => {
    const { result } = await run({ def: branchBot(["env.A.b"]) });
    expect(result.error?.code).toBe("expression_error");
  });
});

describe("set_variable", () => {
  test("assigns to each scope, computing what is not a path in one sandbox call", async () => {
    const ids = { w: varId(), c: varId(), u: varId() };
    const start = nodeId();
    const node = nodeId();
    const after = cardId();
    const main = workflow({
      variables: [{ id: ids.w, name: "total", scope: "workflow", type: "number" }],
      nodes: [
        { id: start, type: "start", name: "Start" },
        standard(node, [
          {
            id: cardId(),
            type: "set_variable",
            assignments: [
              { variableId: ids.w, value: "env.PRICE * env.QTY" },
              { variableId: ids.c, value: "event.text" },
              { variableId: ids.u, value: "env.TIER" },
            ],
          },
          { id: after, type: "log", message: "{{ workflow.total }}" },
        ]),
      ],
      edges: [edge(start, "next", node)],
    });
    const def = definition({
      workflows: [main],
      variables: [
        { id: ids.c, name: "lastText", scope: "conversation", type: "string" },
        { id: ids.u, name: "tier", scope: "user", type: "enum", enumValues: ["basic", "gold"] },
      ],
    });
    const h = harness({ sandboxAnswers: { "env.PRICE * env.QTY": { ok: true, value: 300 } } });
    const { result, commits } = await run({ def, h, env: { PRICE: 150, QTY: 2, TIER: "gold" } });
    expect(h.batches).toHaveLength(1);
    expect(commits.flatMap((c) => c.logs.map((l) => l.message))).toEqual(["300"]);
    expect(result.state.conversationVars).toEqual({ [ids.c]: "مرحبا" });
    expect(commits[0]?.user).toEqual({ vars: { [ids.u]: "gold" } });
  });

  test("an expression that gives undefined clears the variable", async () => {
    const v = varId();
    const bot = linearBot(
      [{ id: cardId(), type: "set_variable", assignments: [{ variableId: v, value: "env.NOPE" }] }],
      {
        variables: [{ id: v, name: "x", scope: "conversation", type: "string" }],
      },
    );
    const { result } = await run({ def: bot.def, state: state({ conversationVars: { [v]: "old" } }) });
    expect(result.state.conversationVars).toEqual({ [v]: null });
  });

  test.each([
    ["a value of the wrong type", "string", "env.N", "variable_type_mismatch"],
    ["a bot variable", "bot", "env.N", "write_not_allowed"],
    ["an expression that fails", "string", "env.N.x.y", "expression_error"],
  ])("%s fails the step", async (_name, kind, value, code) => {
    const v = varId();
    const variable =
      kind === "bot"
        ? { id: v, name: "brand", scope: "bot", type: "string" }
        : { id: v, name: "x", scope: "conversation", type: "string" };
    const bot = linearBot([{ id: cardId(), type: "set_variable", assignments: [{ variableId: v, value }] }], {
      variables: [variable],
    });
    const { result } = await run({ def: bot.def, env: { N: 5 } });
    expect(result.error?.code).toBe(code);
  });

  test("an unknown variable is variable_not_found", async () => {
    const bot = linearBot([
      { id: cardId(), type: "set_variable", assignments: [{ variableId: "var_GONEGONE00", value: "1" }] },
    ]);
    const { result } = await run({ def: bot.def });
    expect(result.error?.code).toBe("variable_not_found");
  });
});

describe("log", () => {
  test("writes a rendered line with its level and data", async () => {
    const bot = linearBot([
      { id: cardId(), type: "log", level: "warn", message: "طلب {{ env.ORDER }} متأخر", data: "env.DETAILS" },
      { id: cardId(), type: "log", message: "done" },
    ]);
    const { commits } = await run({ def: bot.def, env: { ORDER: "ORD-1", DETAILS: { days: 3 } } });
    expect(commits.flatMap((c) => c.logs)).toEqual([
      { level: "warn", message: "طلب ORD-1 متأخر", data: { days: 3 } },
      { level: "info", message: "done" },
    ]);
    expect(texts(commits)).toEqual([]);
  });

  test("a data expression that fails is expression_error", async () => {
    const bot = linearBot([{ id: cardId(), type: "log", message: "x", data: "env.A.b" }]);
    const { result } = await run({ def: bot.def });
    expect(result.error?.code).toBe("expression_error");
  });
});

describe("end", () => {
  test("ends with its rendered reason", async () => {
    const bot = linearBot([{ id: cardId(), type: "end", reason: "{{ env.WHY }}" }]);
    const { result, commits } = await run({ def: bot.def, env: { WHY: "manual" } });
    expect(events(commits)).toEqual([{ type: "conversation.ended", data: { reason: "manual" } }]);
    expect(result.status).toBe("ended");
  });

  test("its default reason is completed", async () => {
    const bot = linearBot([{ id: cardId(), type: "end" }]);
    const { commits } = await run({ def: bot.def });
    expect(events(commits)).toEqual([{ type: "conversation.ended", data: { reason: "completed" } }]);
  });

  test("a reason that fails to render is template_error", async () => {
    const bot = linearBot([{ id: cardId(), type: "end", reason: "{{ env.X.y }}" }]);
    const { result } = await run({ def: bot.def });
    expect(result.error?.code).toBe("template_error");
  });
});

describe("set_timeout", () => {
  test.each([0, 30, 43_200])("sets the conversation's inactivity timeout to %i minutes", async (minutes) => {
    const bot = linearBot([{ id: cardId(), type: "set_timeout", minutes }]);
    const { result, commits } = await run({ def: bot.def });
    expect(result.state.inactivityTimeoutMinutes).toBe(minutes);
    expect(commits[0]?.state.inactivityTimeoutMinutes).toBe(minutes);
  });
});
