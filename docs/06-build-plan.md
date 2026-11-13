# 06 — Build plan

Phases 0 → 15. Each task is sized for one executor session (a few hours of focused work, one reviewable PR). Do tasks in order within a phase; phases are sequential unless a task says "parallel-safe".

Read before starting any task: `CLAUDE.md`, the sections of `03-architecture.md` the task cites, and the contract files it touches.

**HUMAN REVIEW REQUIRED** (marked 🔒) means: open the PR, stop, and wait for Eyad's explicit approval before merging or building on top of it. These are sandbox, tenant isolation, auth, API keys, signing and encryption tasks.

## Definition of Done (applies to every task)

1. `pnpm check` passes: typecheck, lint, unit and integration tests, contract tests.
2. New behaviour has tests at the level named in the task. Bug fixes add a failing test first.
3. Anything visible went through the screenshot review loop (`05-design-system.md` §8) and the review file is committed.
4. Errors use codes from `errors.ts`; no hard-coded error sentences.
5. Every new tenant table has RLS in the same migration and a two-tenant test.
6. No `TODO`, no skipped test, no `any` without a comment explaining why.
7. Docs touched by the change are updated; a deviation from `/docs` has an ADR (proposed) and was not merged without approval.
8. The PR description lists what was built, how it was verified (commands and results), and what was not done.

## Test levels

- **Unit** (Vitest): pure logic; no network, no database.
- **Integration** (Vitest + Testcontainers): real Postgres with pgvector, real Redis, MinIO; fake LLM and fake clock from `packages/testing`.
- **E2E** (Playwright): Studio against a running stack with seeded data and the fake LLM.
- **Evals** (custom runner): model-in-the-loop suites; run nightly and on changes to `packages/autonomy` or `packages/retrieval`, not on every PR.

---

## Phase 0 — Foundations

**Goal:** a repo where every later task can start with `pnpm dev` and finish with `pnpm check`.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 0.1 | Monorepo scaffold: pnpm workspaces, turbo, TypeScript strict base config, Biome, Vitest, commit hooks | `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `biome.json` | `pnpm check` runs and passes on an empty workspace; CI workflow runs it |
| 0.2 | `packages/contracts`: copy `docs/04-contracts/*.ts`, add `ids.ts` (`newId`, `newElementId`), JSON-schema subset validator, OpenAPI ↔ zod agreement test | `packages/contracts/**` | Unit: smoke fixtures parse; negative cases rejected; agreement test passes; ULID and nanoid formats match the regexes |
| 0.3 | `packages/config`: env schema, limits, brand; fail-fast messages | `packages/config/**` | Unit: missing variable error names the variable |
| 0.4 | Local infra: docker-compose with Postgres 17 + pgvector, Redis 7, MinIO; `pnpm dev:infra` | `docker-compose.yml`, `infra/postgres/init.sql` | `pnpm dev:infra` brings services up healthy; `create extension vector` succeeds |
| 0.5 🔒 | `packages/db`: migration runner (plain SQL files, checksummed), roles `app_migrator` / `app_rw` / `app_admin_ro`, `withWorkspace`, RLS policy helper, lint rule banning the raw pool, test harness (two tenants) | `packages/db/**`, `tools/lint-rules/no-raw-pool.ts` | Integration: a table created by the test with the standard policy is invisible to the other tenant and to a connection with no workspace set; migration test asserts every table with `workspace_id` has forced RLS |
| 0.6 | `packages/testing`: fake LLM (scripted streams), fake clock, factories, RTL fixtures | `packages/testing/**` | Unit: scripted stream yields chunks with controllable timing |
| 0.7 | `packages/ui` tokens: `tokens.css` (light and dark), Tailwind 4 theme, `motion.ts`, fonts, lint rule banning raw colours and arbitrary values, contrast checker | `packages/ui/src/tokens.css`, `motion.ts`, `tools/lint-rules/tokens-only.ts`, `tools/contrast.ts` | `pnpm ui:contrast` passes; lint fails on a file containing `#fff` or `p-[7px]` |
| 0.8 | `apps/studio` shell + `/__gallery` route + screenshot tooling (`studio:shots`, `studio:motion`) with one sample screen | `apps/studio/**` | `pnpm studio:shots` writes light and dark PNGs for the gallery; first design review file committed |
| 0.9 | `apps/api` and `apps/worker` skeletons: Fastify with problem+json error handler, request ids, health endpoints; BullMQ wiring; structured logging | `apps/api/**`, `apps/worker/**` | Integration: unknown route returns a `not_found` problem; a thrown zod error returns `validation_failed` with paths |
| 0.10 | `THIRD_PARTY_NOTICES.md` and licence check script (fails CI on GPL/AGPL/SSPL/FSL/unknown) | `THIRD_PARTY_NOTICES.md`, `tools/licences.ts` | CI job passes; adding a fake AGPL dependency fails it |

**Risks:** tooling churn (pin versions in 0.1); over-building the shell (0.8 is a frame, not screens).

---

## Phase 1 — Tenancy, auth, roles, keys 🔒

**Goal:** people can sign in, belong to workspaces with roles, and create API keys; every action is audited.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 1.1 🔒 | Schema: `users, sessions, workspaces, memberships, invitations, api_keys, workspace_secrets, audit_log` with RLS and `security definer` lookup functions | `packages/db/migrations/0002_platform.sql`, repositories | Integration: two-tenant tests for every table; lookup functions return ids only |
| 1.2 🔒 | Sessions and password auth via better-auth; cookie settings; CSRF on mutations; rate limit on sign-in | `packages/auth/**`, `apps/api/src/routes/auth/*` | Integration: sign up, sign in, sign out; cookie flags asserted; 6th failed sign-in in a minute is `rate_limited`; mutation without CSRF header is rejected |
| 1.3 🔒 | RBAC: permission matrix (`owner, admin, builder, viewer`) as data; `requirePermission` guard; workspace switcher API | `packages/auth/src/rbac.ts`, guards | Unit: matrix table test for every permission × role; Integration: viewer cannot mutate a bot |
| 1.4 🔒 | API keys: create (shown once), list, revoke; hash at rest; prefix lookup; scopes; last-used | `packages/auth/src/keys.ts`, routes | Integration: key works; revoked key is `unauthenticated`; only the hash is in the database; a key from workspace A cannot read workspace B |
| 1.5 🔒 | Envelope encryption helper (`MASTER_KEY`, per-row data key, `key_version`), used by `workspace_secrets` | `packages/db/src/crypto.ts` | Unit: round-trip; wrong key fails; rotation re-wraps without changing plaintext |
| 1.6 | Audit log writer and API | `packages/telemetry/src/audit.ts`, route | Integration: every mutation route in this phase writes one entry |
| 1.7 | Studio: sign-in, workspace home (bots table, empty), settings → General, Members, API keys | `apps/studio/src/routes/**` | E2E: invite a member, change role, create and revoke a key; screenshot review for 4 screens |

**DoD addition:** an auth threat checklist (`docs/security/auth-checklist.md`) is filled in and reviewed.
**Risks:** auth library API drift (read its current docs); CSRF and cookie settings behind a proxy.

---

## Phase 2 — Bot definitions and the canvas

**Goal:** a builder can create a bot, lay out workflows, nodes, cards and transitions, and everything autosaves and validates. Nothing runs yet.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 2.1 | Schema and API: `bots`, `bot_draft_docs`; CRUD; document `GET/PUT` with `ETag` / `If-Match`; new bot seeds a Main workflow with Start and one Autonomous node | `packages/db/migrations/0003_bots.sql`, `apps/api/src/routes/bots/*` | Integration: stale `If-Match` returns `revision_conflict` with the server copy; two-tenant tests |
| 2.2 | `validateDefinition` (all rules in architecture §3.1) on top of `checkWorkflowStructure`; runs in Node and in a web worker | `packages/contracts/src/validate/**` | Unit: one passing and one failing fixture per rule; messages and fixes come from a table |
| 2.3 | Canvas store: document model, commands, undo/redo, selection, dirty tracking, debounced saver with conflict handling | `apps/studio/src/canvas/store/**` | Unit: every command has do/undo tests; 100 random command sequences keep the document schema-valid (property test) |
| 2.4 | Canvas rendering: NodeShell for each node type, CardRow summaries, OutputDot, TransitionPath, toolbar, minimap, compact nodes below 50% zoom | `apps/studio/src/canvas/view/**`, `packages/ui/src/canvas/**` | E2E: add nodes, connect, reconnect, delete, undo; perf test with the 300-node fixture meets the budget in design system §5.1; screenshot review (typical, dense-300, selection, issues, rtl) |
| 2.5 | Canvas interaction: add-node menu, drag-to-empty creates and wires, card add menu, card reorder, copy/paste, keyboard navigation and all shortcuts in the table | `apps/studio/src/canvas/interaction/**` | E2E: the full shortcut table by keyboard only; motion review for node add, card reorder, connect, reconnect |
| 2.6 | Inspector framework + forms for: Standard node, Send message (all message types with live preview), Ask, Condition, Set variable, Log, End conversation | `apps/studio/src/inspector/**`, `packages/ui/src/editors/**` | E2E: configure each card; invalid field shows the fix text; RTL fixtures in TemplateInput; screenshot review |
| 2.7 | Variables screen and VariablePicker; workflow inputs and outputs editor; "Used in" | `apps/studio/src/routes/variables/**` | E2E: create, rename (references update), delete blocked while used |
| 2.8 | Workflows panel (create, rename, duplicate, delete with usage warning), Issues panel, save indicator, command palette v1 (actions + go to) | `apps/studio/src/shell/**` | E2E: palette runs every registered action; `F8` cycles issues |
| 2.9 | Code editor drawer for Run code with generated typings from the bot schema (no execution yet) | `apps/studio/src/code/**`, `packages/contracts/src/typings.ts` | Unit: typings generator snapshot for a sample bot; E2E: autocomplete shows `workflow.email` with its type |

**Risks:** canvas performance (measure in 2.4, not later); command layer shortcuts that bypass the store (forbidden; review for direct xyflow state writes).

---

## Phase 3 — Sandbox and egress 🔒

**Goal:** untrusted JavaScript runs safely, with limits, and can only reach the internet through the guard.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 3.1 🔒 | `apps/egress`: forward proxy with DNS resolution, range blocking (v4 + v6, mapped addresses, metadata), DNS pinning, redirect re-check, size and time limits, per-workspace rate limit | `apps/egress/**` | Integration: SSRF matrix (decimal, octal, hex IPs; `localhost` variants; IPv6 loopback and mapped; redirect to private; DNS rebinding with a test resolver) is fully blocked with `fetch_blocked`; a public test server is reachable |
| 3.2 🔒 | `apps/sandbox` core: QuickJS-WASM runtime pool in worker threads, fresh context per exec, memory and stack limits, deadline interrupt, hard kill, NDJSON exec stream | `apps/sandbox/**` | Integration: infinite loop killed at the deadline; 1 GB allocation fails with `code_memory_exceeded`; promise flood terminates; two concurrent execs cannot see each other's globals; no `eval`/`Function`/`vm` in the service (lint) |
| 3.3 🔒 | Guest API: scope injection and diffing, bridged `fetch` (through egress), tool-call frames, `log`, `say`, `ctx`, axios-shaped helper, source-mapped errors with line and column | `apps/sandbox/src/guest/**`, `packages/sandbox-client/**` | Integration: variable writes come back as patches; a thrown error reports the right line; `fetch` to a private address is blocked; secrets passed in `env` are redacted in logs |
| 3.4 🔒 | Escape test suite and container hardening: prototype pollution of bridged objects, host function probing, getter traps, re-entrancy, oversized payloads; Dockerfile non-root, read-only FS, dropped caps, seccomp; production boot check for the runtime flag | `apps/sandbox/tests/escape/**`, `apps/sandbox/Dockerfile` | All escape tests pass; container starts with read-only root and no capabilities; `docs/security/sandbox-review.md` written for the human review |
| 3.5 | Expression fast path and batch evaluation API (`evalExpressions`), template renderer | `packages/engine/src/expr/**` | Unit: path-only expressions never call the sandbox; mixed templates render; errors map to `expression_error` / `template_error` |

**Risks:** QuickJS async bridging bugs (budget time for 3.3); performance of fresh contexts (measure; target p50 < 5 ms overhead).

---

## Phase 4 — Turn engine, Bridge inbound, emulator

**Goal:** a deterministic bot runs end to end: a message enters through the Bridge API, the engine executes nodes and cards across turns, replies stream to the emulator.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 4.1 | Schema: `bridge_connections, end_users, conversations, inbound_events, turns, messages, outbox_events` | `packages/db/migrations/0004_runtime.sql` | Integration: two-tenant tests; unique constraints on external ids and idempotency keys |
| 4.2 | Engine core (pure): state machine, frames, step loop, outcomes, ports and transitions, limits, error resolution order | `packages/engine/src/**` | Unit: table-driven tests for every row of the event table in architecture §4.4 and every outcome; loop and depth limits; ≥ 90% line coverage |
| 4.3 | Card executors: say, capture (all kinds except extract; validation; retries; `skipIfFilled`; option outputs), branch, set_variable, code, log, end, set_timeout, call_workflow + Exit node outputs | `packages/engine/src/cards/*` | Unit: per-card tests including failure paths; workflow inputs and outputs round-trip; capture of Arabic-Indic digits as a number works |
| 4.4 | Turn worker: lease with fencing, inbox drain, per-step transaction, deterministic message ids, turn-done signal, janitor (lease recovery, inactivity timeouts), coalescing window | `apps/worker/src/turn/**` | Integration: kill the worker mid-turn → another resumes at the uncommitted step with no duplicate message; two messages sent 5 ms apart are processed in order; lost Redis job is recovered by the janitor |
| 4.5 🔒 | Bridge inbound API: bridge keys, `sendMessage`, `sendEvent`, `updateUser`, `getConversation`, `listMessages`, `getTurn`, idempotency, `wait`, SSE | `apps/api/src/routes/bridge/*`, `packages/bridge/**` | Integration: contract tests generated from the OpenAPI file for every operation built so far; duplicate `Idempotency-Key` returns the original response; `wait` returns the turn's messages; a key for connection A cannot touch connection B |
| 4.6 | Emulator: draft connection per builder session, SSE client, all message bubbles, user-data form, reset, variables tab, error banner; "Run from here" | `apps/studio/src/emulator/**`, `packages/ui/src/conversation/**` | E2E: a three-node scripted bot runs; choice buttons work; RTL fixtures render; motion review for message stream; screenshot review |
| 4.7 | Minimal trace writer (turn, node, card, code, error spans; inline payloads only) and the emulator trace list with canvas run overlay | `packages/telemetry/src/trace.ts`, `apps/studio/src/trace/**` | Integration: spans for a turn are complete and ordered; E2E: clicking a step selects the card |
| 4.8 | Triggers (custom event, conversation started, inactivity, handoff released) and Error handler nodes | `packages/engine/src/triggers.ts` | Unit: trigger frame restores the previous wait; inactivity trigger runs instead of ending |

**Risks:** hidden non-determinism in retries (every step must be re-runnable); state growth (enforce the 256 KB limit in 4.2 with the "largest variables" message).

---

## Phase 5 — Bridge outbound, handoff, connections

**Goal:** bot output reaches external systems reliably, in order, signed; handoff works; builders can manage connections.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 5.1 🔒 | Webhook signing and verification reference implementation; secret generation and rotation (two active) | `packages/bridge/src/signing.ts` | Unit: reproduces the test vector in the OpenAPI description; tampered body, old timestamp and wrong secret fail; rotation sends two `v1` values |
| 5.2 | Delivery worker: per-conversation ordered stream, retry schedule with jitter, dead-letter, auto-disable after 20 consecutive dead, ephemeral events, delivery through egress | `apps/worker/src/webhook/**`, migration for `webhook_deliveries` | Integration (fake clock + flaky receiver): order preserved under retries; dead-lettered event unblocks the stream with a gap; a slow receiver for conversation A does not delay B |
| 5.3 | Remaining Bridge operations: `listConversationEvents`, deliveries list and replay, connection get and test, `endConversation`, `submitToolResult` (plumbing only) | `apps/api/src/routes/bridge/*` | Contract tests for every operation in the OpenAPI file now pass |
| 5.4 | Handoff: card executor, `handoff.requested` with auto summary stub (uses fake LLM until Phase 6), `handed_off` state, `releaseHandoff` | `packages/engine/src/cards/handoff.ts` | Integration: messages during handoff are stored and unanswered; release resumes; `not_handed_off` on a second release |
| 5.5 | Studio: Connections list and detail (Setup, Deliveries, Test), copy-ready examples, signature-check snippets in Node, Python and PHP | `apps/studio/src/routes/connections/**` | E2E: create a connection, send a test event to a local receiver, replay a dead event; screenshot review |
| 5.6 | Reference receiver example (`examples/bridge-receiver-node`) used in tests and docs | `examples/**` | The example verifies signatures and is exercised by the 5.2 integration test |

**Risks:** head-of-line blocking surprises (document it on the connection page); receivers that answer 200 before processing (documented, not our problem).

---

## Phase 6 — Model layer and the Autonomous Node

**Goal:** LLM-directed nodes work reliably with tools, exits, retries and a trace that shows every step.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 6.1 | `packages/llm`: interface, Anthropic / OpenAI / Google / OpenAI-compatible adapters, model registry, pricing, retries and fallback, usage events, BYOK resolution | `packages/llm/**`, migration for `usage_events` | Unit: adapters against recorded fixtures; Integration: usage event per call with correct cost; a 429 triggers retry then fallback |
| 6.2 | Workspace Models settings (provider keys, defaults) and ModelPicker | `apps/studio/src/routes/settings/models/**` | E2E: add a key (write-only), pick defaults; key never returned by the API |
| 6.3 | Protocol v1: streaming directive parser, validator, recovery rules | `packages/autonomy/src/protocol/**` | Unit: ≥ 60 parser cases (chunk boundaries inside directives, bodies containing `:::`-like text, Arabic bodies, missing `:::end`, run + exit precedence, two run blocks) |
| 6.4 | Prompt builder and `tools.d.ts` generator; transcript window and summarisation; cache-friendly ordering | `packages/autonomy/src/prompt/**` | Unit: snapshot of the prompt for a sample node; static prefix is byte-identical across turns of a conversation; untrusted content never appears in system text |
| 6.5 | Engine loop: iterations, feedback kinds, variable write validation against access rules, exits to outputs, listen, handoff exit, iteration limit, `memo` | `packages/autonomy/src/engine.ts` | Unit with fake LLM: every branch of the loop in architecture §6.3; rejected write is fed back and not applied |
| 6.6 | Tools: code, kb_search (stub until Phase 8), table (stub until Phase 9), workflow (inline and suspending), citations mapping; `submitToolResult` resume | `packages/autonomy/src/tools/**` | Integration: workflow tool that asks the user a question suspends and resumes with "code after the call did not run" feedback |
| 6.7 | AI cards: AI condition, Generate text, Extract data, Ask kind `extract`, handoff auto summary | `packages/engine/src/cards/ai-*.ts` | Unit with fake LLM; schema-invalid extraction retried once then fails with a clear code |
| 6.8 | Studio: Autonomous node inspector (instructions, tools, variables, exits, advanced), tool editors, exit outputs on the canvas | `apps/studio/src/inspector/autonomous/**` | E2E: build the wireframe node from design system §5.2; screenshot review |
| 6.9 | Trace for autonomy: iteration, llm.call, tool.call spans with payloads; PayloadViewer; playback controls and canvas highlighting | `apps/studio/src/trace/**` | E2E: playback of a recorded three-step turn highlights cards in order; motion review at normal and reduced motion |
| 6.10 | Adherence eval suite: 120 English + 120 Arabic cases (dialects, code-switching, tool selection, exits, prompt-injection attempts); runner and report; registry `autonomy` field set from results | `packages/autonomy/evals/**` | Report committed for each candidate model; a model below 98% protocol-valid is marked unsupported |

**Risks:** adherence on cheaper models (6.10 decides; fallback protocol is the contingency, needs an ADR to start); prompt regressions (snapshot tests + evals on every change in this package).

---

## Phase 7 — Publish, versions, rollback, secrets

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 7.1 | `bot_versions`, publish (validate, assemble, hash, store), rollback, restore to draft | `packages/db/migrations/0007_versions.sql`, routes | Integration: publish blocked by errors with the issue list; identical drafts produce the same hash; rollback changes only the pointer |
| 7.2 | Conversation version pinning and migration on next turn | `apps/worker/src/turn/version.ts` | Integration: position kept when ids still exist; reset with variables preserved otherwise; `version_migrated` span lists drops |
| 7.3 🔒 | Config variables: encrypted values per environment, `env` injection, redaction set | `packages/db`, `packages/engine/src/env.ts` | Integration: draft and production values differ; values never appear in spans, logs or API responses (canary test) |
| 7.4 | Structural diff (workflow → node → card → field), ignoring layout | `packages/contracts/src/diff.ts` | Unit: fixtures for add, remove, change, move-only (no diff) |
| 7.5 | Studio: publish dialog, versions list, compare view, rollback and restore confirmations, Secrets and settings tab | `apps/studio/src/routes/versions/**` | E2E: publish, change, compare, roll back; screenshot review |
| 7.6 | Bot export and import (definition JSON; ids regenerated on import; KB and table references reported as unresolved) | routes, Studio menu | Integration: export → import yields an equivalent validated definition |

---

## Phase 8 — Knowledge bases

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 8.1 | Schema: KB tables, HNSW and GIN indexes; `files` and object-store upload with signed URLs | migration `0008_kb.sql`, `apps/api/src/routes/files/*` | Integration: two-tenant tests; upload size and MIME limits |
| 8.2 | `apps/parser` (Docling service) with limits and no network; client; HTML via Readability; OCR tier through the vision model for low-text pages; parse-quality score | `apps/parser/**`, `packages/retrieval/src/parse/**` | Integration: fixtures (born-digital Arabic PDF, table across a page break, scanned Arabic page, DOCX, HTML article) produce expected headings and table cells |
| 8.3 | Arabic normaliser and light stemmer; shared by index and query | `packages/retrieval/src/arabic.ts` | Unit: ≥ 150 cases (alef and hamza forms, ta marbuta, diacritics, tatweel, digits, prefixes and suffixes, mixed Arabic–English); index and query output identical for the same input |
| 8.4 | Chunker (structure-aware), embedder client, indexer; ingestion queue with stage records and idempotency | `packages/retrieval/src/{chunk,embed,index}.ts`, `apps/worker/src/kb/**` | Integration: re-ingesting an unchanged document does no work; a failed embed resumes from that stage |
| 8.5 | Sources: file, text, single URL, sitemap; crawl with depth and page limits, robots, rate limit; scheduled re-sync | `apps/worker/src/kb/sources/**` | Integration against a local test site: respects robots and limits; changed pages re-index, removed pages are deleted |
| 8.6 | Search: dense + lexical + RRF + rerank, retrieval spans, citations; wire `kb_search` card and tool | `packages/retrieval/src/search.ts` | Integration: filtered search never returns another KB's chunks; span contains per-stage candidates |
| 8.7 | Retrieval golden sets (MSA, Egyptian, Gulf, code-switched; ≥ 60 queries each over a shared corpus) and CI report of recall@5 and MRR | `packages/retrieval/evals/**` | Baseline report committed; hybrid + rerank beats dense-only on every set |
| 8.8 | Studio: KB list and detail (Sources, Documents with chunk view, Test search with "why", Settings), Search knowledge card and tool forms | `apps/studio/src/routes/knowledge/**` | E2E: upload, wait for ready, search in Arabic, open the retrieval trace; screenshot review with RTL documents |

**Risks:** parser container size and cold start; OCR cost (cap pages per document, show the estimate before running).

---

## Phase 9 — Tables

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 9.1 🔒 | Schema, table and column CRUD, filter AST → parameterised SQL compiler, row validation, limits | migration `0009_tables.sql`, `packages/db/src/tables/**` | Unit: compiler fuzz test never emits tenant text into SQL; Integration: two-tenant tests; unique and required enforced |
| 9.2 | Row API (find, get, insert, update, upsert, delete, CSV import), full-text search on searchable columns | routes, `packages/db/src/tables/rows.ts` | Integration: pagination stable under inserts; Arabic search uses the shared normaliser |
| 9.3 | Table card, table tool (per-operation methods), `tables.*` in code with generated typings | `packages/engine/src/cards/table.ts`, `packages/autonomy/src/tools/table.ts` | Unit + integration: each operation from card, code and tool |
| 9.4 | Studio: Tables grid, column menu, FilterBuilder, import, usage protection on delete | `apps/studio/src/routes/tables/**` | E2E: create, edit cells by keyboard, filter, import; screenshot review |

---

## Phase 10 — Conversations and traces

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 10.1 | Trace storage complete: monthly partitions, object-store payloads over 8 KB, redaction, batching, retention job | `packages/telemetry/**`, migration | Integration: large payload round-trips; canary secret never stored; partition for next month is created ahead |
| 10.2 | Conversations API (filters, search) and trace API | routes | Integration: filters; two-tenant tests |
| 10.3 | Studio: Conversations screen with transcript and trace sheet; "Add eval case from conversation" (stub until Phase 12) | `apps/studio/src/routes/conversations/**` | E2E; screenshot review |
| 10.4 | Replay a turn against the draft with recorded inputs (emulator mode) | `apps/worker/src/turn/replay.ts` | Integration: replay does not touch the live conversation or call side-effect tools unless confirmed |
| 10.5 | Platform metrics endpoint and dashboards-as-code | `apps/*/src/metrics.ts`, `infra/grafana/**` | Metrics listed in architecture §12 are exported |

---

## Phase 11 — Metering and quotas

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 11.1 | Usage kinds and emitters; conversation counting rule; mode tagging | `packages/telemetry/src/usage.ts` | Integration: emulator and eval traffic is recorded and excluded from billable totals; conversation counted on the second user message |
| 11.2 🔒 | Quota engine: plan limits, Redis counters, hourly reconciliation, hard caps, `quota_exceeded` behaviour, per-workspace concurrency buckets | `packages/telemetry/src/quota.ts` | Integration: cap reached → quota message and event, no model call; counters survive a Redis flush via reconciliation |
| 11.3 | Daily roll-ups and `BillingAdapter` interface with a no-op implementation | `apps/worker/src/maintenance/**` | Integration: roll-up totals equal event sums |
| 11.4 | Studio: Usage tab (meters, caps, daily table) | `apps/studio/src/routes/settings/usage/**` | E2E; screenshot review |

---

## Phase 12 — Evals

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 12.1 | Schema and runner: executes cases through the Bridge API in eval mode against draft or a version; all assertion types; judge with rubric | `packages/evals/**`, `apps/worker/src/eval/**` | Integration with fake LLM: each assertion type passes and fails correctly; a run never bills |
| 12.2 | Studio: suites, case editor, run view with per-assertion results and trace links, per-tag scores, "Add case from conversation" | `apps/studio/src/routes/evals/**` | E2E; screenshot review |
| 12.3 | Publish dialog shows eval status; optional "block publish on failing evals" bot setting | publish flow | E2E |
| 12.4 | CLI: `wakeel evals run --bot … --suite …` returning a non-zero exit code on failure | `packages/cli/**` | Integration |

---

## Phase 13 — Analytics and Studio polish

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 13.1 | Analytics queries from roll-ups and spans; Analytics screen | routes, `apps/studio/src/routes/analytics/**` | Integration; screenshot review (charts follow §5.12) |
| 13.2 | Motion pass: every row of every motion table verified with `studio:motion`, normal and reduced | `apps/studio/**` | Motion review file with frames for each moment |
| 13.3 | Keyboard and accessibility pass: full shortcut table, focus order, labels, live regions, `axe` clean | `apps/studio/**` | E2E keyboard-only script for the canvas; zero serious `axe` violations on every screen |
| 13.4 | Performance pass: 300-node budget, bundle splitting (Monaco and charts lazy), emulator stream under load | `apps/studio/**` | Perf test in CI; initial JS for the canvas route under the budget set in the task |
| 13.5 | RTL audit: every content surface with the fixture set, light and dark | `apps/studio/**` | Screenshot review dedicated to RTL |
| 13.6 | Copy audit against design system §3; empty, loading and error states for every screen | `apps/studio/**` | Checklist committed |

---

## Phase 14 — Chatwoot reference adapter

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 14.1 | Verify the spec against current Chatwoot docs and a real webhook capture; update the spec; record fixtures | `docs/04-contracts/chatwoot-adapter-spec.md`, fixtures | Every ⚠ in the spec is resolved or documented |
| 14.2 | Adapter service: both webhook endpoints, mappings, handoff life cycle, de-duplication, numbered-list fallback | `apps/adapter-chatwoot/**` | The seven acceptance tests in the spec |
| 14.3 | docker-compose example with Chatwoot and setup guide | `examples/chatwoot/**` | A new user can follow the guide end to end |

---

## Phase 15 — Hardening and launch

| ID | Task | Files | Acceptance |
|---|---|---|---|
| 15.1 🔒 | Security review pack: threat model walkthrough with evidence per row, dependency audit, secrets scan, CSP and headers, rate limits on every public route | `docs/security/**` | Human sign-off |
| 15.2 🔒 | External penetration test of sandbox, egress and tenant isolation; fixes | — | Report with no open high findings |
| 15.3 | Load test: 50 concurrent turns with the fake LLM at realistic latencies; webhook receiver at 5% failure; find the first bottleneck and document capacity | `tools/load/**` | Report; architecture §15 numbers updated with measurements |
| 15.4 | Backups and restore drill (Postgres PITR, object store versioning); runbooks for the five most likely incidents | `docs/runbooks/**` | A restore into a clean environment succeeds and is timed |
| 15.5 | Production deployment: images, migrations job, health checks, gVisor verification, environment template | `infra/**` | A fresh environment comes up from the documented steps |
| 15.6 | Migrate one Engosoft bot from Botpress as the acceptance pilot; record gaps | `docs/pilot/**` | The pilot bot passes its eval suite and runs in production behind Chatwoot |

---

## Card checklist (use for every card type you add)

- [ ] Schema in `card.ts`; port keys in `cardPortKeys`; in `MVP_CARD_TYPES` if applicable
- [ ] Executor in `packages/engine/src/cards/<type>.ts` with unit tests for success, each output, each failure code
- [ ] Validation rules and fixtures
- [ ] Canvas summary renderer (one line, truncates, RTL-safe)
- [ ] Inspector form with inline validation and help text
- [ ] Trace span attributes
- [ ] Entry in the add-card menu with the name from design system §3.1
- [ ] Screenshot review

## Cross-phase risks

| Risk | Where it bites | Guard |
|---|---|---|
| Executor drifts from `/docs` | Any phase | ADR rule in `CLAUDE.md`; PR template asks "which doc section does this implement?" |
| Security task merged without review | 0.5, 1.x, 3.x, 4.5, 5.1, 7.3, 9.1, 11.2, 15.x | 🔒 tasks stop at the PR |
| Visual quality slips under delivery pressure | 2, 4, 6, 13 | Screenshot review is part of Done, and review files are checked by a human |
| Model behaviour changes under us | 6, 8, 12 | Evals nightly; registry pins model ids |
| Scope creep | Any | Anything not in this plan needs a line in "Later" in `02-product-thesis.md` and Eyad's approval |
