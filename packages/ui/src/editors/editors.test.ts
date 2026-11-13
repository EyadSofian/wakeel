import { describe, expect, it } from "vitest";
import { expressionQuery } from "./ExpressionInput";
import { completionQuery, splitTemplate } from "./TemplateInput";

describe("splitTemplate", () => {
  it.each([
    ["Hello {{user.name}}!", ["Hello ", "{{user.name}}", "!"]],
    [
      "أهلاً {{user.name}}، طلبك رقم {{conversation.orderNumber}}",
      ["أهلاً ", "{{user.name}}", "، طلبك رقم ", "{{conversation.orderNumber}}"],
    ],
    ["no placeholders", ["no placeholders"]],
    ["{{a}}{{b}}", ["{{a}}", "{{b}}"]],
    ["broken {{user.name", ["broken {{user.name"]],
    ["", []],
  ])("%s", (text, parts) => {
    expect(splitTemplate(text).map((s) => s.text)).toEqual(parts);
    expect(
      splitTemplate(text)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });

  it("marks only the placeholders", () => {
    expect(splitTemplate("a {{x}} b").map((s) => s.placeholder)).toEqual([false, true, false]);
  });
});

describe("completionQuery", () => {
  it.each([
    ["Hi {{", 5, ""],
    ["Hi {{ user.na", 13, "user.na"],
    ["مرحبا {{workflow.", 17, "workflow."],
    ["Hi {{user.name}} ", 17, undefined],
    ["no braces", 9, undefined],
  ] as const)("%s at %i → %s", (text, caret, q) => {
    expect(completionQuery(text, caret)).toBe(q);
  });
});

describe("expressionQuery", () => {
  it.each([
    ["conversation.to", "conversation.to"],
    ["workflow.count > 2 && user.", "user."],
    ["x == ", undefined],
    ["", undefined],
  ] as const)("%s → %s", (text, q) => {
    expect(expressionQuery(text, text.length)).toBe(q);
  });
});
