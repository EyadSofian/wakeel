import { describe, expect, test } from "vitest";
import { ExecRequestFrame, ScopePatches, ServiceFrame, ToolResultFrame } from "../src/protocol";

/** Fixture parse and reject tests for the exec stream frames (ADR-019 §10, ADR-023 §2–§5). */

describe("request frame", () => {
  test("fills the 3.3 additions with their defaults", () => {
    const frame = ExecRequestFrame.parse({ execId: "exec_1", kind: "code", source: "return 1;" });
    expect(frame).toMatchObject({ scopes: {}, toolManifest: [], secretKeys: [], tables: [] });
    expect(frame.ctx).toBeUndefined();
  });

  test("accepts an ADR-018 expression batch", () => {
    const frame = ExecRequestFrame.parse({
      execId: "exec_2",
      kind: "expressions",
      source: JSON.stringify(["workflow.a + 1", "'مرحبا'"]),
      scopes: { workflow: { a: 1 } },
    });
    expect(frame.kind).toBe("expressions");
  });

  test.each([
    ["a table name that is not an identifier", { tables: ["orders; drop"] }],
    ["a limit above the maximum", { limits: { timeoutMs: 120_000 } }],
    ["an empty idempotency key", { ctx: { idempotencyKey: "" } }],
    ["an unknown kind", { kind: "shell" }],
  ])("rejects %s", (_name, extra) => {
    expect(ExecRequestFrame.safeParse({ execId: "exec_3", kind: "code", source: "", ...extra }).success).toBe(false);
  });
});

describe("service frames", () => {
  test("a tool call must name a platform call", () => {
    expect(ServiceFrame.safeParse({ t: "tool_call", callId: "c1", name: "say", input: {} }).success).toBe(true);
    expect(ServiceFrame.safeParse({ t: "tool_call", callId: "c1", name: "run_shell", input: {} }).success).toBe(false);
  });

  test("a log frame has a level and arguments", () => {
    expect(ServiceFrame.safeParse({ t: "log", level: "info", args: ["a"] }).success).toBe(true);
    expect(ServiceFrame.safeParse({ t: "log", level: "debug", args: [] }).success).toBe(false);
  });

  test("scope patches only name the writable scopes", () => {
    expect(ScopePatches.safeParse({ workflow: { set: { a: 1 }, unset: ["b"] } }).success).toBe(true);
    expect(ScopePatches.safeParse({ env: { set: { KEY: "x" } } }).success).toBe(false);
    expect(ScopePatches.safeParse({ workflow: { replace: {} } }).success).toBe(false);
  });

  test("a failed tool result carries a code and a message", () => {
    expect(
      ToolResultFrame.safeParse({
        t: "tool_result",
        callId: "c1",
        ok: false,
        error: { code: "tool_failed", message: "x" },
      }).success,
    ).toBe(true);
    expect(ToolResultFrame.safeParse({ t: "tool_result", callId: "c1", ok: false, error: "x" }).success).toBe(false);
  });
});
