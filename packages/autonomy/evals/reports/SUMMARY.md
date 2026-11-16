# Adherence baseline — 2026-11-15

Production engine prompt version 1, 240 synthetic cases per candidate. Raw reports are in this
directory. The fixture fingerprint is recorded in each completed report. Model repair retries and
provider fallbacks are disabled. Both completed candidates miss architecture §6.6's 98% gate.

| Candidate | Protocol valid | English | Arabic | Behaviour valid | Registry |
|---|---|---|---|---|---|
| `gpt-4.1-mini` | 208/240 (86.67%) | 103/120 | 105/120 | 181/240 | unsupported |
| `gpt-4.1` | 198/240 (82.50%) | 99/120 | 99/120 | 174/240 | unsupported |
| `gpt-6-luna` (2026-11-16) | 221/240 (92.08%) | 107/120 | 114/120 | 212/240 | untested (registry not updated) |

The three Anthropic candidates could not be measured: the API returned HTTP 400 with
`invalid_request_error` and an insufficient-credit message. This does not establish whether those
model ids are available. Their reports explicitly record zero completed cases and `untested`; no
score was fabricated and no registry support decision was made. Their full suites remain blocked
until that provider account can serve requests.

## Findings

- Choice messages failed in all 24 cases for both completed candidates. The production prompt
  lists message type names but provides no choice-header example or option schema. A typical
  response used `:::say choice` followed by a Markdown list, which the contract correctly rejects
  because `options` must be JSON properties on the directive line.
- User-injection cases were protocol-valid in 20/24 cases for the smaller completed candidate and
  6/24 for the other. Containment still comes from the declared tools and schemas; syntactically
  valid directives do not prove the user request was followed.
- The behavioural score catches wrong exits, tool order, inputs and ungranted variable patches.
  It is deliberately reported separately from the normative protocol support gate.
- No tools contacted real external systems, and model-written code ran in the local sandbox
  service. All 480 successful model calls were recorded with `mode: eval` in their reports.

## What remains

The three Anthropic candidate runs are incomplete. CI workflow code is present, but its remote
execution and repository credential setup have not been verified. This is not a successful
Autonomous Node launch gate. Improve the existing prompt's message guidance, then rerun this same
corpus; adding a native-tool-calling protocol requires a separate proposed ADR and approval
(ADR-002 and build-plan Phase 6).

## 2026-11-16: gpt-6-luna

Same corpus and prompt version 1, run without `--update-registry`. 221/240 protocol-valid, below the
98% gate. By dialect: Gulf 30/30, Egyptian 28/30, MSA 28/30, code-switching 28/30. The weak spot is
again choices, at 10/24: 14 replies wrote options as plain strings (`{"options":["Track","Cancel"]}`).
PR #136 adds each message type's directive line to the node prompt. This corpus has not been re-run
since that change. Tool order behaviour is 15/24.

