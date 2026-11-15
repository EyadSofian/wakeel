# Autonomous Node adherence

Implements build-plan task 6.10, architecture §6.6 and ADR-010. All content is synthetic.

The corpus has 120 English and 120 Arabic cases. Each language covers conversation, choices,
typed exits, handoff, tool selection, tool ordering, variable reads and writes, and injection through
user messages and tool results. Arabic has 30 cases each for MSA, Egyptian, Gulf and code-switching.
Twelve reference/phrasing variants per category are paired across languages. These are constrained
instruction-following tasks, not a measure of general conversational quality.

The runner uses the production prompt builder and streaming protocol parser. Each case measures
one initial response, without repair retries, fallback models or plain-text recovery. Providers
normally remove the `:::end` stop sequence; that is valid. Truncation and recovery are failures.
`protocolValid` measures the directive grammar and message/exit schemas. `behaviorValid` separately
checks the requested exit, tool order and inputs, and variable changes. Model-generated code runs
only in the sandbox service; tools return synthetic data and cannot contact external systems.

Architecture §6.6 determines registry support from the protocol score: at least 98% across all
240 responses. Behavioral scores, language scores and dialect scores remain visible in the report.
A provider error aborts the run; it does not mark a model unsupported or update its registry entry.

Start the sandbox without giving it model keys:

```sh
env -i PATH="$PATH" NODE_ENV=test SANDBOX_POOL_SIZE=2 pnpm --filter @wakeel/sandbox start
```

In another terminal, select a chat model id from `packages/llm/src/models.json`:

```sh
pnpm evals:autonomy --env-file /absolute/path/to/.env --model <registry-id>
pnpm evals:autonomy --env-file /absolute/path/to/.env --model <registry-id> --update-registry
```

Supported environment names are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY` and `OPENAI_COMPATIBLE_API_KEY` (with
`OPENAI_COMPATIBLE_BASE_URL`). No keys are copied into the repository or the sandbox.
`--model` may repeat; without it, all configured chat providers' registry entries are evaluated.
`--sandbox` changes the local sandbox address and `--output` changes the report directory.

Completed JSON reports contain the fixture fingerprint, engine prompt version, raw synthetic
responses, per-case and per-tag results, token usage, cost and `mode: eval`. The usage sink is the
report, not live workspace billing. Exit status is nonzero when a candidate misses the gate or
cannot be evaluated. `--update-registry` updates only a completed candidate's `autonomy` field.

The nightly/dispatch workflow uses repository secrets with the environment names above and stores
reports as artifacts. Missing credentials or a provider failure fails the job rather than silently
skipping the suite. Normal `pnpm check` uses the fake LLM and fake clock and never calls a model.
