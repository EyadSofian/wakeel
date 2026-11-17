import { AutonomousNode, type Tool } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { setAutoSearch, setAutoSearchRewrite, setAutoSearchTool, withKnowledgeTool, withoutTool } from "./auto-search";

/** Task 6.13 (ADR-055): the inspector's commands for searching before every reply. */

const node = (tools: Tool[] = [], autoSearch?: { toolId: string; rewrite: boolean }) =>
  AutonomousNode.parse({
    id: "node_Advisor000",
    type: "autonomous",
    name: "Advisor",
    instructions: "Advise on courses.",
    tools,
    ...(autoSearch ? { autoSearch } : {}),
  });
const kb = (id: string, name = id): Tool => ({
  id,
  type: "kb_search",
  name,
  description: "Course pages.",
  kbIds: ["kb_01m7a256m0a13warwhczsjhx9b"],
  topK: 5,
});
const code: Tool = {
  id: "tool_Lookup0000",
  type: "code",
  name: "lookup",
  description: "Looks up an order.",
  input: { type: "object", properties: {} },
  source: "return null;",
  sideEffects: true,
  timeoutMs: 10_000,
};

describe("searching before every reply", () => {
  test("the first knowledge tool turns it on, with follow-up rewriting", () => {
    const n = withKnowledgeTool(node([code]), kb("tool_Courses000"));
    expect(n.tools.map((t) => t.id)).toEqual(["tool_Lookup0000", "tool_Courses000"]);
    expect(n.autoSearch).toEqual({ toolId: "tool_Courses000", rewrite: true });
  });

  test("a node that already had knowledge tools keeps its choice when another is added", () => {
    const off = withKnowledgeTool(node([kb("tool_Courses000")]), kb("tool_Policies00"));
    expect(off.autoSearch).toBeUndefined();
    const on = withKnowledgeTool(node([kb("tool_Courses000")], { toolId: "tool_Courses000", rewrite: false }), kb("tool_Policies00"));
    expect(on.autoSearch).toEqual({ toolId: "tool_Courses000", rewrite: false });
  });

  test("turning it on picks the first knowledge tool; turning it off removes it", () => {
    const n = node([code, kb("tool_Courses000"), kb("tool_Policies00")]);
    expect(setAutoSearch(n, true).autoSearch).toEqual({ toolId: "tool_Courses000", rewrite: true });
    expect(setAutoSearch(setAutoSearch(n, true), false).autoSearch).toBeUndefined();
    // Without a knowledge tool there is nothing to search with.
    expect(setAutoSearch(node([code]), true).autoSearch).toBeUndefined();
  });

  test("the tool and the rewrite can be changed while it is on", () => {
    const n = setAutoSearch(node([kb("tool_Courses000"), kb("tool_Policies00")]), true);
    expect(setAutoSearchTool(n, "tool_Policies00").autoSearch).toEqual({ toolId: "tool_Policies00", rewrite: true });
    expect(setAutoSearchRewrite(n, false).autoSearch).toEqual({ toolId: "tool_Courses000", rewrite: false });
    // A tool that is not one of the node's knowledge tools is refused rather than saved invalid.
    expect(setAutoSearchTool(n, "tool_Lookup0000").autoSearch?.toolId).toBe("tool_Courses000");
  });

  test("deleting the tool it uses moves it to another knowledge tool, or turns it off", () => {
    const two = node([kb("tool_Courses000"), kb("tool_Policies00")], { toolId: "tool_Courses000", rewrite: false });
    expect(withoutTool(two, "tool_Courses000").autoSearch).toEqual({ toolId: "tool_Policies00", rewrite: false });
    const one = node([kb("tool_Courses000"), code], { toolId: "tool_Courses000", rewrite: true });
    const left = withoutTool(one, "tool_Courses000");
    expect(left.tools.map((t) => t.id)).toEqual(["tool_Lookup0000"]);
    expect(left.autoSearch).toBeUndefined();
    // Deleting another tool leaves it alone.
    expect(withoutTool(one, "tool_Lookup0000").autoSearch).toEqual({ toolId: "tool_Courses000", rewrite: true });
  });
});
