import type { Json, VariableType } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { indexDefinition } from "../src/definition";
import { applyWrites, describeJson, fitsType, jsonBytes } from "../src/variables";
import { linearBot, state, varId, wfId } from "./turn/harness";

/** Architecture §4.5: writes are validated against the declared type. */

const cases: [VariableType, Json, boolean][] = [
  ["string", "مرحبا", true],
  ["string", 5, false],
  ["number", 3.5, true],
  ["number", "3", false],
  ["boolean", false, true],
  ["boolean", "true", false],
  ["date", "2026-11-13", true],
  ["date", "2026-11-13T09:00:00.000Z", true],
  ["date", "2026-11-13T09:00:00+02:00", true],
  ["date", "13/11/2026", false],
  ["date", "2026-13-45", false],
  ["date", 20261113, false],
  ["enum", "gold", true],
  ["enum", "platinum", false],
  ["enum", 1, false],
  ["object", { a: 1 }, true],
  ["object", [1], false],
  ["object", "{}", false],
  ["array", [1, "٢"], true],
  ["array", { 0: 1 }, false],
  ["any", { anything: ["goes"] }, true],
  ["string", null, true],
  ["array", null, true],
];

describe("fitsType", () => {
  test.each(cases)("%s accepts %j: %s", (type, value, fits) => {
    expect(fitsType(value, type, ["basic", "gold"])).toBe(fits);
  });

  test("an enum with no list accepts nothing but null", () => {
    expect(fitsType("gold", "enum")).toBe(false);
    expect(fitsType(null, "enum")).toBe(true);
  });
});

test("describeJson names values the way error titles do", () => {
  expect([null, [1], {}, "s", 1, true].map((v) => describeJson(v))).toEqual([
    "null",
    "array",
    "object",
    "string",
    "number",
    "boolean",
  ]);
});

test("jsonBytes counts UTF-8 bytes, so Arabic counts double", () => {
  expect(jsonBytes("abc")).toBe(5);
  expect(jsonBytes("أبج")).toBe(8);
});

test("a workflow write needs a frame of the workflow that declares the variable", () => {
  const local = varId();
  const otherWf = wfId();
  const bot = linearBot([], {
    workflows: [
      {
        id: otherWf,
        name: "Other",
        kind: "sub",
        nodes: [],
        edges: [],
        inputs: [],
        outputs: [],
        variables: [{ id: local, name: "x", scope: "workflow", type: "number" }],
      },
    ],
  });
  const index = indexDefinition(bot.def);
  const stores = { state: state(), user: { vars: {} } };
  const frame = { workflowId: bot.main.id, nodeId: bot.node, cardIndex: 0, vars: {}, inputs: {} };
  expect(() => applyWrites(index, stores, frame, [{ scope: "workflow", variableId: local, value: 1 }])).toThrow(
    '"x" is not a variable in this scope',
  );
  expect(() => applyWrites(index, stores, undefined, [{ scope: "workflow", variableId: local, value: 1 }])).toThrow();
  expect(indexDefinition(bot.def)).toBe(index);
});
