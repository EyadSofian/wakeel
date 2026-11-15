import { AppError } from "@wakeel/contracts";
import { firstStrongDirection, RTL_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { describe, expect, test, vi } from "vitest";
import {
  type ExpressionBatch,
  type ExpressionOutcome,
  type ExpressionScopes,
  renderTemplate,
  renderTemplates,
  type SandboxPort,
  splitTemplate,
  stringifyValue,
} from "../../src/expr/index";

const scopes: ExpressionScopes = {
  workflow: {
    name: "محمد عبد الرحمن",
    orderId: "ORD-2026-45123",
    total: 250,
    paid: false,
    tags: ["vip", "عميل"],
    address: { city: "القاهرة" },
    nothing: null,
  },
  user: { attributes: { plan: "pro" } },
};

/** Answers from a table; never evaluates (CLAUDE.md §9). */
function fakeSandbox(answers: Record<string, ExpressionOutcome> = {}) {
  const evalSpy = vi.fn(
    async (batch: ExpressionBatch): Promise<ExpressionOutcome[]> =>
      batch.expressions.map((e) => answers[e] ?? { ok: false, message: `no answer for ${e}` }),
  );
  const port: SandboxPort = { evalExpressions: evalSpy };
  return { port, evalSpy };
}

async function expectTemplateError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected a template_error");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("splitTemplate", () => {
  test("splits text and placeholders, keeping the text exactly", () => {
    expect(splitTemplate("Hi {{ workflow.name }}, order {{workflow.orderId}}.")).toEqual({
      ok: true,
      parts: [
        { kind: "text", text: "Hi " },
        { kind: "expression", source: "workflow.name" },
        { kind: "text", text: ", order " },
        { kind: "expression", source: "workflow.orderId" },
        { kind: "text", text: "." },
      ],
    });
  });

  test("a template with no placeholders is one text part", () => {
    expect(splitTemplate("plain")).toEqual({ ok: true, parts: [{ kind: "text", text: "plain" }] });
    expect(splitTemplate("")).toEqual({ ok: true, parts: [] });
  });

  test.each([
    ["Hi {{ workflow.name", "a {{ is never closed"],
    ["Hi }} there", "a }} has no matching {{"],
    ["{{ workflow. }}", "{{ workflow. }} Unexpected token"],
  ])("%s does not parse", (text, reason) => {
    const result = splitTemplate(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith(reason)).toBe(true);
  });
});

describe("stringifyValue", () => {
  test.each([
    ["text", "text"],
    [250, "250"],
    [-0.5, "-0.5"],
    [true, "true"],
    [false, "false"],
    [null, ""],
    [undefined, ""],
    [["vip", "عميل"], '["vip","عميل"]'],
    [{ city: "القاهرة" }, '{"city":"القاهرة"}'],
  ])("%j becomes %j", (value, text) => {
    expect(stringifyValue(value)).toBe(text);
  });
});

describe("renderTemplate", () => {
  test("a path-only template renders without the sandbox", async () => {
    const { port, evalSpy } = fakeSandbox();
    const text = await renderTemplate(
      "{{ workflow.name }}: total {{ workflow.total }}, paid {{workflow.paid}}, plan {{ user?.attributes?.plan }}, {{ workflow.nothing }}{{ workflow.missing }}.",
      scopes,
      port,
    );
    expect(text).toBe("محمد عبد الرحمن: total 250, paid false, plan pro, .");
    expect(evalSpy).not.toHaveBeenCalled();
  });

  test("a mixed template sends only the non-path expressions, in one batch", async () => {
    const { port, evalSpy } = fakeSandbox({
      "workflow.total * 1.14": { ok: true, value: 285 },
      "workflow.tags.join('، ')": { ok: true, value: "vip، عميل" },
    });
    const text = await renderTemplate(
      "طلبك رقم {{ workflow.orderId }} بإجمالي {{ workflow.total * 1.14 }} جنيه ({{ workflow.tags.join('، ') }}) إلى {{ workflow.address.city }}.",
      scopes,
      port,
    );
    expect(text).toBe("طلبك رقم ORD-2026-45123 بإجمالي 285 جنيه (vip، عميل) إلى القاهرة.");
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith({
      expressions: ["workflow.total * 1.14", "workflow.tags.join('، ')"],
      scopes,
    });
  });

  test("objects and arrays render as JSON", async () => {
    const { port } = fakeSandbox();
    expect(await renderTemplate("{{workflow.tags}} {{workflow.address}}", scopes, port)).toBe(
      '["vip","عميل"] {"city":"القاهرة"}',
    );
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f] as const))(
    "%s passes through unchanged around placeholders",
    async (_id, fixture) => {
      const { port, evalSpy } = fakeSandbox();
      const fixtureScopes: ExpressionScopes = { workflow: { text: fixture.text, n: 7 } };
      const rendered = await renderTemplate(
        `${fixture.text} {{ workflow.n }} {{ workflow.text }}`,
        fixtureScopes,
        port,
      );
      expect(rendered).toBe(`${fixture.text} 7 ${fixture.text}`);
      expect(firstStrongDirection(rendered)).toBe(fixture.direction);
      expect(evalSpy).not.toHaveBeenCalled();
    },
  );

  test("Arabic text inside a placeholder value is never reordered or wrapped in marks", async () => {
    const { port } = fakeSandbox();
    const text = await renderTemplate("Order confirmed for {{workflow.name}}, delivery tomorrow.", scopes, port);
    expect(text).toBe("Order confirmed for محمد عبد الرحمن, delivery tomorrow.");
    expect(text).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
  });

  test("a placeholder that throws is a template_error naming it, with the expression_error as cause", async () => {
    const { port } = fakeSandbox({
      "workflow.total.toFixed(200)": { ok: false, message: "toFixed() digits out of range" },
    });
    const error = await expectTemplateError(renderTemplate("Total {{ workflow.total.toFixed(200) }}", scopes, port));
    expect(error.code).toBe("template_error");
    expect(error.params).toEqual({ expression: "workflow.total.toFixed(200)" });
    expect(error.title).toBe("A message template could not be filled in");
    expect(error.fix).toBe("Check `workflow.total.toFixed(200)` in the highlighted field.");
    expect(error.detail).toBe("toFixed() digits out of range");
    expect(error.cause).toBeInstanceOf(AppError);
    expect((error.cause as AppError).code).toBe("expression_error");
  });

  test("a path placeholder that throws is a template_error too", async () => {
    const { port, evalSpy } = fakeSandbox();
    const error = await expectTemplateError(renderTemplate("مرحبا {{ workflow.missing.name }}", scopes, port));
    expect(error.code).toBe("template_error");
    expect(error.params).toEqual({ expression: "workflow.missing.name" });
    expect(error.detail).toBe("Cannot read properties of undefined (reading 'name')");
    expect(evalSpy).not.toHaveBeenCalled();
  });

  test("a template that does not parse is a template_error and calls nothing", async () => {
    const { port, evalSpy } = fakeSandbox();
    const error = await expectTemplateError(renderTemplate("Hi {{ workflow.name", scopes, port));
    expect(error.code).toBe("template_error");
    expect(error.params).toEqual({ expression: "Hi {{ workflow.name" });
    expect(error.detail).toBe("a {{ is never closed");
    expect(evalSpy).not.toHaveBeenCalled();
  });

  test("a value that cannot become text is a template_error", async () => {
    const looped: Record<string, unknown> = {};
    looped["self"] = looped;
    // Values come from the sandbox as JSON, so this only guards against a misbehaving adapter.
    const badPort: SandboxPort = {
      evalExpressions: async () => [{ ok: true, value: looped as never }],
    };
    const error = await expectTemplateError(renderTemplate("{{ workflow.total + 0 }}", scopes, badPort));
    expect(error.code).toBe("template_error");
    expect(error.params).toEqual({ expression: "workflow.total + 0" });
    expect(error.detail).toMatch(/circular/i);
  });
});

describe("renderTemplates", () => {
  test("all fields of a card share one sandbox batch", async () => {
    const { port, evalSpy } = fakeSandbox({
      "workflow.total + 10": { ok: true, value: 260 },
      "workflow.paid ? 'paid' : 'due'": { ok: true, value: "due" },
    });
    const texts = await renderTemplates(
      [
        "Hi {{ workflow.name }}",
        "Total {{ workflow.total + 10 }}",
        "Status {{ workflow.paid ? 'paid' : 'due' }} / {{ workflow.total + 10 }}",
        "no placeholders",
      ],
      scopes,
      port,
    );
    expect(texts).toEqual(["Hi محمد عبد الرحمن", "Total 260", "Status due / 260", "no placeholders"]);
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(evalSpy).toHaveBeenCalledWith({
      expressions: ["workflow.total + 10", "workflow.paid ? 'paid' : 'due'"],
      scopes,
    });
  });

  test("templates with no expressions call nothing", async () => {
    const { port, evalSpy } = fakeSandbox();
    expect(await renderTemplates([], scopes, port)).toEqual([]);
    expect(await renderTemplates(["a", ""], scopes, port)).toEqual(["a", ""]);
    expect(evalSpy).not.toHaveBeenCalled();
  });

  test("a parse failure in any field fails before the sandbox is called", async () => {
    const { port, evalSpy } = fakeSandbox();
    const error = await expectTemplateError(renderTemplates(["{{ workflow.total + 1 }}", "oops }}"], scopes, port));
    expect(error.params).toEqual({ expression: "oops }}" });
    expect(evalSpy).not.toHaveBeenCalled();
  });
});
