import { AutonomousNode } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { afterRun, contextFromNode, feedbackFor, issueKind, type ProtocolIssueCode } from "../../src/protocol/index";
import { CTX, EXITS, lines, read } from "./helpers";

describe("run and exit precedence (architecture §6.2)", () => {
  const both = read([lines(":::run", "workflow.x = 1", ":::exit done")]).result;

  test("a run that returns a value gets another iteration and the exit is ignored", () => {
    expect(afterRun(both, { returned: true })).toEqual({ action: "iterate", ignoredExit: both.exit });
  });

  test("a run without a return leaves through the exit", () => {
    expect(afterRun(both, { returned: false })).toEqual({ action: "exit", exit: both.exit });
  });

  test("a run without a return and without an exit iterates", () => {
    const runOnly = read([lines(":::run", "workflow.x = 1")]).result;
    expect(afterRun(runOnly, { returned: false })).toEqual({ action: "iterate" });
  });

  test("a returning run without an exit iterates with nothing ignored", () => {
    const runOnly = read([lines(":::run", "return 1")]).result;
    expect(afterRun(runOnly, { returned: true })).toEqual({ action: "iterate" });
  });
});

describe("issue kinds", () => {
  test.each<[ProtocolIssueCode, "protocol_error" | "exit_invalid"]>([
    ["exit_unknown", "exit_invalid"],
    ["exit_name_missing", "exit_invalid"],
    ["exit_data_invalid", "exit_invalid"],
    ["exit_data_mismatch", "exit_invalid"],
    ["exit_body", "protocol_error"],
    ["exit_twice", "protocol_error"],
    ["run_twice", "protocol_error"],
    ["say_invalid", "protocol_error"],
    ["incomplete", "protocol_error"],
  ])("%s is %s", (code, kind) => {
    expect(issueKind(code)).toBe(kind);
  });
});

describe("feedback for the next iteration", () => {
  test("a valid reply has no feedback", () => {
    expect(feedbackFor(read([":::exit listen"]).result)).toBeUndefined();
  });

  test("an unknown exit lists the exits the model may take", () => {
    const fb = feedbackFor(read([":::exit finished"]).result);
    expect(fb?.kind).toBe("exit_invalid");
    expect(fb?.text).toContain("finished");
    for (const name of ["order_found", "done", "listen"]) expect(fb?.text).toContain(name);
    expect(fb?.text).not.toContain("handoff");
    expect(fb?.text).toContain("line 1");
  });

  test("handoff is listed only when the node allows it", () => {
    const fb = feedbackFor(read([":::exit finished"], { ...CTX, allowHandoff: true, conversational: false }).result);
    expect(fb?.text).toContain("handoff");
    expect(fb?.text).not.toContain("listen");
  });

  test("a disallowed message type lists the allowed ones", () => {
    const fb = feedbackFor(read([lines(':::say card {"title":"A"}', ":::exit listen")]).result);
    expect(fb?.kind).toBe("protocol_error");
    expect(fb?.text).toContain("text, choice");
  });

  test("a schema mismatch names the field", () => {
    const fb = feedbackFor(read([':::exit order_found {"orderId":42}']).result);
    expect(fb?.text).toContain("orderId");
  });

  test("messages already sent are reported so the model does not repeat them", () => {
    const fb = feedbackFor(
      read([lines(":::say text", "One", ":::say text", "Two", ":::run", "return 1", ":::run")]).result,
    );
    expect(fb?.text).toMatch(/2 messages .* already sent/);
  });

  test("one message already sent uses the singular", () => {
    const fb = feedbackFor(read([lines(":::say text", "One", ":::end")]).result);
    expect(fb?.text).toMatch(/1 message .* already sent/);
  });

  test("no note about sent messages when none were sent", () => {
    const fb = feedbackFor(read(["Sure!\n:::exit listen"]).result);
    expect(fb?.text).not.toContain("already sent");
  });
});

describe("contextFromNode", () => {
  test("takes the protocol settings from an Autonomous Node", () => {
    const node = AutonomousNode.parse({
      id: "node_abcdefghij",
      name: "Support",
      type: "autonomous",
      instructions: "Help the user.",
      exits: EXITS,
      allowHandoff: true,
      messageTypes: ["text", "card"],
    });
    expect(contextFromNode(node)).toEqual({
      conversational: true,
      allowHandoff: true,
      exits: EXITS,
      messageTypes: ["text", "card"],
    });
  });
});
