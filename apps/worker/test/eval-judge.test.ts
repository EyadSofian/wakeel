import type { LlmClient } from "@wakeel/llm";
import { FakeLlm } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { JUDGE_MAX_OUTPUT_TOKENS, judgeReplies, parseVerdict } from "../src/eval/judge";

/**
 * The eval `judge` assertion (task 12.1). The Majed pilot ended 3 of 13 cases as
 * `eval_assertion_unavailable`: a reasoning model spent the 16-token cap on reasoning and returned
 * no verdict.
 */

const context = { workspaceId: "ws_01m7a256m0a13warwhczsjhx9b", mode: "eval" as const };

function judgeWith(reply: string) {
  const llm = new FakeLlm();
  llm.scriptText(reply);
  const verdict = judgeReplies(llm as unknown as LlmClient, {
    model: "openai:gpt-6-luna",
    rubric: "يرد بسعر الكورس من المصادر",
    replies: [{ type: "text", text: "سعر دورة التكييف 5,000 جنيه" }],
    context,
  });
  return { llm, verdict };
}

describe("judge", () => {
  test("leaves room for a reasoning model to think before it answers", async () => {
    const { llm, verdict } = judgeWith("PASS");
    await expect(verdict).resolves.toBe(true);
    const request = llm.calls[0]?.request as { maxOutputTokens: number; purpose: string };
    expect(request.purpose).toBe("judge");
    expect(request.maxOutputTokens).toBe(JUDGE_MAX_OUTPUT_TOKENS);
    expect(JUDGE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(1_024);
  });

  test("the rubric and the replies go to the model as data, not in the system text", async () => {
    const { llm, verdict } = judgeWith("FAIL");
    await expect(verdict).resolves.toBe(false);
    const request = llm.calls[0]?.request as { system: string; messages: { content: string }[] };
    expect(request.system).not.toContain("5,000");
    expect(request.messages[0]?.content).toContain("سعر دورة التكييف 5,000 جنيه");
  });

  test("no verdict is an unavailable assertion, never a pass or a fail", async () => {
    await expect(judgeWith("I think it mostly does").verdict).rejects.toMatchObject({
      code: "eval_assertion_unavailable",
    });
    await expect(judgeWith("").verdict).rejects.toMatchObject({ code: "eval_assertion_unavailable" });
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
