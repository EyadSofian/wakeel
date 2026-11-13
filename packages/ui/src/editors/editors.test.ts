import { describe, expect, it } from "vitest";
import { expressionQuery } from "./ExpressionInput";
import { completionQuery, splitTemplate } from "./TemplateInput";
import { pickerRows } from "./VariablePicker";

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

describe("pickerRows", () => {
  const options = [
    { id: "var_a", path: "workflow.answer", type: "string", group: "Workflow" },
    { id: "var_b", path: "conversation.orderId", type: "string", group: "Conversation" },
    { id: "var_c", path: "user.email", type: "string", group: "User" },
  ];
  const paths = (rows: ReturnType<typeof pickerRows>) =>
    rows.map((r) => (r.kind === "option" ? r.option.path : `+${r.name}`));

  it("lists everything for an empty search, without a create row", () => {
    expect(paths(pickerRows(options, "", true))).toEqual(["workflow.answer", "conversation.orderId", "user.email"]);
  });

  it("matches anywhere in the path, ignoring case", () => {
    expect(paths(pickerRows(options, "ORDER", false))).toEqual(["conversation.orderId"]);
  });

  it("offers to create a valid new name, scope prefix or not", () => {
    expect(paths(pickerRows(options, "phone", true))).toEqual(["+phone"]);
    expect(paths(pickerRows(options, "workflow.phone", true))).toEqual(["+phone"]);
  });

  it("does not offer a name that exists, an invalid name, or Arabic", () => {
    expect(paths(pickerRows(options, "email", true))).toEqual(["user.email"]);
    expect(paths(pickerRows(options, "2nd", true))).toEqual([]);
    expect(paths(pickerRows(options, "الاسم", true))).toEqual([]);
  });

  it("does not offer creation when the caller cannot create", () => {
    expect(paths(pickerRows(options, "phone", false))).toEqual([]);
  });
});
