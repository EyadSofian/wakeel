import { AppError } from "@wakeel/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  type ExpressionBatch,
  type ExpressionOutcome,
  type ExpressionScopes,
  evalExpressions,
  type SandboxPort,
} from "../../src/expr/index";

const scopes: ExpressionScopes = {
  workflow: { email: "sara@example.com", count: 3, items: [{ name: "first" }] },
  user: { attributes: { plan: "pro" } },
};

/**
 * A sandbox stand-in that answers from a table. It never evaluates anything: tests must not run
 * builder text either (CLAUDE.md §9).
 */
function fakeSandbox(answers: Record<string, ExpressionOutcome> = {}) {
  const evalSpy = vi.fn(
    async (batch: ExpressionBatch): Promise<ExpressionOutcome[]> =>
      batch.expressions.map((e) => answers[e] ?? { ok: false, message: `no answer for ${e}` }),
  );
  const port: SandboxPort = { evalExpressions: evalSpy };
  return { port, evalSpy };
}

describe("evalExpressions", () => {
  test("path-only expressions never call the sandbox", async () => {
    const { port, evalSpy } = fakeSandbox();
    const results = await evalExpressions(
      ["workflow.email", "user.attributes.plan", "user?.attributes?.missing", "workflow.items[0].name"],
      scopes,
      port,
    );
    expect(results).toEqual([
      { ok: true, value: "sara@example.com" },
      { ok: true, value: "pro" },
      { ok: true, value: undefined },
      { ok: true, value: "first" },
    ]);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  test("a path that throws is an expression_error without calling the sandbox", async () => {
    const { port, evalSpy } = fakeSandbox();
    const [result] = await evalExpressions(["workflow.missing.x"], scopes, port);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error.code).toBe("expression_error");
    expect(result.error.params).toEqual({
      expression: "workflow.missing.x",
      message: "Cannot read properties of undefined (reading 'x')",
    });
    expect(result.error.title).toBe("An expression failed: Cannot read properties of undefined (reading 'x')");
    expect(result.error.fix).toBe("Fix the expression `workflow.missing.x`.");
  });

  test("everything else goes to the sandbox in one batch, in order, once per distinct source", async () => {
    const { port, evalSpy } = fakeSandbox({
      "workflow.count + 1": { ok: true, value: 4 },
      "user.attributes.plan === 'pro'": { ok: true, value: true },
      "workflow.email.toUpperCase()": { ok: true, value: "SARA@EXAMPLE.COM" },
    });
    const results = await evalExpressions(
      [
        "workflow.count + 1",
        "workflow.email",
        " user.attributes.plan === 'pro' ",
        "workflow.count + 1",
        "workflow.email.toUpperCase()",
      ],
      scopes,
      port,
    );
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith({
      expressions: ["workflow.count + 1", "user.attributes.plan === 'pro'", "workflow.email.toUpperCase()"],
      scopes,
    });
    expect(results).toEqual([
      { ok: true, value: 4 },
      { ok: true, value: "sara@example.com" },
      { ok: true, value: true },
      { ok: true, value: 4 },
      { ok: true, value: "SARA@EXAMPLE.COM" },
    ]);
  });

  test("a path that reaches an inherited name is sent to the sandbox", async () => {
    const { port, evalSpy } = fakeSandbox({ "workflow.email.toUpperCase": { ok: true, value: undefined } });
    await evalExpressions(["workflow.email.toUpperCase"], scopes, port);
    expect(evalSpy).toHaveBeenCalledWith({ expressions: ["workflow.email.toUpperCase"], scopes });
  });

  test("one failing expression does not hide the others", async () => {
    const { port } = fakeSandbox({
      "workflow.count * 2": { ok: true, value: 6 },
      "workflow.items.find(i => i.x).y": {
        ok: false,
        message: "cannot read property 'y' of undefined",
      },
    });
    const [ok, failed] = await evalExpressions(["workflow.count * 2", "workflow.items.find(i => i.x).y"], scopes, port);
    expect(ok).toEqual({ ok: true, value: 6 });
    expect(failed?.ok).toBe(false);
    if (failed?.ok !== false) return;
    expect(failed.error.code).toBe("expression_error");
    expect(failed.error.params).toEqual({
      expression: "workflow.items.find(i => i.x).y",
      message: "cannot read property 'y' of undefined",
    });
  });

  test("a syntax error is reported without calling the sandbox", async () => {
    const { port, evalSpy } = fakeSandbox();
    const [result] = await evalExpressions(["workflow.count +"], scopes, port);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error.code).toBe("expression_error");
    expect(result.error.params["expression"]).toBe("workflow.count +");
    expect(String(result.error.params["message"])).toMatch(/^The expression does not parse: /);
  });

  test("an empty expression is an expression_error", async () => {
    const { port } = fakeSandbox();
    const [result] = await evalExpressions(["   "], scopes, port);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error.params).toEqual({ expression: "", message: "The expression does not parse: it is empty" });
  });

  test("a batch that cannot run fails every sandboxed expression with the sandbox's message", async () => {
    const evalSpy = vi.fn(async (): Promise<ExpressionOutcome[]> => {
      throw new AppError("code_timeout", { limit: 1000 });
    });
    const results = await evalExpressions(["workflow.email", "workflow.count + 1", "workflow.count + 2"], scopes, {
      evalExpressions: evalSpy,
    });
    expect(results[0]).toEqual({ ok: true, value: "sara@example.com" });
    for (const [i, source] of [
      [1, "workflow.count + 1"],
      [2, "workflow.count + 2"],
    ] as const) {
      const r = results[i];
      expect(r?.ok).toBe(false);
      if (r?.ok !== false) continue;
      expect(r.error.code).toBe("expression_error");
      expect(r.error.params).toEqual({ expression: source, message: "Your code ran longer than 1000 ms" });
      expect(r.error.cause).toBeInstanceOf(AppError);
    }
  });

  test("a batch failure that is not an AppError still names the expression", async () => {
    const results = await evalExpressions(["workflow.count + 1"], scopes, {
      evalExpressions: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(results[0]?.ok).toBe(false);
    if (results[0]?.ok !== false) return;
    expect(results[0].error.params).toEqual({
      expression: "workflow.count + 1",
      message: "The sandbox could not run it: socket hang up",
    });
  });

  test("a sandbox that answers with the wrong number of outcomes is a failure, not a misalignment", async () => {
    const results = await evalExpressions(["workflow.count + 1", "workflow.count + 2"], scopes, {
      evalExpressions: async () => [{ ok: true, value: 1 }],
    });
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.params["message"]).toBe("The sandbox could not run it: it returned 1 results for 2 expressions");
    }
  });

  test("no expressions means no sandbox call", async () => {
    const { port, evalSpy } = fakeSandbox();
    expect(await evalExpressions([], scopes, port)).toEqual([]);
    expect(evalSpy).not.toHaveBeenCalled();
  });
});
