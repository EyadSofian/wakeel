import { describe, expect, test } from "vitest";
import { type ExpressionScopes, parsePath, resolvePath } from "../../src/expr/index";

describe("parsePath", () => {
  test.each([
    ["workflow.email", { root: "workflow", steps: [{ key: "email", optional: false }] }],
    [
      "user.attributes.plan",
      {
        root: "user",
        steps: [
          { key: "attributes", optional: false },
          { key: "plan", optional: false },
        ],
      },
    ],
    ["workflow", { root: "workflow", steps: [] }],
    [
      "user?.attributes?.plan",
      {
        root: "user",
        steps: [
          { key: "attributes", optional: true },
          { key: "plan", optional: true },
        ],
      },
    ],
    [
      "workflow.items[0].name",
      {
        root: "workflow",
        steps: [
          { key: "items", optional: false },
          { key: 0, optional: false },
          { key: "name", optional: false },
        ],
      },
    ],
    [
      "workflow.items?.[12]",
      {
        root: "workflow",
        steps: [
          { key: "items", optional: false },
          { key: 12, optional: true },
        ],
      },
    ],
    [
      `event.payload["order id"]['x-y']`,
      {
        root: "event",
        steps: [
          { key: "payload", optional: false },
          { key: "order id", optional: false },
          { key: "x-y", optional: false },
        ],
      },
    ],
    ["  conversation . topic  ", { root: "conversation", steps: [{ key: "topic", optional: false }] }],
    ["env.API_BASE", { root: "env", steps: [{ key: "API_BASE", optional: false }] }],
    ["turn.$tmp_1", { root: "turn", steps: [{ key: "$tmp_1", optional: false }] }],
    ["bot.class", { root: "bot", steps: [{ key: "class", optional: false }] }],
    [`workflow["الاسم"]`, { root: "workflow", steps: [{ key: "الاسم", optional: false }] }],
    ["workflow.الاسم", { root: "workflow", steps: [{ key: "الاسم", optional: false }] }],
  ])("%s is a path", (source, expected) => {
    expect(parsePath(source)).toEqual(expected);
  });

  test.each([
    "workflow.count + 1",
    "workflow.name.toUpperCase()",
    "workflow[workflow.key]",
    "workflow.items[01]",
    "workflow.items[-1]",
    "workflow.items[1.5]",
    `workflow["a\\"b"]`,
    "workflow.a /* note */",
    "(workflow.a)",
    "workflow.a = 1",
    "!workflow.ok",
    "workflow.",
    "workflow..a",
    "workflow?.",
    "workflow.a?.5",
    "Math.max",
    "this.x",
    "globalThis.process",
    "constructor.name",
    "a",
    "",
    "workflow\\u002eemail",
  ])("%s is not a path", (source) => {
    expect(parsePath(source)).toBeNull();
  });
});

describe("resolvePath", () => {
  const scopes: ExpressionScopes = {
    workflow: {
      email: "sara@example.com",
      count: 3,
      empty: null,
      items: [{ name: "first" }, { name: "second" }],
      greeting: "مرحبا",
      nested: { deep: { value: true } },
    },
    user: { attributes: { plan: "pro" } },
    event: { payload: { "order id": "ORD-1" } },
  };

  const resolveSource = (source: string) => {
    const path = parsePath(source);
    if (!path) throw new Error(`not a path: ${source}`);
    return resolvePath(path, scopes);
  };

  test.each([
    ["workflow.email", "sara@example.com"],
    ["user.attributes.plan", "pro"],
    ["workflow.nested.deep.value", true],
    ["workflow.items[1].name", "second"],
    ["workflow.items.length", 2],
    ["workflow.greeting.length", 5],
    ["workflow.greeting[0]", "م"],
    [`event.payload["order id"]`, "ORD-1"],
    ["workflow.empty", null],
    ["workflow.missing", undefined],
    ["workflow.items[9]", undefined],
    ["workflow.count.digits", undefined],
    ["workflow.missing?.x", undefined],
    ["workflow.empty?.x.y.z", undefined],
    ["user?.attributes?.plan", "pro"],
    ["workflow", scopes.workflow],
  ])("%s resolves to %j", (source, expected) => {
    expect(resolveSource(source)).toEqual({ kind: "value", value: expected });
  });

  test.each([
    ["workflow.missing.x", "Cannot read properties of undefined (reading 'x')"],
    ["workflow.empty.x", "Cannot read properties of null (reading 'x')"],
    ["workflow.items[5].name", "Cannot read properties of undefined (reading 'name')"],
    ["workflow.missing?.x.y", undefined],
  ])("%s fails like JavaScript", (source, message) => {
    if (message === undefined) expect(resolveSource(source)).toEqual({ kind: "value", value: undefined });
    else expect(resolveSource(source)).toEqual({ kind: "fail", message });
  });

  test.each([
    "workflow.constructor",
    "workflow.email.toUpperCase",
    "workflow.items.map",
    "workflow.count.toFixed",
    "workflow.nested.__proto__",
    "workflow.nested.hasOwnProperty",
  ])("%s defers inherited names to the sandbox", (source) => {
    expect(resolveSource(source)).toEqual({ kind: "defer" });
  });

  test("a scope that was not passed defers to the sandbox", () => {
    const path = parsePath("conversation.topic");
    if (!path) throw new Error("not a path");
    expect(resolvePath(path, scopes)).toEqual({ kind: "defer" });
  });

  test("a scope object never leaks its prototype", () => {
    const path = parsePath("workflow.toString");
    if (!path) throw new Error("not a path");
    expect(resolvePath(path, { workflow: {} })).toEqual({ kind: "defer" });
  });
});
