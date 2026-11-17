import type { EvalResult } from "@wakeel/contracts";
import type { JudgeAgreement } from "./calibration";

/**
 * The quality gate (ADR-056, task 12.5): the same suites run on the base and the candidate ref, and
 * this compares their reports against the bars Eyad accepted. A suite that did not run is "not
 * measured", never passed; a failing gate blocks the merge; a cost rise needs written approval.
 */

export const GATE_BARS = {
  realisticRecallAt5: 0.9,
  maxRetrievalDrop: 0.02,
  groundedPassRate: 0.95,
  refusalPassRate: 0.9,
  protocolValid: 0.98,
  casePassRate: 0.9,
  firstMessageP50Ms: 3_000,
  firstMessageP95Ms: 8_000,
  costIncrease: 0.2,
} as const;

/** The synthetic retrieval report (8.7), as `pnpm evals:retrieval` writes it. */
export interface SyntheticRetrieval {
  sets: { locale: string; hybrid: { recallAt5: number; mrr: number } }[];
}
/** The realistic retrieval report (8.9). */
export interface RealisticRetrieval {
  slices: { slice: string; count: number; hybrid: { recallAt5: number; mrr: number } }[];
}
/** One model's adherence report (6.10). */
export interface Adherence {
  model: string;
  summary: { total: number; protocolValid: number };
}
/** One bot suite run, as the API's run detail returns it, with the model it ran on. */
export interface BotRun {
  suite: string;
  model?: string;
  cases: { id: string; name: string; critical: boolean; tags: string[] }[];
  results: { caseId: string; result: EvalResult }[];
}

export interface GateSide {
  synthetic?: SyntheticRetrieval;
  realistic?: RealisticRetrieval;
  adherence?: Adherence[];
  bots?: BotRun[];
  judge?: (JudgeAgreement & { suite: string })[];
}

export type GateStatus = "pass" | "fail" | "needs_approval" | "not_measured";

export interface GateResult {
  id: string;
  name: string;
  status: GateStatus;
  base: string;
  candidate: string;
  bar: string;
  detail: string;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ms = (n: number) => `${Math.round(n)} ms`;
const NONE = "—";

function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const turnsOf = (runs: readonly BotRun[] | undefined) =>
  (runs ?? []).flatMap((r) => r.results.flatMap((x) => x.result.turns));

function grounded(runs: readonly BotRun[] | undefined) {
  const checks = turnsOf(runs).flatMap((t) => t.assertions.filter((a) => a.assertion.type === "grounded"));
  return checks.length === 0 ? undefined : checks.filter((a) => a.passed).length / checks.length;
}

function refusals(runs: readonly BotRun[] | undefined) {
  const results = (runs ?? []).flatMap((r) =>
    r.results.filter((x) => r.cases.find((c) => c.id === x.caseId)?.tags.includes("unanswerable")),
  );
  return results.length === 0 ? undefined : results.filter((x) => x.result.status === "passed").length / results.length;
}

function costPerReply(runs: readonly BotRun[] | undefined) {
  const costs = turnsOf(runs).flatMap((t) => (t.costMicroUsd === undefined ? [] : [t.costMicroUsd]));
  return costs.length === 0 ? undefined : costs.reduce((a, b) => a + b, 0) / costs.length;
}

function firstMessages(runs: readonly BotRun[] | undefined) {
  return turnsOf(runs).flatMap((t) => (t.firstMessageMs === undefined ? [] : [t.firstMessageMs]));
}

function retrievalGate(base: GateSide, candidate: GateSide): GateResult {
  const gate = {
    id: "G1",
    name: "Retrieval",
    bar: `realistic ≥ ${pct(GATE_BARS.realisticRecallAt5)} per slice; no drop > ${GATE_BARS.maxRetrievalDrop * 100} pts`,
  };
  if (!candidate.synthetic && !candidate.realistic)
    return { ...gate, status: "not_measured", base: NONE, candidate: NONE, detail: "no retrieval report" };
  const problems: string[] = [];
  for (const s of candidate.realistic?.slices ?? [])
    if (s.hybrid.recallAt5 < GATE_BARS.realisticRecallAt5)
      problems.push(`realistic ${s.slice} recall@5 ${pct(s.hybrid.recallAt5)}`);
  const groups = [
    ...(candidate.synthetic?.sets ?? []).map((s) => ({
      name: `synthetic ${s.locale}`,
      now: s.hybrid.recallAt5,
      was: base.synthetic?.sets.find((b) => b.locale === s.locale)?.hybrid.recallAt5,
    })),
    ...(candidate.realistic?.slices ?? []).map((s) => ({
      name: `realistic ${s.slice}`,
      now: s.hybrid.recallAt5,
      was: base.realistic?.slices.find((b) => b.slice === s.slice)?.hybrid.recallAt5,
    })),
  ];
  for (const g of groups)
    if (g.was !== undefined && g.now < g.was - GATE_BARS.maxRetrievalDrop)
      problems.push(`${g.name} dropped ${pct(g.was)} → ${pct(g.now)}`);
  const lowest = (side: GateSide) => {
    const all = [
      ...(side.synthetic?.sets ?? []).map((s) => s.hybrid.recallAt5),
      ...(side.realistic?.slices ?? []).map((s) => s.hybrid.recallAt5),
    ];
    return all.length === 0 ? NONE : `lowest ${pct(Math.min(...all))}`;
  };
  return {
    ...gate,
    status: problems.length ? "fail" : "pass",
    base: lowest(base),
    candidate: lowest(candidate),
    detail: problems.join("; ") || "every slice meets the bar",
  };
}

/**
 * Compares the base and candidate sides. `strongestModel` is G0's reference: every bot suite needs a
 * recorded run on it before a cheaper model is adopted (ADR-056).
 */
export function gateReport(base: GateSide, candidate: GateSide, options: { strongestModel: string }) {
  const judgeTrusted = candidate.judge?.length ? candidate.judge.every((j) => j.trusted) : undefined;
  const provisional = judgeTrusted === false ? " (judge not calibrated: provisional)" : "";
  const gates: GateResult[] = [];

  const strongestRuns = (candidate.bots ?? []).filter((b) => b.model === options.strongestModel);
  gates.push({
    id: "G0",
    name: "Strongest-model baseline",
    bar: `a run on ${options.strongestModel}`,
    base: NONE,
    candidate: strongestRuns.length ? strongestRuns.map((b) => b.suite).join(", ") : NONE,
    status: strongestRuns.length ? "pass" : "not_measured",
    detail: strongestRuns.length ? "recorded" : `no bot suite ran on ${options.strongestModel}`,
  });

  gates.push(retrievalGate(base, candidate));

  const g = grounded(candidate.bots);
  const r = refusals(candidate.bots);
  const baseGrounded = grounded(base.bots);
  const groundedProblems = [
    ...(g !== undefined && g < GATE_BARS.groundedPassRate ? [`grounded ${pct(g)}`] : []),
    ...(r !== undefined && r < GATE_BARS.refusalPassRate ? [`refusals ${pct(r)}`] : []),
  ];
  gates.push({
    id: "G2",
    name: "Grounding",
    bar: `grounded ≥ ${pct(GATE_BARS.groundedPassRate)}; refusals ≥ ${pct(GATE_BARS.refusalPassRate)}`,
    base: baseGrounded === undefined ? NONE : pct(baseGrounded),
    candidate: g === undefined ? NONE : `${pct(g)}${r === undefined ? "" : `, refusals ${pct(r)}`}`,
    status: g === undefined && r === undefined ? "not_measured" : groundedProblems.length ? "fail" : "pass",
    detail:
      g === undefined && r === undefined
        ? "no grounded checks or unanswerable cases"
        : `${groundedProblems.join("; ") || "meets the bar"}${provisional}; cited share not measured yet`,
  });

  const adherence = candidate.adherence ?? [];
  const rate = (a: Adherence) => `${a.model} ${pct(a.summary.protocolValid / a.summary.total)}`;
  const loose = adherence.filter((a) => a.summary.protocolValid / a.summary.total < GATE_BARS.protocolValid);
  gates.push({
    id: "G3",
    name: "Protocol",
    bar: `≥ ${pct(GATE_BARS.protocolValid)} protocol-valid`,
    base: (base.adherence ?? []).map(rate).join(", ") || NONE,
    candidate: adherence.map(rate).join(", ") || NONE,
    status: adherence.length === 0 ? "not_measured" : loose.length ? "fail" : "pass",
    detail: loose.length
      ? `below the bar: ${loose.map(rate).join(", ")}`
      : adherence.length
        ? "meets the bar"
        : "no adherence report",
  });

  const bots = candidate.bots ?? [];
  const share = (run: BotRun) =>
    run.results.filter((x) => x.result.status === "passed").length / Math.max(1, run.results.length);
  const taskProblems = bots.flatMap((run) => [
    ...run.cases
      .filter((c) => c.critical && run.results.find((x) => x.caseId === c.id)?.result.status !== "passed")
      .map((c) => `${run.suite}: critical case "${c.name}" failed`),
    ...(share(run) < GATE_BARS.casePassRate ? [`${run.suite}: ${pct(share(run))} of cases passed`] : []),
  ]);
  const passRate = (side: GateSide) =>
    side.bots?.length ? side.bots.map((b) => `${b.suite} ${pct(share(b))}`).join(", ") : NONE;
  gates.push({
    id: "G4",
    name: "Task success",
    bar: `every critical case; ≥ ${pct(GATE_BARS.casePassRate)} of cases`,
    base: passRate(base),
    candidate: passRate(candidate),
    status: bots.length === 0 ? "not_measured" : taskProblems.length ? "fail" : "pass",
    detail: `${taskProblems.join("; ") || (bots.length ? "meets the bar" : "no bot suite")}${bots.length ? provisional : ""}`,
  });

  const first = firstMessages(candidate.bots);
  const p50 = percentile(first, 50);
  const p95 = percentile(first, 95);
  const baseFirst = firstMessages(base.bots);
  const baseP50 = percentile(baseFirst, 50);
  const baseP95 = percentile(baseFirst, 95);
  const slow =
    p50 !== undefined && p95 !== undefined && (p50 > GATE_BARS.firstMessageP50Ms || p95 > GATE_BARS.firstMessageP95Ms);
  gates.push({
    id: "G5",
    name: "Latency",
    bar: `first message p50 ≤ ${ms(GATE_BARS.firstMessageP50Ms)}, p95 ≤ ${ms(GATE_BARS.firstMessageP95Ms)}`,
    base: baseP50 === undefined || baseP95 === undefined ? NONE : `p50 ${ms(baseP50)}, p95 ${ms(baseP95)}`,
    candidate: p50 === undefined || p95 === undefined ? NONE : `p50 ${ms(p50)}, p95 ${ms(p95)}`,
    status: p50 === undefined ? "not_measured" : slow ? "fail" : "pass",
    detail: p50 === undefined ? "no timed turns" : `${first.length} turns`,
  });

  const before = costPerReply(base.bots);
  const after = costPerReply(candidate.bots);
  const rise = before !== undefined && after !== undefined && before > 0 ? after / before - 1 : undefined;
  gates.push({
    id: "G6",
    name: "Cost per reply",
    bar: `rise ≤ ${pct(GATE_BARS.costIncrease)} without written approval`,
    base: before === undefined ? NONE : `$${(before / 1e6).toFixed(5)}`,
    candidate: after === undefined ? NONE : `$${(after / 1e6).toFixed(5)}`,
    status: rise === undefined ? "not_measured" : rise > GATE_BARS.costIncrease ? "needs_approval" : "pass",
    detail: rise === undefined ? "needs both sides" : `${rise >= 0 ? "+" : ""}${pct(rise)}`,
  });

  const judges = candidate.judge ?? [];
  const agreement = (side: GateSide) =>
    (side.judge ?? []).map((j) => `${j.suite} ${pct(j.agreement)} of ${j.labelled}`).join(", ") || NONE;
  gates.push({
    id: "G7",
    name: "Judge calibration",
    bar: "≥ 90% agreement on ≥ 50 labelled cases",
    base: agreement(base),
    candidate: agreement(candidate),
    status: judges.length === 0 ? "not_measured" : judgeTrusted ? "pass" : "fail",
    detail: judges.length === 0 ? "no calibration set" : judgeTrusted ? "trusted" : "judge scores are provisional",
  });

  const words: Record<GateStatus, string> = {
    pass: "pass",
    fail: "**fail**",
    needs_approval: "**needs approval**",
    not_measured: "not measured",
  };
  const markdown = [
    "| Gate | Base | Candidate | Bar | Result |",
    "| --- | --- | --- | --- | --- |",
    ...gates.map(
      (x) => `| ${x.id} ${x.name} | ${x.base} | ${x.candidate} | ${x.bar} | ${words[x.status]}: ${x.detail} |`,
    ),
  ].join("\n");

  return {
    gates,
    passed: gates.every((x) => x.status !== "fail"),
    needsApproval: gates.some((x) => x.status === "needs_approval"),
    markdown,
  };
}
