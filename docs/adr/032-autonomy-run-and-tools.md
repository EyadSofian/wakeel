# ADR-032: The Autonomous Node's run block and its tools

Status: proposed
Date: 2026-11-14
Task: 6.6

## Context

Architecture §6.3 says the `:::run` block runs "in the sandbox with tools bridged", and §6.5 says tool
calls arrive as `tool_call` frames that the worker validates and executes. ADR-023 §3 reserved a
`toolManifest` on the exec frame for `autonomy_run` and said builder tools are not exposed to `code`
or `expressions`. Nothing yet said:

1. what the guest of an `autonomy_run` exec has in scope, how a builder tool call is named on the
   wire, or where `memo` writes go;
2. how a code tool runs, and whether a tool may write variables;
3. how the worker reads "the run block returned a value" when the sandbox reports `null` for both
   `return null` and no return;
4. what the stubs for knowledge base, table and workflow tools do until their phases.

## Decision

### 1. The `autonomy_run` guest

- The guest has the scopes as a Code card has them (`workflow`, `conversation`, `user`, `turn`
  writable; `bot`, `event`, `env` frozen), plus `memo`, writable and patched like the others.
- It has `tools`, frozen, with one member per tool on the node: a function for code, kb_search and
  workflow tools; an object of the allowed operations for a table tool. It has `log` and `ctx`.
- It has **nothing else**: no `fetch`, `axios`, `tables`, `kb`, `ai` or `say`. The model reaches the
  network and data only through tools the builder wrote (architecture §6.5 containment; CLAUDE.md §9
  "no implicit tools"). Messages come only from `:::say`.
- A call travels as a `tool_call` frame named `tool.<name>` or `tool.<name>.<operation>`. The prefix
  keeps builder names apart from the platform names of ADR-023 §3 even when a tool is called
  `tables`. The sandbox refuses any other name in an `autonomy_run`, so the manifest is enforced on
  both sides.

### 2. Tool calls in the worker

- The tool must be on the node. Input is validated against the tool's JSON Schema
  (`validateJson`) before anything runs (`tool_input_invalid`); output against its `output` schema
  when it has one (`tool_failed`).
- A code tool runs as its own `kind: "code"` exec with the node's scopes, its `timeoutMs`, and
  `const input = <the input as JSON>;` placed on the code's first line so error line numbers stay the
  builder's own.
- A tool **returns a value and does nothing else to the conversation**: variable writes and `say`
  calls made inside a tool are dropped with a warning log. Only the model's run block writes
  variables, through the node's `variableAccess` check, so there is one place where writes are
  validated.
- Failures reach the model's code as an `Error` with the `AppError` code and title, which it may catch;
  uncaught, they become the next iteration's `run_error` feedback.

### 3. "Returned a value"

`null` from the sandbox means "nothing to read back": the protocol's `return` rule (§6.2) applies to
non-null values. A model that wants another iteration returns something other than `null`.

### 4. Stubs until their phases

`kb_search` (Phase 8), `table` (Phase 9) and `workflow` tools fail with `tool_failed` and the message
"… is not available yet", so the model can tell the user instead of looping. Workflow tools, including
suspension and `submitToolResult` resume, are the rest of 6.6 and follow in their own PR.

### 5. Models and keys

- Model resolution is node → bot default → workspace default (§7). A `ModelRef` is `provider:id`; the
  registry is keyed by `id`.
- Keys come only from the workspace (BYOK); no plan offers platform keys before Phase 13.
- `gpt-4.1` and `gpt-4.1-mini` are added to the registry, `autonomy: "untested"` until 6.10 measures
  them. Their prices were taken from third-party copies of OpenAI's list and must be checked against
  OpenAI's pricing page before billing relies on them.

## Consequences

- The sandbox gains a third guest layer; the escape suite now covers it (tools frozen, no network,
  only listed calls accepted).
- A builder who wants a tool to change a variable returns the value and lets the node write it. This
  is stricter than a Code card, on purpose.
- Tool calls are not yet traced as `tool.call` spans; that is task 6.9.
