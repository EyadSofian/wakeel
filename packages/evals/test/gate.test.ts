import type { EvalResult } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { type BotRun, type GateSide, gateReport } from "../src/index";

/** ADR-056: the before/after gate every AI-layer change must pass. */

const STRONGEST = "gpt-6.1-sol";

function botRun(options: {
  model?: string;
  cases: {
    name: string;
    critical?: boolean;
    tags?: string[];
    passed: boolean;
    grounded?: boolean;
    firstMs?: number;
    cost?: number;
  }[];
}): BotRun {
  return {
    suite: "Majed acceptance",
    ...(options.model ? { model: options.model } : {}),
    cases: options.cases.map((c, i) => ({
      id: `case-${i}`,
      name: c.name,
      critical: c.critical ?? false,
      tags: c.tags ?? [],
    })),
    results: options.cases.map((c, i) => ({
      caseId: `case-${i}`,
      result: {
        status: c.passed ? "passed" : "failed",
        durationMs: 1000,
        turns: [
          {
            index: 0,
            assertions: [
              { assertion: { type: "contains", text: "x" }, passed: c.passed },
              ...(c.grounded === undefined ? [] : [{ assertion: { type: "grounded" as const }, passed: c.grounded }]),
            ],
            ...(c.firstMs !== undefined ? { firstMessageMs: c.firstMs, latencyMs: c.firstMs + 500 } : {}),
            ...(c.cost !== undefined ? { costMicroUsd: c.cost } : {}),
          },
        ],
      } as EvalResult,
    })),
  };
}

const realistic = (recall: number) => ({
  slices: ["single", "follow-up", "table", "near-miss"].map((slice) => ({
    slice,
    count: 40,
    hybrid: { recallAt5: recall, mrr: 0.8 },
  })),
});
const synthetic = (recall: number) => ({
  sets: ["msa", "egyptian", "gulf", "code-switched"].map((locale) => ({
    locale,
    hybrid: { recallAt5: recall, mrr: 0.9 },
  })),
});
const judge = (agreement: number, labelled = 60) => ({
  suite: "Majed acceptance",
  labelled,
  agreed: Math.round(agreement * labelled),
  unavailable: 0,
  agreement,
  trusted: labelled >= 50 && agreement >= 0.9,
  disagreements: [],
});

const good = (cost = 1000): GateSide => ({
  synthetic: synthetic(1),
  realistic: realistic(0.95),
  adherence: [{ model: "gpt-6-luna", summary: { total: 240, protocolValid: 238 } }],
  bots: [
    botRun({
      model: STRONGEST,
      cases: Array.from({ length: 10 }, (_, i) => ({
        name: `case ${i}`,
        critical: i < 2,
        tags: i === 9 ? ["unanswerable"] : [],
        passed: true,
        grounded: true,
        firstMs: 1500 + i * 100,
        cost,
      })),
    }),
  ],
  judge: [judge(0.94)],
});

const status = (report: ReturnType<typeof gateReport>, id: string) => report.gates.find((g) => g.id === id)?.status;

describe("gateReport", () => {
  test("a candidate that meets every bar passes, and the report is a table a reviewer can paste", () => {
    const report = gateReport(good(), good(), { strongestModel: STRONGEST });
    expect(report.gates.map((g) => [g.id, g.status])).toEqual([
      ["G0", "pass"],
      ["G1", "pass"],
      ["G2", "pass"],
      ["G3", "pass"],
      ["G4", "pass"],
      ["G5", "pass"],
      ["G6", "pass"],
      ["G7", "pass"],
    ]);
    expect(report.passed).toBe(true);
    expect(report.markdown).toContain("| Gate | Base | Candidate | Bar | Result |");
    expect(report.markdown).toContain("| G1 Retrieval |");
  });

  test("G1 fails a realistic slice under 0.90, and any slice that drops more than 2 points", () => {
    const low = { ...good(), realistic: realistic(0.85) };
    expect(status(gateReport(good(), low, { strongestModel: STRONGEST }), "G1")).toBe("fail");
    const dropped = { ...good(), synthetic: synthetic(0.97) };
    const report = gateReport(good(), dropped, { strongestModel: STRONGEST });
    expect(status(report, "G1")).toBe("fail");
    expect(report.gates.find((g) => g.id === "G1")?.detail).toContain("egyptian");
    expect(report.passed).toBe(false);
  });

  test("G2 fails when grounded checks or refusals fall under their bars", () => {
    const ungrounded = good();
    ungrounded.bots = [
      botRun({
        model: STRONGEST,
        cases: Array.from({ length: 10 }, (_, i) => ({
          name: `c${i}`,
          passed: true,
          grounded: i !== 0,
          firstMs: 1000,
          cost: 1,
        })),
      }),
    ];
    expect(status(gateReport(good(), ungrounded, { strongestModel: STRONGEST }), "G2")).toBe("fail");
  });

  test("G3 fails a model under 98% protocol-valid", () => {
    const loose = { ...good(), adherence: [{ model: "gpt-6-luna", summary: { total: 240, protocolValid: 221 } }] };
    expect(status(gateReport(good(), loose, { strongestModel: STRONGEST }), "G3")).toBe("fail");
  });

  test("G4 fails a failed critical case even when 90% of cases pass", () => {
    const side = good();
    side.bots = [
      botRun({
        model: STRONGEST,
        cases: Array.from({ length: 10 }, (_, i) => ({
          name: `c${i}`,
          critical: i === 0,
          passed: i !== 0,
          firstMs: 1000,
          cost: 1,
        })),
      }),
    ];
    const report = gateReport(good(), side, { strongestModel: STRONGEST });
    expect(status(report, "G4")).toBe("fail");
    expect(report.gates.find((g) => g.id === "G4")?.detail).toContain("c0");
  });

  test("G5 fails when the first message is slow at p95", () => {
    const slow = good();
    slow.bots = [
      botRun({
        model: STRONGEST,
        cases: Array.from({ length: 20 }, (_, i) => ({
          name: `c${i}`,
          passed: true,
          firstMs: i >= 18 ? 30_000 : 2000,
          cost: 1,
        })),
      }),
    ];
    expect(status(gateReport(good(), slow, { strongestModel: STRONGEST }), "G5")).toBe("fail");
  });

  test("G6 asks for approval when the cost per reply rises more than 20%, and nothing else blocks", () => {
    const report = gateReport(good(1000), good(1300), { strongestModel: STRONGEST });
    expect(status(report, "G6")).toBe("needs_approval");
    expect(report.passed).toBe(true);
    expect(report.needsApproval).toBe(true);
  });

  test("G0 says when no bot suite ran on the strongest model, and G7 when the judge is not calibrated", () => {
    const side = good();
    side.bots = side.bots?.map((b) => ({ ...b, model: "gpt-6-luna" }));
    side.judge = [judge(0.8)];
    const report = gateReport(good(), side, { strongestModel: STRONGEST });
    expect(status(report, "G0")).toBe("not_measured");
    expect(status(report, "G7")).toBe("fail");
    // Judge-based results are still shown, marked as provisional.
    expect(report.gates.find((g) => g.id === "G2")?.detail).toContain("judge not calibrated");
  });

  test("a suite that did not run is not measured, never passed", () => {
    const report = gateReport({}, {}, { strongestModel: STRONGEST });
    expect(report.gates.every((g) => g.status === "not_measured")).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.markdown).toContain("not measured");
  });
});
