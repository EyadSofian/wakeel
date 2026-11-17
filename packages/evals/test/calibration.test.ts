import { JudgeCalibration } from "@wakeel/contracts";
import { expect, test } from "vitest";
import { GROUNDED_RUBRIC, judgeAgreement } from "../src/index";

/** ADR-056 G7: a judge's scores count only once it agrees with people on enough labelled cases. */

const item = (human: "pass" | "fail", text: string) => ({
  assertion: { type: "grounded" as const },
  replies: [{ type: "text", text, citationTitles: [] }],
  passages: [{ title: "hvac.md", text: "سعر دورة التكييف المركزي 5,000 جنيه." }],
  human,
});

test("agreement is the share of labelled cases where the judge's verdict matches the person's", async () => {
  const set = JudgeCalibration.parse({
    items: [item("pass", "سعرها 5,000 جنيه"), item("fail", "سعرها 4,000 جنيه"), item("fail", "مدتها شهرين")],
  });
  const asked: string[] = [];
  const report = await judgeAgreement(set, async ({ rubric, replies }) => {
    asked.push(rubric);
    // This judge wrongly passes the duration claim.
    return { passed: !(replies[0]?.text ?? "").includes("4,000"), reason: "checked" };
  });
  expect(asked).toEqual([GROUNDED_RUBRIC, GROUNDED_RUBRIC, GROUNDED_RUBRIC]);
  expect(report).toMatchObject({ labelled: 3, agreed: 2, agreement: 2 / 3, unavailable: 0 });
  expect(report.disagreements).toEqual([{ index: 2, human: "fail", judge: "pass", reason: "checked" }]);
  // Under the ADR-056 minimum of 50 labelled cases the judge's scores do not count yet.
  expect(report.trusted).toBe(false);
});

test("a judge that cannot answer counts against it, and 50 agreeing cases at 90% make it trusted", async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    assertion: { type: "judge" as const, rubric: "يذكر السعر" },
    replies: [{ type: "text", text: `${i}`, citationTitles: [] }],
    human: "pass" as const,
  }));
  const report = await judgeAgreement(JudgeCalibration.parse({ items }), async ({ replies }) => {
    if (replies[0]?.text === "0") throw new Error("eval_assertion_unavailable");
    return { passed: replies[0]?.text !== "1" };
  });
  expect(report).toMatchObject({ labelled: 50, agreed: 48, unavailable: 1, agreement: 0.96, trusted: true });
});
