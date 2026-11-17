import type { JudgeCalibration } from "@wakeel/contracts";
import { type AssertionPorts, GROUNDED_RUBRIC } from "./assertions";

/** ADR-056 G7: the judge's scores count only at this agreement over at least this many labels. */
export const JUDGE_MIN_AGREEMENT = 0.9;
export const JUDGE_MIN_LABELLED = 50;

export interface JudgeAgreement {
  labelled: number;
  agreed: number;
  /** Cases the judge could not answer; they count as disagreements. */
  unavailable: number;
  agreement: number;
  trusted: boolean;
  disagreements: { index: number; human: "pass" | "fail"; judge: "pass" | "fail" | "unavailable"; reason?: string }[];
}

/**
 * Runs the judge on every labelled case and compares it with the person's verdict. A case the judge
 * cannot answer counts against it: an unreliable judge must not look reliable by skipping cases.
 */
export async function judgeAgreement(set: JudgeCalibration, judge: AssertionPorts["judge"]): Promise<JudgeAgreement> {
  const disagreements: JudgeAgreement["disagreements"] = [];
  let agreed = 0;
  let unavailable = 0;
  for (const [index, item] of set.items.entries()) {
    const rubric = item.assertion.type === "grounded" ? GROUNDED_RUBRIC : item.assertion.rubric;
    let verdict: "pass" | "fail" | "unavailable";
    let reason: string | undefined;
    try {
      const answer = await judge({
        rubric,
        replies: item.replies,
        ...(item.assertion.type === "grounded" ? { passages: item.passages } : {}),
      });
      verdict = answer.passed ? "pass" : "fail";
      reason = answer.reason;
    } catch {
      verdict = "unavailable";
      unavailable++;
    }
    if (verdict === item.human) agreed++;
    else disagreements.push({ index, human: item.human, judge: verdict, ...(reason ? { reason } : {}) });
  }
  const labelled = set.items.length;
  const agreement = labelled === 0 ? 0 : agreed / labelled;
  return {
    labelled,
    agreed,
    unavailable,
    agreement,
    trusted: labelled >= JUDGE_MIN_LABELLED && agreement >= JUDGE_MIN_AGREEMENT,
    disagreements,
  };
}
