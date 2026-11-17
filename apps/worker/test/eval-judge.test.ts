import { ConversationState } from "@wakeel/contracts";
import type { LlmClient } from "@wakeel/llm";
import { FakeLlm } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { JUDGE_MAX_OUTPUT_TOKENS, judgeReplies, parseVerdict, turnPassages } from "../src/eval/judge";

/**
 * The eval `judge` and `grounded` assertions (tasks 12.1, 12.6). The Majed pilot ended 3 of 13 cases
 * as `eval_assertion_unavailable`: a reasoning model spent the 16-token cap on reasoning and returned
 * no verdict. ADR-056 adds a reason with every verdict and passages for `grounded`.
 */

const context = { workspaceId: "ws_01m7a256m0a13warwhczsjhx9b", mode: "eval" as const };
const PASSAGE = { title: "hvac.md", text: "سعر دورة التكييف المركزي 5,000 جنيه." };

function judgeWith(reply: string, passages?: { title: string; text: string }[]) {
  const llm = new FakeLlm();
  llm.scriptText(reply);
  const verdict = judgeReplies(llm as unknown as LlmClient, {
    model: "openai:gpt-6-luna",
    rubric: "يرد بسعر الكورس من المصادر",
    replies: [{ type: "text", text: "سعر دورة التكييف 5,000 جنيه" }],
    ...(passages ? { passages } : {}),
    context,
  });
  return { llm, verdict };
}

describe("judge", () => {
  test("leaves room for a reasoning model to think before it answers", async () => {
    const { llm, verdict } = judgeWith('{"verdict":"pass","reason":"The price is stated."}');
    await expect(verdict).resolves.toEqual({ passed: true, reason: "The price is stated." });
    const request = llm.calls[0]?.request as { maxOutputTokens: number; purpose: string };
    expect(request.purpose).toBe("judge");
    expect(request.maxOutputTokens).toBe(JUDGE_MAX_OUTPUT_TOKENS);
    expect(JUDGE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1_024);
  });

  test("asks for a verdict with a reason, and reads one wrapped in a code fence", async () => {
    const { llm, verdict } = judgeWith('```json\n{"verdict": "fail", "reason": "لم يذكر مدة التقسيط"}\n```');
    await expect(verdict).resolves.toEqual({ passed: false, reason: "لم يذكر مدة التقسيط" });
    const request = llm.calls[0]?.request as { system: string };
    expect(request.system).toContain('"verdict"');
  });

  test("a bare PASS or FAIL still counts, with no reason", async () => {
    await expect(judgeWith("PASS").verdict).resolves.toEqual({ passed: true });
    await expect(judgeWith("**FAIL**").verdict).resolves.toEqual({ passed: false });
  });

  test("the rubric, replies and passages go to the model as data, not in the system text", async () => {
    const { llm, verdict } = judgeWith('{"verdict":"pass","reason":"ok"}', [PASSAGE]);
    await verdict;
    const request = llm.calls[0]?.request as { system: string; messages: { content: string }[] };
    expect(request.system).not.toContain("5,000");
    expect(request.messages[0]?.content).toContain("سعر دورة التكييف 5,000 جنيه");
    expect(request.messages[0]?.content).toContain("سعر دورة التكييف المركزي 5,000 جنيه.");
  });

  test("no verdict is an unavailable assertion, never a pass or a fail", async () => {
    for (const reply of ["I think it mostly does", "", '{"verdict":"maybe"}', '{"reason":"no verdict"}']) {
      await expect(judgeWith(reply).verdict).rejects.toMatchObject({ code: "eval_assertion_unavailable" });
    }
  });
});

describe("parseVerdict", () => {
  test.each([
    ["PASS", true],
    ["FAIL", false],
    ["pass", true],
    ["PASS.", true],
    ["**FAIL**", false],
    [" FAIL\n", false],
  ])("%j reads as %s", (text, expected) => {
    expect(parseVerdict(text)).toBe(expected);
  });

  test.each(["", "PASS FAIL", "It passes", "FAILED", "PASSED", "1"])("%j has no verdict", (text) => {
    expect(parseVerdict(text)).toBeUndefined();
  });
});

describe("turnPassages", () => {
  const turnId = "turn_01m7a256m0a13warwhczsjhx9b";
  const source = (title: string, snippet: string) => ({
    documentId: "doc_01m7a256m0a13warwhczsjhx9b",
    chunkId: "chk_01m7a256m0a13warwhczsjhx9b",
    title,
    snippet,
  });

  test("the automatic search's whole passages, then every other cited source's snippet, each once", () => {
    const state = ConversationState.parse({
      v: 1,
      status: "waiting_input",
      autonomy: {
        node_Advisor000: {
          knowledge: {
            turnId,
            query: "سعر دورة التكييف",
            passages: [{ token: "[[c1]]", title: "hvac.md", text: "سعر دورة التكييف المركزي 5,000 جنيه." }],
          },
        },
        node_Older00000: {
          knowledge: {
            turnId: "turn_01m7a256m0a13warwhczsjhx9c",
            query: "قديم",
            passages: [{ token: "[[c1]]", title: "old.md", text: "من دور سابق" }],
          },
        },
      },
      retrievalCitations: {
        next: 3,
        sources: { c1: source("hvac.md", "سعر دورة التكييف…"), c2: source("faq.md", "التقسيط على 3 شهور") },
      },
    });
    expect(turnPassages(state, turnId)).toEqual([
      { title: "hvac.md", text: "سعر دورة التكييف المركزي 5,000 جنيه." },
      { title: "faq.md", text: "التقسيط على 3 شهور" },
    ]);
  });

  test("a turn that searched nothing has no passages", () => {
    expect(turnPassages(ConversationState.parse({ v: 1, status: "idle" }), turnId)).toEqual([]);
  });
});
