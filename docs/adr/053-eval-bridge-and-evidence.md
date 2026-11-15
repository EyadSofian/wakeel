# ADR-053 — Eval Bridge access and turn evidence

Status: proposed · Date: 2026-11-15 · Task: 12.1

## Context

Architecture §14 requires cases to use Bridge in eval mode against a draft or a chosen version.
The existing Bridge connection can choose production or draft. Only the authenticated Studio
emulator path sets its own mode. A case also needs evidence for tool inputs, exits and variables.
Public traces redact secrets and omit table arguments. AWS or model credentials, raw trace
payloads and live customer data must stay out of the case results.

## Options

1. Add a trusted eval entry to the existing Bridge ingest and turn queue, and extract bounded
   evidence at the committed turn boundary.
2. Reuse the existing emulator session through HTTP. This loses eval accounting and version
   selection and couples the runner to a browser session.
3. Call the pure engine from the runner. This misses the Bridge acceptance contract and the
   production worker's turn behavior.

## Recommendation

Use option 1.

- Run only from workspace-authorized suite operations. Give each case run an isolated internal
  connection, end user and conversation namespace. Reuse Bridge message and event validation,
  inbound storage and queueing. The request body on the public Bridge route never controls mode
  or a version override.
- Resolve draft or explicit version at run creation and scope it to the suite's workspace and
  bot. Freeze the definition used by a run. A pinned eval version never follows a live publish.
- Tag all traffic and utility judging `eval`. Use the workspace utility model with a fixed judge
  instruction and pass the rubric and reply data as messages. Return a code for an unavailable
  judge. Any builder Code card or tool that can make an external side effect is blocked in an
  eval. Keep table writes blocked per ADR-048, and emit no external Bridge webhook for evals.
- Use committed messages, turn timing, exits, tool calls and permitted state as assertion
  evidence. Run assertions against in-scope evidence and store outcomes and links, not copies
  of variable data, secrets or tool arguments. An unavailable or redacted operand is reported
  as unavailable. Preserve the existing trace redaction and table trace omissions.
- Evaluate regular expressions through bounded sandbox execution. Treat invalid patterns and
  deadlines as errors. Tool order means the named calls occur in that order, even with other
  calls between them. For an unexpected reply on an `expectSilence` turn, store an explicit
  silence verdict alongside the assertion results.
- Persist suites, cases, runs and results with forced RLS and stable IDs. Store case snapshots on
  the run so edits cannot change a queued case. Use deterministic per-case turn idempotency
  keys. Link each result turn to its actual conversation and trace, including after a case
  starts a new conversation.

## Consequences

The real Bridge and worker are exercised without granting API callers an eval-mode override.
Cases needing side-effect code require an isolated fixture or an explicit future policy. Judge
calls can spend workspace model credits and remain excluded from Wakeel live consumption.
Running trusted fake providers with Arabic cases verifies mode, version pinning, idempotency
and expected assertion behavior before testing any real provider.
