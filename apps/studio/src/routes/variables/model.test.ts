import { newElementId, type Variable, type Workflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { createCard, createNode } from "../../canvas/store/factories";
import { seededDraft } from "../../canvas/store/fixtures.test-utils";
import {
  defaultText,
  formatDefault,
  groupUsages,
  orderWorkflows,
  parseDefault,
  parseEnumValues,
  placesLabel,
  usageField,
  usesLabel,
  variableGroups,
} from "./model";

const wf = (name: string, kind: Workflow["kind"]): Workflow => ({
  id: newElementId("wf"),
  name,
  kind,
  inputs: [],
  outputs: [],
  variables: [],
  nodes: [],
  edges: [],
  layout: {},
});

describe("variableGroups", () => {
  test("Bot, User, Conversation, then Main, sub-workflows by name, error last", () => {
    const { manifest } = seededDraft();
    const v = (name: string, scope: Variable["scope"]): Variable => ({
      id: newElementId("var"),
      name,
      scope,
      type: "string",
      sensitive: false,
    });
    manifest.variables = [v("brand", "bot"), v("email", "user"), v("orderId", "conversation"), v("phone", "user")];
    const groups = variableGroups(manifest, [
      wf("Errors", "error"),
      wf("طلبات", "sub"),
      wf("Billing", "sub"),
      wf("Main", "main"),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["Bot", "User", "Conversation", "Main", "Billing", "طلبات", "Errors"]);
    expect(groups[1]?.variables.map((x) => x.name)).toEqual(["email", "phone"]);
    expect(orderWorkflows([wf("b", "sub"), wf("a", "main")]).map((w) => w.kind)).toEqual(["main", "sub"]);
  });
});

describe("defaults", () => {
  test.each([
    ["string", "مرحبا", "مرحبا"],
    ["number", " 12.5 ", 12.5],
    ["boolean", "false", false],
    ["date", "2026-11-13", "2026-11-13"],
    ["object", '{"plan":"pro"}', { plan: "pro" }],
    ["array", "[1, 2]", [1, 2]],
    ["any", "null", null],
    ["string", "", undefined],
  ] as const)("%s %j", (type, text, value) => {
    expect(parseDefault(type, text)).toEqual({ ok: true, value });
  });

  test.each([
    ["number", "twelve", "Enter a number, like 12 or 2.5."],
    ["boolean", "yes", "Choose yes or no."],
    ["date", "tomorrow", "Enter a date like 2026-11-13."],
    ["object", "[1]", 'Enter a JSON object, like {"plan": "pro"}.'],
    ["array", "{}", "Enter a JSON list, like [1, 2]."],
    ["any", "{oops", 'Enter valid JSON, like {"plan": "pro"}.'],
    ["enum", "gold", "Choose one of the allowed values."],
  ] as const)("rejects %s %j", (type, text, reason) => {
    expect(parseDefault(type, text, ["basic", "pro"])).toEqual({ ok: false, reason });
  });

  test("round-trips through the text the builder edits", () => {
    expect(defaultText({ type: "object", default: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect(defaultText({ type: "number", default: 3 })).toBe("3");
    expect(formatDefault({ default: { a: 1 } })).toBe('{"a":1}');
    expect(formatDefault({})).toBe("");
  });

  test("allowed values: one per line, trimmed, unique", () => {
    expect(parseEnumValues(" basic\n\npro\nbasic\nذهبي ")).toEqual(["basic", "pro", "ذهبي"]);
  });
});

describe("usages", () => {
  test("labels a card field and a node field", () => {
    const { main } = seededDraft();
    const node = createNode("standard", "Greet");
    const log = createCard("log");
    if (node.type !== "standard") throw new Error("standard");
    node.cards = [log];
    const doc = { ...main, nodes: [...main.nodes, node] };
    expect(usageField({ workflowId: doc.id, nodeId: node.id, cardId: log.id, field: "data", via: "name" }, doc)).toBe(
      "Log · Data",
    );
    expect(usageField({ workflowId: doc.id, nodeId: node.id, field: "instructions", via: "name" }, doc)).toBe(
      "Instructions",
    );
  });

  test("collapses repeats in one field into a count", () => {
    const u = { workflowId: "wf_a", nodeId: "node_a", cardId: "card_a", field: "message.text", via: "name" as const };
    expect(groupUsages([u, u, { ...u, field: "into", via: "id" }]).map((x) => x.count)).toEqual([2, 1]);
    expect([0, 1, 4].map(usesLabel)).toEqual(["Not used", "1 use", "4 uses"]);
    expect([1, 3].map(placesLabel)).toEqual(["1 place", "3 places"]);
  });
});
