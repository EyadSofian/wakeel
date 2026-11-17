# ADR-056 — Quality gates for every change to the AI layer

Status: proposed · Date: 2026-11-17 · Review: `docs/research/2026-11-17-ai-layer-review.md`

## Context

We have three ways to measure the AI layer, and none of them stops a change that makes answers worse:

- **Adherence corpus.** 240 cases (`packages/autonomy/evals`) measure whether replies follow the
  protocol. They do not check whether the answer is right.
- **Retrieval golden sets.** 240 questions (`packages/retrieval/evals`) over short synthetic FAQ
  passages. Hybrid search scores recall@5 = 1.0 on all four sets, so a retrieval regression on
  long pages, tables or follow-up questions would not show.
- **Bot eval suites** (Phase 12). The Majed acceptance suite is one. Its `judge` assertion fails on
  reasoning models because the judge gets `maxOutputTokens: 16` (`apps/worker/src/eval/run.ts:218`).

Nothing requires a before/after comparison when a prompt, model, retrieval stage or engine rule
changes. The Majed pilot shipped on the smallest model in the registry, and the strongest one was
never measured.

The sources behind this ADR agree on the method:

- The OpenAI agents guide: set up evals and get a baseline with the most capable model, then try
  smaller ones.
- The production stack reference: build a golden set first, and calibrate an LLM judge against
  human labels before trusting it.
- LangChain's evals philosophy: compare with and without the change on the same tasks, record
  outcome, cost and latency, and treat "one trial per profile" as an anecdote.

## Options

1. **Keep evals as reports only.** It costs nothing, and nothing changes.
2. **A gate report required for AI-layer changes, run on demand, with fixed thresholds that Eyad
   approves.** *(Recommended.)*
3. **Run the full gate on every PR in CI.** This measures the most, but every PR spends model money
   and waits about 15–30 minutes, including PRs that do not touch the AI layer.

## Recommendation

Use option 2.

### What counts as an AI-layer change

A PR is an AI-layer change if it touches any of:

- `packages/autonomy`, `packages/retrieval`, `packages/llm`;
- `packages/engine/src/cards/ai-*`, `packages/engine/src/cards/kb-search.ts`;
- `apps/worker/src/turn/autonomy.ts`, `apps/worker/src/kb/**`;
- the model registry;
- the instructions of a pilot bot.

A CI check labels such PRs `ai-layer`. A PR with the label cannot merge without a gate report in its
description: the before/after table produced by the command below.

### The gate command

`pnpm evals:gate --base <ref> --candidate <ref> [--model <id>] [--trials 3]` runs the same suites on
both refs. Every model call it makes is in eval mode (never billed or counted as live). The suites:

| Suite | What it measures | Exists? |
|---|---|---|
| Retrieval, synthetic | recall@5, MRR per dialect | yes (8.7) |
| Retrieval, realistic | recall@5, MRR per slice: long pages, tables, follow-ups (with the previous turn), unanswerable | **new**, below |
| Adherence | protocol-valid and behaviour-valid | yes (6.10) |
| Grounding | share of factual answers that cite a passage, faithfulness, correct "I don't know" | **new**, below |
| Bot acceptance | pass rate; critical cases | yes (12.1); Majed's is private |
| Latency and cost | p50/p95 time to first message and full reply; cost per reply | from traces and usage events |

The report goes to `packages/evals/reports/gate/<date>-<candidate sha>.md`, with:

- both refs, the model ids, the fixture hashes and the trial count;
- every metric with its delta.

A stochastic suite runs 3 trials and reports the mean and the worst trial.

### The bars (proposed; Eyad sets the final numbers)

| Gate | Bar |
|---|---|
| G0 Baseline | Each bot suite has a recorded run on the strongest model in the registry before a cheaper model is adopted for that bot |
| G1 Retrieval | Realistic set: recall@5 ≥ 0.90 on every slice. No slice of any set drops more than 2 points |
| G2 Grounding | ≥ 95% of factual answers cite a passage. Judged faithfulness ≥ 0.95. ≥ 90% correct "I don't know" on unanswerable questions |
| G3 Protocol | ≥ 98% protocol-valid (architecture §6.6, unchanged) |
| G4 Task success | 100% of critical cases, ≥ 90% of all cases, in every bot suite in the gate |
| G5 Latency | Turn with one search: first message p50 ≤ 3 s, p95 ≤ 8 s |
| G6 Cost | Cost per reply up by more than 20% needs Eyad's written approval in the PR |
| G7 Judge | Judge scores count only after ≥ 90% agreement with human labels on ≥ 50 cases of that suite |

A gate that fails blocks the merge. A real failing baseline stays failing; nobody edits labels or
removes cases to pass (the rule `packages/retrieval/evals/README.md` already states).

### Contract changes (`docs/04-contracts/eval.ts`)

- `EvalCase.critical: boolean` (default false), used by G4.
- A new assertion `{ type: "grounded" }`. The judge receives the turn's replies **and** the passages
  the turn retrieved, from the trace. It passes when every factual claim is supported by a passage,
  or when the reply says it does not know.
- The judge answers through structured output `{ verdict: "pass" | "fail", reason: string }` with
  an output budget sized for reasoning models, replacing the 16-token PASS/FAIL text. The
  token-limit bug is fixed first on its own, without waiting for this ADR.
- A calibration file per suite, holding cases with a human verdict. The gate reports judge–human
  agreement (G7).

### The realistic golden set

- It is written by hand, about a synthetic training company's course catalogue: 12 fictional courses
  in Arabic and English. Pages are 1,500–4,000 tokens, with price, schedule and instructor tables,
  installment rules, and an FAQ.
- 200 questions:
  - 50 single-turn;
  - 50 follow-ups that need the previous turn;
  - 40 table lookups;
  - 30 unanswerable;
  - 30 near-miss (another course's price).
- Every slice has MSA, Egyptian, Gulf and code-switched questions.
- Labels are fixed before any model runs. No model output is used as ground truth.
- No customer data. Engosoft's own pages may form a second, private, git-ignored set for the Majed
  pilot.

## Consequences

- AI-layer PRs get slower and cost money. A full gate on two refs with 3 trials is estimated at
  low single-digit dollars on `gpt-6-luna` and more on larger models. The real figure is recorded
  in the first report.
- CI needs model keys as repository secrets. CI currently has only an OpenAI key, for retrieval.
- New tasks:
  - **12.5** — gate command, report, `ai-layer` label check.
  - **12.6** — `critical`, `grounded`, structured judge, calibration file.
  - **8.8** — realistic golden set.
- Thresholds will move as we learn. Changing one is a one-line edit to this ADR with Eyad's approval.

## Questions for Eyad

1. Are the bars in the table right, especially G5 latency and G2 faithfulness?
2. Should the gate run automatically on PRs labelled `ai-layer`, or only on demand before merge
   (recommended while the cost is unknown)?
3. Which model is "strongest" for G0 today: `claude-opus-5-5` or `gpt-6.1-sol`? The Anthropic
   account needs credits for the first.
