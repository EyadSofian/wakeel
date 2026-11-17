# Runbook: the AI quality gate (ADR-056)

Every pull request that changes the AI layer needs a before/after gate report in its description.
The `ai-layer` workflow labels such PRs and fails until the report is there; a failing gate blocks
the merge, and a cost rise of more than 20% needs a maintainer's `cost-approved` label.

## 1. Measure both refs

```bash
pnpm evals:gate run --ref origin/main --out .gate/base --env-file model.env --env-file reranker.env --model gpt-6-luna --rewrite-model gpt-6-luna
```

```bash
pnpm evals:gate run --ref HEAD --out .gate/candidate --env-file model.env --env-file reranker.env --model gpt-6-luna --rewrite-model gpt-6-luna
```

Each run checks the ref out in a temporary worktree and runs the synthetic and realistic retrieval
sets and the adherence corpus (the adherence run needs the sandbox at `http://127.0.0.1:4300`).
A suite that cannot run is left out and shows as "not measured". A ref older than a suite (for
example `--set realistic` before task 8.9) cannot run it.

## 2. Add the bot suites

Bot suites run against a deployed draft or version, so they are exported, not run by the command:
save each run's detail (`GET /v1/workspaces/{ws}/bots/{bot}/evals/runs/{run}`) as
`.gate/<side>/bots/<suite>.json`, adding `"suite"` and `"model"` at the top level. Judge calibration
results (`judgeAgreement` from `@wakeel/evals`) go in `.gate/<side>/judge/<suite>.json` with `"suite"`.

G0 needs at least one bot suite run on the strongest model (`--strongest`, `gpt-6.1-sol` until the
Anthropic account has credits).

## 3. Compare and paste

```bash
pnpm evals:gate compare --base .gate/base --candidate .gate/candidate --out .gate/report.md
```

Paste the printed report into the PR description. The command exits non-zero when a gate fails.

## Known state (2026-11-17)

`gpt-6-luna` is at 92.1% protocol-valid (6.10), below G3's 98%, so G3 fails for it until a model
or prompt passes. That is a real failing baseline; do not edit cases or bars to pass it.
