# ADR-050 — Replay a recorded turn against the draft

Status: accepted (Eyad approved in writing on 2026-11-15) · Date: 2026-11-15 · Task: 10.4

## Context

The plan requires replay against the draft in emulator mode while protecting the live
conversation and requiring confirmation before running side-effect tools. Existing live turns
record their input events, but they do not snapshot pre-turn draft state, user variables or
provider responses. ADR-025 scopes emulator conversations to a builder's session. ADR-048
makes table writes unavailable in emulator and eval.

## Options

1. Start a new session-owned emulator conversation with the selected turn's recorded inputs.
   Use the draft's defaults and explicit side-effect confirmation.
2. Copy current live state into the draft. Live state can have advanced and can reference
   old workflow IDs, inapplicable secrets or obsolete variable schemas.
3. Run on the original conversation with output suppressed. This exposes live state and
   makes read-write isolation depend on replay sprinkling checks through the turn loop.

## Recommendation

Option 1 approved.

- Use a bot-scoped Studio POST selecting a live turn ID. Require both conversation read and
  permission to use the emulator. Validate that the turn belongs to the path bot and workspace.
  Copy its recorded message and event payloads in sequence. Reject workflow tool callbacks,
  unrecognized lifecycle inputs and turns with no supported recorded input.
- Start an isolated emulator conversation using the caller's emulator connection and draft
  definition. Bind an operator's replay request ID to the source turn and confirmation flag
  so retries reuse the same test conversation. Never move live conversation cursors, copy
  live credentials, enqueue live webhooks, or trace live state into the replay.
- Default to blocking code with possible side effects: autonomous tools flagged side-effectful
  and builder code that can call external systems. Give a distinct problem code and trace it.
  A deliberate confirmation on the replay request permits only the ordinary authorized code
  tool and code card behaviors within the existing sandbox and egress policy. Table writes
  remain blocked by ADR-048 in every replay. Never grant the autonomous guest any new tool.
- Expose an action on the stored turn in Studio that identifies the draft and describes the
  confirmation. Open the resulting emulator transcript and trace. Explain that a fresh draft
  run uses recorded inputs and can differ from the original output.

## Consequences

Replay results show how the current draft handles the recorded event group from its defaults.
This retains a useful replay for historical turns without claiming an exact state snapshot.
Live credentials, history and conversation counters stay isolated. Tests cover a second
workspace, unchanged live rows, replay retry, and the blocked and explicitly confirmed paths.
