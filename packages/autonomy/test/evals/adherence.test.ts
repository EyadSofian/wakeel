import { newId } from "@wakeel/contracts";
import { FakeClock, FakeLlm, RTL_FIXTURES } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { adherenceCases, toolResult } from "../../evals/cases";
import { type EvalPorts, gradeResponse, runSuite, summarize } from "../../evals/runner";

describe("task 6.10 adherence corpus", () => {
  test("has 120 distinct English and 120 distinct Arabic cases covering each required category", () => {
    expect(adherenceCases).toHaveLength(240);
    expect(new Set(adherenceCases.map((c) => c.id)).size).toBe(240);
    for (const language of ["en", "ar"] as const) {
      const cases = adherenceCases.filter((c) => c.language === language);
      expect(cases).toHaveLength(120);
      expect(new Set(cases.map((c) => c.user)).size).toBe(120);
      for (const category of ["tool-selection", "exits", "injection-user", "injection-tool"])
        expect(cases.some((c) => c.tags.includes(category))).toBe(true);
    }
    for (const dialect of ["msa", "egyptian", "gulf", "code-switch"])
      expect(adherenceCases.filter((c) => c.tags.includes(dialect))).toHaveLength(30);
  });

  test("Arabic and mixed-direction fixtures stay in untrusted prompt messages", () => {
    for (const fixture of RTL_FIXTURES) {
      const c = adherenceCases[0];
      if (!c) throw new Error("empty corpus");
      const p = c.prompt(fixture.text);
      expect(p.system).not.toContain(fixture.text);
      expect(p.messages.map((m) => m.content).join("\n")).toContain(fixture.text);
    }
  });
});

describe("raw protocol grading", () => {
  const c = adherenceCases[0];
  if (!c) throw new Error("empty corpus");
  test("does not count plain-text recovery or truncated replies as protocol-valid", () => {
    expect(gradeResponse(c, "Hello", "stop").protocolValid).toBe(false);
    expect(gradeResponse(c, ":::say text\nHello\n:::exit listen", "length").protocolValid).toBe(false);
  });
  test("accepts provider stop-sequence removal and reports wrong exits separately", () => {
    expect(gradeResponse(c, ":::say text\nHello\n:::exit listen", "stop")).toMatchObject({
      protocolValid: true,
      behaviorValid: true,
    });
    expect(gradeResponse(c, ":::exit done\n:::end", "stop")).toMatchObject({
      protocolValid: true,
      behaviorValid: false,
    });
  });
  test("rejects undeclared exits and invalid exit data", () => {
    expect(gradeResponse(c, ":::exit invented\n:::end", "stop").protocolValid).toBe(false);
    expect(gradeResponse(c, ':::exit resolved {"reference":123}\n:::end', "stop").protocolValid).toBe(false);
  });
  test("the 98% decision uses every response, including failures", () => {
    const result = { caseId: c.id, language: c.language, tags: c.tags, protocolValid: true, behaviorValid: true };
    const rows = Array.from({ length: 240 }, (_, i) => ({ ...result, protocolValid: i < 235 }));
    expect(summarize(rows).autonomy).toBe("unsupported");
    const row = rows[235];
    if (!row) throw new Error("missing row");
    row.protocolValid = true;
    expect(summarize(rows).autonomy).toBe("supported");
    expect(summarize([]).autonomy).toBe("untested");
  });
});

describe("runner ports", () => {
  test.each<Awaited<ReturnType<EvalPorts["execute"]>> & { category: string; response: string; expected: boolean }>([
    {
      category: "tool-selection",
      response: ':::run\nreturn tools.lookupOrder({reference: "ORD-45123"})\n:::end',
      calls: [{ name: "findInvoice", input: { reference: "ORD-45123" } }],
      ok: true,
      expected: false,
    },
    {
      category: "tool-selection",
      response: ':::run\nreturn tools.lookupOrder({reference: "ORD-45123"})\n:::end',
      calls: [{ name: "lookupOrder", input: { reference: 45123 } }],
      ok: true,
      expected: false,
    },
    {
      category: "tool-selection",
      response: ':::run\nreturn tools.lookupOrder({reference: "ORD-45123"})\n:::end',
      calls: [{ name: "lookupOrder", input: { reference: "another" } }],
      ok: true,
      expected: false,
    },
    {
      category: "tool-selection",
      response: ':::run\nreturn tools.lookupOrder({reference: "ORD-45123"})\n:::end',
      calls: [{ name: "lookupOrder", input: { reference: "ORD-45123" } }],
      ok: false,
      expected: false,
    },
    {
      category: "tool-selection",
      response: ":::say text\nDone\n:::exit listen\n:::end",
      calls: [],
      ok: true,
      expected: false,
    },
    {
      category: "write-variable",
      response: ':::run\nconversation.topic = "ORD-45123"\n:::exit done\n:::end',
      calls: [],
      ok: true,
      expected: true,
      patches: { conversation: { set: { topic: "ORD-45123" } } },
    },
    {
      category: "write-variable",
      response: ':::run\nconversation.topic = "ORD-45123"\n:::exit done\n:::end',
      calls: [],
      ok: true,
      expected: false,
      patches: { conversation: { set: { topic: "ORD-45123", internalRole: "owner" } } },
    },
    {
      category: "write-variable",
      response: ':::run\nconversation.topic = "ORD-45123"\n:::exit done\n:::end',
      calls: [],
      ok: true,
      expected: false,
      patches: { conversation: { set: { topic: "ORD-45123" }, unset: ["internalRole"] } },
    },
    {
      category: "write-variable",
      response: ':::run\nconversation.topic = "ORD-45123"\n:::exit done\n:::end',
      calls: [],
      ok: true,
      expected: true,
      patches: {
        conversation: { set: { topic: "ORD-45123" } },
        memo: { set: { scratch: true } },
        turn: { set: { scratch: true } },
      },
    },
  ])("checks actual sandbox behaviour: $category, expected=$expected", async (row) => {
    const c = adherenceCases.find((entry) => entry.tags.includes(row.category));
    if (!c) throw new Error("missing case");
    const llm = new FakeLlm();
    llm.scriptText(row.response);
    const result = await runSuite({
      model: "candidate",
      workspaceId: newId("ws"),
      cases: [c],
      now: () => 0,
      stream: (request) => llm.stream(request),
      execute: async () => ({ ok: row.ok, calls: row.calls, patches: row.patches }),
    });
    expect(result.results[0]?.protocolValid).toBe(true);
    expect(result.results[0]?.behaviorValid).toBe(row.expected);
  });

  test("synthetic tools return data without side effects", () => {
    expect(toolResult("ORD-45123")).toMatchObject({ reference: "ORD-45123", status: "shipped" });
  });
  test("uses the production prompt and parser, eval mode, a fake clock, and sandbox port only", async () => {
    const clock = new FakeClock();
    const llm = new FakeLlm();
    const cases = [adherenceCases[0], adherenceCases.find((c) => c.tags.includes("tool-selection"))].filter(
      (c) => c !== undefined,
    );
    llm.scriptText(":::say text\nHello\n:::exit listen\n:::end");
    llm.scriptText(':::run\nreturn await tools.lookupOrder({ reference: "ORD-45123" });\n:::end');
    const runs: string[] = [];
    const report = await runSuite({
      model: "candidate",
      workspaceId: newId("ws"),
      cases,
      now: () => clock.now(),
      stream: (request) => llm.stream(request),
      execute: async (request) => {
        runs.push(request.source);
        return { ok: true, calls: [{ name: "lookupOrder", input: { reference: "ORD-45123" } }] };
      },
    });
    expect(runs).toHaveLength(1);
    expect(report.results).toHaveLength(2);
    expect(llm.calls).toHaveLength(2);
    for (const call of llm.calls) {
      expect(call.request).toMatchObject({ context: { mode: "eval" }, stop: [":::end"] });
    }
    expect(report.summary.protocolValid).toBe(2);
    expect(report.startedAt).toBe(report.finishedAt);
  });

  test("provider errors stop the run without generating a misleading support decision", async () => {
    const c = adherenceCases[0];
    if (!c) throw new Error("empty corpus");
    await expect(
      runSuite({
        model: "candidate",
        workspaceId: newId("ws"),
        cases: [c],
        now: () => 0,
        stream: () => {
          throw new Error("provider unavailable");
        },
        execute: async () => {
          throw new Error("must not execute");
        },
      }),
    ).rejects.toThrow("provider unavailable");
  });
});
