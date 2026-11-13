# 03 — Architecture

Normative. Words "must", "never" and "always" bind the executor. Decisions with alternatives are recorded in `/docs/adr`. Contracts referenced here live in `/docs/04-contracts`.

Code scope name: `@wakeel/*` (matches the repo folder). The user-facing brand string is `{{PLATFORM_NAME}}` and must only ever be read from `packages/config/src/brand.ts`.

## 1. System overview

```
                      ┌───────────────────────────── Studio (React SPA, static) ─────────────────────────────┐
                      │  canvas · inspector · emulator · traces · KB · tables · versions · settings          │
                      └───────────────┬──────────────────────────────────────────────┬───────────────────────┘
                                      │ Studio API (session cookie)                  │ Bridge API (emulator = a bridge client)
 External systems                     ▼                                              ▼
 (Chatwoot adapter,   Bridge API  ┌────────────────────────── api (Fastify) ──────────────────────────┐
  n8n, custom)  ─────────────────▶│ auth · RBAC · bots/drafts/versions · KB/tables CRUD · bridge in   │
        ▲                         └───────┬───────────────────────────────┬───────────────────────────┘
        │ signed webhooks                 │ SQL (RLS)                     │ enqueue / pub-sub
        │                                 ▼                               ▼
        │                          ┌────────────┐                   ┌───────────┐
        │                          │ Postgres   │◀──────────────────│  Redis    │
        │                          │ + pgvector │                   │ (BullMQ)  │
        │                          └─────┬──────┘                   └─────┬─────┘
        │                                │                                │
        │                         ┌──────┴────────────── worker ──────────┴──────┐
        └─────────────────────────│ turn engine · autonomous engine · webhook    │
                                  │ delivery · KB ingestion · evals · janitor    │
                                  └───┬──────────────┬──────────────┬────────────┘
                                      │ exec stream  │ HTTPS        │ HTTP
                                      ▼              ▼              ▼
                               ┌───────────┐  ┌────────────┐  ┌───────────┐     ┌──────────────┐
                               │ sandbox   │  │ LLM / embed│  │ parser    │     │ object store │
                               │ (QuickJS) │  │ providers  │  │ (Docling) │     │ (S3 / MinIO) │
                               └─────┬─────┘  └────────────┘  └───────────┘     └──────────────┘
                                     │ fetch
                                     ▼
                               egress proxy (SSRF guard) ──▶ internet
```

### 1.1 Deployables

| Name | Tech | Holds DB creds | Purpose |
|---|---|---|---|
| `apps/api` | Node 22, Fastify 5 | yes (role `app_rw`) | Studio API and Bridge API. One image; `ROLE=studio\|bridge\|all` selects which routes mount, so the bridge can scale separately. |
| `apps/worker` | Node 22, BullMQ | yes (`app_rw`) | All asynchronous work. `QUEUES=` selects which queues a replica consumes. |
| `apps/sandbox` | Node 22, QuickJS-WASM | **no** | Runs tenant and model-generated JavaScript. Internal network only. |
| `apps/parser` | Python 3.12, FastAPI, Docling | **no** | Converts documents to structured Markdown. Internal network only. |
| `apps/egress` | Node 22 forward proxy | no | The only route from sandbox, crawler and webhook delivery to the internet. |
| `apps/studio` | Vite, React 19 | — | Static SPA served by any static host. |

Infra: Postgres 17 with `pgvector` ≥ 0.8, Redis 7, S3-compatible object store. Local development uses `docker-compose.yml` with MinIO.

### 1.2 Monorepo layout

```
apps/      api  worker  sandbox  parser  egress  studio
packages/  contracts      zod schemas (single source of truth; copied from docs/04-contracts in Phase 0)
           config         env parsing, brand, limits
           db             drizzle schema, SQL migrations, RLS helpers, repositories
           auth           sessions, password, RBAC, API keys
           engine         turn engine (pure; no I/O except through ports)
           autonomy       autonomous node engine (protocol, parser, prompt builder)
           sandbox-client typed client for apps/sandbox
           llm            provider-agnostic model layer, model registry, pricing
           retrieval      chunking, Arabic normalisation, hybrid search, rerank
           bridge         message normalisation, webhook signing, delivery
           telemetry      trace writer, usage meter
           ui             design tokens, primitives (Radix wrappers), icons
           testing        fixtures, fake LLM, fake clock, test DB harness
docs/      this folder
```

Dependency rule: `engine` and `autonomy` import only `contracts` and declare ports (interfaces). `apps/worker` wires ports to `db`, `llm`, `sandbox-client`, `retrieval`, `bridge`, `telemetry`. This keeps the engine unit-testable with fakes.

## 2. Tenancy and data model

### 2.1 Tenancy (ADR-004)

- The tenant is the **workspace**. Every tenant-owned table has `workspace_id text not null`.
- Row-level security is enabled and **forced** on every tenant-owned table: `using (workspace_id = nullif(current_setting('app.workspace_id', true), ''))` and the same `with check` (ADR-014).
- Database roles: `app_migrator` (owns objects, used only by migrations), `app_rw` (used by api and worker; `NOBYPASSRLS`, no DDL), `app_admin_ro` (support tooling; read-only, still RLS-bound unless a break-glass function is called and audited).
- All tenant queries run through `withWorkspace(workspaceId, fn)` in `packages/db`, which opens a transaction and issues `select set_config('app.workspace_id', $1, true)`. A lint rule forbids importing the raw pool outside `packages/db`.
- Cross-tenant lookups that must happen before the workspace is known (API key prefix → workspace, session → memberships, bridge key → connection) go through `security definer` functions that return only the ids needed.
- Test harness: every repository test runs twice, once as tenant A and once as tenant B, and asserts B sees nothing of A.

### 2.2 Identifiers (ADR-012)

- Database and API ids are `text`: `<prefix>_<ULID lowercase>`, generated in the application. Prefixes: `ws usr mem inv key bot ver conn eu conv msg evt turn out dlv span use kb src doc chk tbl row suite case run file aud`.
- Ids inside a bot definition (workflow, node, card, edge, variable, tool, exit) are `<prefix>_<10-char nanoid>`, unique within the bot, and never reused.

### 2.3 Tables

All have `created_at`; mutable ones have `updated_at`. `W` = has `workspace_id` + RLS.

**Platform**
- `users(id, email citext unique, name, password_hash, email_verified_at, locale)`
- `sessions(id, user_id, token_hash, expires_at, ip, user_agent)`
- `workspaces(id, name, slug unique, plan, region, settings jsonb)`
- `memberships W (id, user_id, role)` role ∈ `owner | admin | builder | viewer`; unique `(workspace_id, user_id)`
- `invitations W (id, email, role, token_hash, expires_at, accepted_at)`
- `api_keys W (id, kind, name, prefix unique, secret_hash, scopes text[], bot_id?, connection_id?, last_used_at, expires_at, revoked_at)` kind ∈ `workspace | bridge`
- `workspace_secrets W (id, name, ciphertext, key_version)` — model provider keys (BYOK)
- `audit_log W (id, actor_type, actor_id, action, target_type, target_id, meta jsonb, ip, at)` append-only

**Bot definition**
- `bots W (id, name, slug, default_locale, settings jsonb, published_version_id?, archived_at)`
- `bot_draft_docs W (bot_id, kind, doc_id, rev int, doc jsonb, updated_by)` kind ∈ `manifest | workflow`; PK `(bot_id, kind, doc_id)`
- `bot_versions W (id, bot_id, number int, label, notes, definition jsonb, definition_hash, created_by, published_at?)` immutable; unique `(bot_id, number)`
- `bot_config_vars W (bot_id, env, key, ciphertext, key_version, is_secret)` env ∈ `draft | production`

**Runtime**
- `bridge_connections W (id, bot_id, name, target, webhook_url?, signing_secrets jsonb(ciphertext[]), subscribed_events text[], status, consecutive_dead int)` target ∈ `production | draft`; status ∈ `active | paused | disabled`
- `end_users W (id, bot_id, connection_id, external_id, attributes jsonb, vars jsonb)` unique `(connection_id, external_id)`
- `conversations W (id, bot_id, connection_id, end_user_id, external_id, mode, status, version_id, state jsonb, state_bytes int, next_in_seq bigint, next_out_seq bigint, lease_owner, lease_until, lease_epoch bigint, last_activity_at, expires_at, ended_at, ended_reason, handoff jsonb)` unique `(connection_id, external_id)`; mode ∈ `live | emulator | eval`
- `inbound_events W (id, conversation_id, seq bigint, kind, payload jsonb, idempotency_key?, received_at, processed_at?, turn_id?)` unique `(conversation_id, seq)`, unique `(connection_id, idempotency_key)`
- `turns W (id, conversation_id, bot_id, version_id, trigger_event_id, status, step_count, usage jsonb, error jsonb, started_at, ended_at)`
- `messages W (id, conversation_id, seq bigint, direction, type, payload jsonb, citations jsonb, turn_id?, external_id?)` direction ∈ `in | out`
- `outbox_events W (id, connection_id, conversation_id, seq bigint?, type, payload jsonb, ephemeral bool)` 
- `webhook_deliveries W (id, outbox_event_id, attempt int, status, next_attempt_at, response_status?, error?, duration_ms?)` status ∈ `pending | delivered | failed | dead`

**Knowledge and tables**
- `knowledge_bases W (id, bot_id, name, description, embedding_model, embedding_dims, index_version int, settings jsonb)`
- `kb_sources W (id, kb_id, kind, config jsonb, schedule?, status, last_synced_at, error jsonb)` kind ∈ `file | url | sitemap | crawl | text`
- `kb_documents W (id, kb_id, source_id, title, uri, mime, lang, content_hash, parsed_key, status, token_count, meta jsonb)`
- `kb_chunks W (id, kb_id, document_id, ordinal int, heading_path text[], text, text_norm, lex tsvector, embedding vector(1024), token_count, meta jsonb, index_version int)`
- `kb_ingestion_jobs W (id, kb_id, source_id, document_id?, stage, status, attempts, error jsonb)`
- `bot_tables W (id, bot_id, name, description, columns jsonb, row_count)`
- `table_rows W (id, table_id, data jsonb, lex tsvector)`

**Observability, metering, evals**
- `trace_spans W (id, bot_id, conversation_id, turn_id, parent_id?, seq int, kind, name, status, started_at, duration_ms, attrs jsonb, payload_key?)` range-partitioned monthly on `started_at`
- `usage_events W (id, bot_id?, kind, quantity numeric, unit, model?, cost_micro_usd bigint, mode, conversation_id?, turn_id?, at)` range-partitioned monthly; `usage_daily W (day, bot_id, kind, model, mode, quantity, cost_micro_usd)`
- `eval_suites W`, `eval_cases W (suite_id, name, script jsonb)`, `eval_runs W (suite_id, target, status, summary jsonb)`, `eval_results W (run_id, case_id, status, detail jsonb, conversation_id)`
- `files W (id, bot_id?, purpose, key, mime, size, sha256)`

Indexes that are easy to forget: `kb_chunks` HNSW on `embedding vector_cosine_ops` (`m=16, ef_construction=128`, fixed at creation), GIN on `lex`, btree `(kb_id, index_version)`; `inbound_events (conversation_id) where processed_at is null`; `webhook_deliveries (next_attempt_at) where status = 'pending'`; `conversations (expires_at) where ended_at is null`.

## 3. Bot definition, drafts and versions (ADR-006)

- A **BotDefinition** (`04-contracts/bot-definition.ts`) is `{ schemaVersion, manifest, workflows[] }`. The manifest holds settings, variables (bot, user, conversation scopes), config variable *names*, and model defaults.
- A **draft** is stored as one `manifest` document and one document per workflow. Each has an integer `rev`. Saves are whole-document `PUT` with `If-Match: <rev>`; a mismatch returns `409 revision_conflict` with the server copy. The Studio autosaves 800 ms after the last change.
- Canvas positions live in `workflow.layout` (a map from node id to `{x, y}`), separate from `workflow.nodes`, so logic diffs ignore movement.
- **Publish** validates the whole draft (section 3.1), assembles a BotDefinition, stores it as an immutable `bot_versions` row and sets `bots.published_version_id`. **Rollback** sets `published_version_id` to an older version. **Restore to draft** copies a version's definition into the draft documents.
- Knowledge bases and tables are live resources, not versioned with the definition. Column ids and KB ids are stable. Deleting a column, table or KB referenced by the published version is blocked with a list of usages.
- `schemaVersion` starts at 1. Every change to a definition contract ships a migration function in `packages/contracts/src/migrations` and a test with a stored fixture.

### 3.1 Validation

`validateDefinition(def)` returns `Issue[] { severity, code, message, fix, path }`. Errors block publish; warnings do not. Minimum rules: every edge endpoint exists; every non-terminal port of a routing card is connected or marked "falls through"; Main workflow has exactly one Start node; sub-workflows have an Entry and at least one Exit; variable references resolve and types are compatible; `choice` text is non-empty; autonomous node tools have unique, valid identifiers; every exit has a connected port; referenced KBs, tables, workflows and config variables exist; template syntax parses. The Studio runs the same function in the browser on every change.

### 3.2 Version pinning for live conversations

A conversation stores `version_id`. At the start of each turn, if the bot's published version differs: if every `(workflowId, nodeId)` on the conversation's stack exists in the new version, switch and continue; otherwise clear the stack (status `idle`), keep conversation and user variables that still validate against the new schemas, drop the rest, and record a `version_migrated` span listing what was dropped. Emulator conversations always run the draft; `target=draft` bridge connections do too.

## 4. Runtime semantics

### 4.1 Vocabulary

- **Turn**: everything the bot does in response to one inbound event, until it waits, goes idle, ends or hands off.
- **Step**: execution of one card (or one autonomous iteration).
- **Frame**: one active workflow invocation `{ workflowId, nodeId, cardIndex, vars, call? }`.
- **Stack**: frames; the top frame is executing. Sub-workflow calls push; Exit pops.
- **ConversationState** (`04-contracts/runtime.ts`): `{ v, status, stack, conversationVars, wait?, autonomy, summary?, inactivityTimeoutMinutes? }`, stored in `conversations.state`. Hard limit 256 KB serialised; exceeding it fails the step with `state_too_large` and names the three largest variables.

Status: `idle` (no stack; next message starts Main at Start) · `waiting_input` (a capture card or an autonomous `listen`) · `waiting_external` (a suspended tool awaits a result) · `handed_off` (bot is silent until released) · `ended`.

### 4.2 Inbound path

1. `POST /v1/bridge/conversations/{externalConversationId}/messages` (or `/events`). Authenticate the bridge key → connection → bot → workspace.
2. In one transaction: upsert `end_users` and `conversations` by external id; reject duplicates by `Idempotency-Key` (return the original response); insert `inbound_events` with `seq = next_in_seq++`; for user messages also insert `messages`.
3. Enqueue BullMQ job `turn` with `jobId = conversationId` (deduplicated; a job already waiting is enough).
4. Respond `202` with ids; or, in sync mode, wait on Redis channel `turn-done:<conversationId>:<seq>` (section 9.3).

### 4.3 Turn worker

```
acquire lease on conversation (UPDATE ... SET lease_owner, lease_until = now()+30s, lease_epoch = lease_epoch+1
                               WHERE id=$1 AND (lease_until IS NULL OR lease_until < now()) RETURNING lease_epoch)
  not acquired → exit (another worker owns it; it will drain the inbox)
loop:
  ev = oldest unprocessed inbound_event           (none → release lease, exit)
  optionally coalesce: if ev is a text message and bot.settings.coalesceWindowMs > 0,
      wait that window and merge following text messages into one event
  turn = insert turns(status='running')
  definition = load pinned or migrated version (section 3.2)
  outcome = Engine.runTurn(state, ev, definition, ports)        (section 4.4)
  mark ev processed; update turn; write outbox 'turn.completed'; publish turn-done
```

Every state write includes `AND lease_epoch = $epoch`; zero rows updated means the lease was lost and the worker must stop without further side effects. A heartbeat extends the lease every 10 s. The janitor re-enqueues conversations with unprocessed events and an expired lease.

### 4.4 Engine

`Engine.runTurn` is a pure state machine driven by card outcomes.

Applying the inbound event:

| Event | State | Effect |
|---|---|---|
| `user_update` | any | merge `end_users.attributes`; no steps run |
| `message` | `handed_off` | record only |
| `message` | `ended` | start a new session: reset state to `idle`, then as below |
| `message` | `idle` | push Main workflow at Start |
| `message` | `waiting_input` (capture) | feed to the waiting card (validation, retries) |
| `message` | `waiting_input` (listen) | resume the autonomous node with the message appended |
| `message` | `waiting_external` | queue behind the pending tool; bot replies with the node's "busy" text if set |
| `event` (custom) | any except `handed_off`, `ended` | if a Trigger node matches `event.name`: push a frame at that trigger, run it, then restore the previous wait; otherwise record and ignore |
| `tool_result` | `waiting_external` | resume the suspended tool call |
| `handoff_release` | `handed_off` | status `idle`; run Trigger `handoff_released` if present |
| `timeout` (janitor) | `waiting_*` | run the Main workflow's Trigger node with `on.kind = "inactivity"` if one exists, else end with reason `inactivity` |

Step loop: execute the card at the top frame's cursor. A card returns exactly one outcome:

`next` (advance cursor) · `goto(portId)` (follow the edge from that port) · `wait(spec)` (persist and stop the turn) · `call(workflowId, inputs)` (push frame) · `return(outputs)` (pop frame, map outputs to the caller's variables per the call card) · `handoff(info)` · `end(reason)` · `fail(error)`.

When the cursor passes the last card, follow the node's `next` port. No edge there: in a sub-workflow this is an implicit `return({})`; in Main the stack empties and status becomes `idle`.

**Persistence.** Each step commits one transaction containing the new state, any messages and outbox events it produced, and the step counter. Message ids are deterministic (`msg_` + hash of `turnId, stepSeq, index`), so a retried step cannot duplicate output. A step that crashed mid-way is re-run from its start: card side effects are therefore at-least-once. Cards that call tenant code or external systems receive `ctx.idempotencyKey = turnId:stepSeq` and the docs tell builders to pass it on.

**Limits (defaults; all in `packages/config/limits.ts`).** 200 steps per turn; 25 visits to one node per turn; stack depth 16; turn wall clock 120 s; Execute Code 10 s and 64 MB; autonomous iterations 6 per turn; state 256 KB; inbound message text 16 KB. Exceeding a limit is a `fail` with a specific code.

**Errors.** `fail(error)` resolves in order: the card's `error` port if connected → the workflow's Error handler node → the bot's error workflow → default: send `bot.settings.errorMessage`, emit an `error` bridge event, clear the stack. Every failure writes a span with `code`, `message`, `fix` and the card location. Error codes are an enum in `04-contracts/errors.ts`; each has a user-facing message and fix text.

**Inactivity.** `conversations.expires_at = last_activity_at + timeout` (bot default 24 h; a card can change it; `0` = never). The janitor (every 30 s) inserts a `timeout` inbound event for expired conversations.

**Typing.** At turn start the engine emits an ephemeral `typing {state:'on'}` event; at turn end `typing {state:'off'}`. Ephemeral events are delivered best-effort, never retried, carry no `seq`.

### 4.5 Variables

Scopes: `bot` (read-only at runtime, set in Studio), `user` (per end user, across conversations), `conversation`, `workflow` (per frame; includes declared inputs and outputs). Read-only built-ins: `event` (the inbound event), `user.attributes` (data pushed by the bridge), `env` (config variables), `turn` (scratch object cleared each turn).

Every variable has a type from `04-contracts/variable.ts` (`string, number, boolean, date, enum, object, array, any`) with an optional JSON-schema-like shape. Writes are validated; a mismatch is `variable_type_mismatch` with the expected and received types. `object` values are stored as JSON, never stringified.

Workflow inputs and outputs are declared on the workflow. A `call workflow` card maps expressions to inputs and maps outputs to caller variables. Nothing else crosses the boundary.

### 4.6 Templates and expressions

- Text fields accept `{{ expression }}`. Expressions are JavaScript expressions over the scope objects.
- Fast path: an expression that is a pure property path (`workflow.email`, `user.attributes.plan`) is resolved natively without the sandbox.
- Anything else is evaluated in the sandbox in one batched call per card.
- Condition fields are a single expression that must evaluate to boolean. The Studio offers "describe it" which calls the utility model at design time and writes the expression into the field for the builder to review; the model is never consulted at run time for a deterministic condition.
- A template that fails to parse is a publish-time error. A runtime exception in an expression is `expression_error` with the expression and the message.

## 5. Sandbox (ADR-003)

### 5.1 Shape

`apps/sandbox` exposes one internal endpoint: `POST /exec`, a bidirectional NDJSON stream.

- Request frame: `{ execId, kind: 'code'|'expressions'|'autonomy_run', source, scopes, toolManifest, limits, capabilityToken }`.
- The sandbox emits `{ t:'tool_call', callId, name, input }`, `{ t:'log', level, args }`, and finally `{ t:'result', value, scopePatches, stats }` or `{ t:'error', code, message, line, column }`.
- The worker answers tool calls with `{ t:'tool_result', callId, ok, value|error }`.

Each execution gets a fresh QuickJS runtime inside a pooled `worker_thread`: memory limit, stack limit, interrupt handler on a deadline, and a hard `thread.terminate()` 250 ms after the deadline. There is **no** fallback to `vm`, `AsyncFunction` or `eval`: if QuickJS cannot load, the service fails its health check.

### 5.2 Guest API

`workflow`, `conversation`, `user` (mutable copies; diffed after the run into `scopePatches`), `bot`, `event`, `env` (frozen), `turn`, `fetch` (bridged through the egress proxy; 10 s, 5 MB response, 5 redirects), `tables.<name>.{find,get,insert,update,upsert,delete}`, `kb.search`, `ai.{generate,extract,classify}`, `log.{info,warn,error}`, `say(message)`, `ctx.idempotencyKey`, plus an `axios`-shaped helper written by us over `fetch` to ease migration from Botpress. No `require`, `import`, timers, `process`, filesystem.

The Studio code editor receives a generated `.d.ts` for exactly these globals using the bot's real variable and table schemas.

### 5.3 Isolation layers

1. QuickJS interpreter in WASM linear memory (no JIT, no host objects).
2. Thread and process: the sandbox service has no database, Redis or object-store credentials; its environment holds only its own config.
3. Container: non-root, read-only root filesystem, all capabilities dropped, seccomp default, `runsc` (gVisor) runtime in production. Boot refuses to start in `NODE_ENV=production` unless `SANDBOX_RUNTIME_VERIFIED=1` is set by the deploy pipeline after checking the runtime.
4. Network: only the egress proxy is reachable. The proxy resolves DNS itself, blocks private, loopback, link-local and metadata ranges (IPv4 and IPv6), pins the resolved address for the connection, re-checks on every redirect, and enforces per-workspace rate limits.

Secrets handed to the guest (`env`) are that tenant's own. Their values are added to a per-execution redaction set applied to logs and trace payloads.

## 6. Autonomous Node (ADR-002)

Own engine in `packages/autonomy`. Concepts follow LLMz; no source is copied.

### 6.1 Node configuration

`04-contracts/node.ts → AutonomousNode`: `instructions` (template), `model?`, `tools[]`, `variableAccess[] {ref, mode: read|write}`, `exits[] {id, name, description, schema?}`, `conversational` (may message the user and listen), `allowHandoff`, `maxIterations`, `temperature`.

Tools (`04-contracts/tool.ts`) are one of: `code` (name, description, input and output schema, source), `kb_search` (KB ids, instructions), `table` (table id, allowed operations), `workflow` (workflow id; inputs and outputs become the signature). There are no implicit tools.

### 6.2 Turn protocol v1

The model replies with directives, each on its own line starting at column 0. The marker string is the constant `PROTOCOL_MARK` (`":::"`); it can be changed in one place if adherence evals favour another.

```
:::say text
Your order shipped yesterday and should arrive Thursday.
:::say choice {"options":[{"label":"Track it","value":"track"},{"label":"That's all","value":"done"}]}
Anything else?
:::exit listen
:::end
```

```
:::say text
Let me check that order.
:::run
const order = await tables.orders.find({ where: { number: { eq: "5678" } }, limit: 1 })
return order
:::end
```

Rules, enforced by the parser and stated in the prompt:

- `:::say <type> [json props]` followed by a body sends one message as soon as the next directive starts. Bodies are final text; no interpolation.
- At most one `:::run` per response; it must come after all `:::say` blocks. The body is plain JavaScript with top-level `await`.
- If the run block returns a value, the model gets another iteration with that value and any `:::exit` in the same response is ignored. A run block without `return` may be followed by `:::exit`.
- `:::exit <name> [json]` ends the node through that exit. `listen` exists only when `conversational` is true. JSON is validated against the exit's schema.
- `:::end` closes the response and is the stop sequence.
- Recovery: a response with no directives is treated as `:::say text` + `:::exit listen` when `conversational`, flagged `protocol_recovered` in the trace; otherwise it is a protocol error fed back to the model.

### 6.3 Iteration loop

```
for i in 1..maxIterations:
  prompt   = build(node, state, transcript, feedback)          # 6.4
  stream   = llm.stream(prompt, stop=[":::end"])
  parse stream incrementally:
     say   → validate message, emit to outbox immediately
     run   → after stream ends: sandbox exec with tools bridged (6.5)
     exit  → validate; resolve
  outcomes:
     exit ok                     → node outcome goto("exit:<id>") | wait(listen) | handoff
     run returned a value        → feedback = result (truncated to budget); continue
     run threw / invalid code    → feedback = error with line and message; continue
     tool suspended              → persist the pending call in AutonomyMemory; node outcome wait(tool)
     exit invalid / parse error  → feedback = what was wrong and the valid options; continue
iterations exhausted            → fail("autonomy_loop_exceeded")
```

Variable writes: the guest assigns to `workflow.x` etc. After the run the patch is checked against `variableAccess` and the variable types. A rejected write is reported back to the model as feedback and does not apply.

Suspending tools: a workflow tool whose workflow waits for user input, or a code tool that calls `ctx.suspend(reason)`, aborts the run block at the call site. The checkpoint stores the pending call. When the result arrives a new iteration starts with feedback "tool X finished with … ; code after that call did not run". The tool's typing comment says so.

### 6.4 Prompt layout (ordered for prompt caching)

1. System, static per engine version: role, protocol rules, sandbox rules.
2. System, static per node version: `tools.d.ts` generated from tool schemas (TypeScript declarations with doc comments), message types available, exit list with schemas.
3. System, per conversation: rendered instructions, bot identity, locale guidance ("reply in the user's language and dialect unless instructed otherwise").
4. Messages: conversation summary (if any) then the transcript window, user and assistant roles. Inbound content is always in user-role messages and tool output is wrapped in a clearly delimited data block; neither is ever placed in the system prompt.
5. Final user-role block: current variable values the node may read, date and time, iteration feedback, remaining iterations.

Transcript window: newest messages up to a token budget (default 6,000). Older content is summarised by the utility model into `state.summary` when the window overflows.

### 6.5 Tool execution and safety

- Tool calls arrive from the sandbox as `tool_call` frames; the worker validates input against the schema, executes, validates output, records a span, and returns the result.
- Each tool has `sideEffects: boolean`. Tools with side effects are never retried automatically.
- KB results include citation tokens `[[c1]]`; the engine maps tokens in outgoing messages to `message.citations` and strips them from text.
- Prompt injection is assumed to succeed sometimes. Containment: the model can only call listed tools with schema-valid input, can only write granted variables, can only leave through declared exits, and can only reach the network through tools the builder wrote.

### 6.6 Supported models

A model is "supported" for the Autonomous Node only if it passes the adherence suite (`packages/autonomy/evals`, ≥ 98% protocol-valid responses over the English and Arabic sets). The registry (`packages/llm/models.json`) records `autonomy: supported | experimental | unsupported`; the Studio warns on anything else. A second protocol based on native tool calling is designed behind the same `AutonomyProtocol` interface and is built only if evals demand it.

## 7. Model layer (ADR-010)

`packages/llm` exposes `stream`, `generateObject`, `embed`, `rerank` over a provider interface. Adapters: Anthropic, OpenAI, Google, OpenAI-compatible (covers vLLM, Ollama, OpenRouter). Model resolution: node override → bot default → workspace default. Credentials: workspace BYOK from `workspace_secrets`, else platform keys if the plan allows. Every call records a usage event with tokens (input, cached input, output), latency and cost from the registry price table. Retries: 2 with jittered backoff on 429 and 5xx, then the configured fallback model. A separate **utility model** setting serves summarisation, extraction, classification, condition drafting and eval judging.

## 8. Knowledge bases (ADR-007)

### 8.1 Ingestion pipeline

`fetch → parse → normalise → chunk → embed → index`, one BullMQ job per stage per document, progress in `kb_ingestion_jobs`, each stage idempotent by `content_hash`.

- **Fetch**: uploads from object store; URLs through the egress proxy; sitemap and crawl respect `robots.txt`, same-origin by default, max pages and depth, 1 request/second per host.
- **Parse**: `apps/parser` (Docling) returns Markdown with heading structure and tables. HTML pages use Readability then Markdown conversion. Pages with almost no extractable text are sent as images to a vision model for OCR. A parse-quality score (text density, replacement-character ratio, reading-order heuristics for RTL) is stored; low scores show a warning on the document.
- **Normalise** (`packages/retrieval/arabic.ts`, used at index **and** query time): Unicode NFKC; strip tashkeel and tatweel; unify alef forms; `ى→ي`; `ة→ه`; Arabic-Indic digits to ASCII; lower-case Latin. Then light stemming (definite article and common prefixes and suffixes) to produce lexical tokens. Original text is kept for display and embedding.
- **Chunk**: structure-aware. Split on headings; tables are atomic; target 350 tokens, max 500, 15% overlap within a section; each chunk stores `heading_path`. The embedded string is `heading_path + "\n" + text`.
- **Embed**: model from the KB's `embedding_model`; vectors are 1024-dimensional (models are configured or truncated to 1024). Changing the model bumps `index_version` and re-embeds in the background; search uses the old version until the new one is complete.
- **Index**: `lex = to_tsvector('simple', <stemmed normalised tokens>)`.

### 8.2 Search

`kb.search({ query, kbIds, topK = 5, filters? })`:

1. Dense: top 30 by cosine with `hnsw.iterative_scan = relaxed_order`, filtered by KB and `index_version`.
2. Lexical: top 30 by `ts_rank_cd` on `lex` using the same normalisation on the query.
3. Fuse with reciprocal rank fusion (k = 60).
4. Rerank the top 30 with the configured cross-encoder; return `topK` with scores, heading path, document title and URI, and citation tokens.

Each stage writes its candidates and scores into the retrieval span so the trace shows why a chunk ranked. The Studio's retrieval playground calls the same function.

## 9. Bridge (ADR-005)

Contract: `04-contracts/bridge-api.openapi.yaml`. Summary of semantics:

### 9.1 Inbound
Authenticated by a bridge key (`Authorization: Bearer wk_bridge_…`). Messages and events address a conversation by the caller's own id; conversation and user are created on first use. `user` data in the request body is merged into `end_users.attributes`. `Idempotency-Key` is honoured for 24 h.

### 9.2 Outbound webhooks
- Transactional outbox: events are rows written in the same transaction as the state change.
- One delivery stream per conversation, ordered by `seq`. Event `n+1` is not sent until `n` is delivered or dead-lettered.
- Signature: `X-Wakeel-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`; also `X-Wakeel-Event-Id`, `X-Wakeel-Delivery-Attempt`. Receivers reject timestamps older than 5 minutes. Two secrets can be active during rotation; both signatures are sent as `v1=` entries.
- Success is any 2xx within 10 s. Retries: 5 s, 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h with ±20% jitter, then `dead`. Dead events are listed and replayable from the Studio and API. Twenty consecutive dead events set the connection to `disabled` and notify workspace admins.
- Delivery goes through the egress proxy.

### 9.3 Sync and streaming
- `?wait=<seconds>` (max 55) on the inbound call holds the request until the turn completes and returns the bot's messages and events for that turn. On timeout it returns `202` with `turnId`; the rest arrives by webhook or `GET /turns/{turnId}`.
- `Accept: text/event-stream` streams the same events as SSE. The emulator uses this.
- Webhooks, when configured, are still sent in sync mode; each event carries `turnId` so a caller can de-duplicate.

### 9.4 Handoff
A handoff card or exit sets status `handed_off` and emits `handoff.requested { reason, summary, variables }`. The bot stays silent and records inbound messages until `POST …/handoff/release`. This replaces the status-polling and flag-reset workarounds in Eyad's current bridge.

## 10. Tables

Rows are JSONB keyed by column id in `table_rows.data`. Column types: `string, number, boolean, date, enum, json`. Limits by plan (defaults 50 tables, 50 columns, 100,000 rows, 16 KB per row). Filters use a JSON AST (`eq, ne, gt, gte, lt, lte, in, contains, startsWith, isNull, and, or, not`) compiled to parameterised SQL by `packages/db/tables/filter.ts`; raw SQL never comes from a tenant. Columns marked searchable contribute to `lex` using the same normalisation as KBs. Operations: `find` (filter, sort, limit ≤ 500, cursor), `get`, `insert` (≤ 500 rows), `update`, `upsert` (by a unique column), `delete`.

## 11. Queues (ADR-008)

| Queue | Job | Concurrency key | Retry |
|---|---|---|---|
| `turn` | process a conversation's inbox | conversation lease | none at job level; inbox + lease give at-least-once |
| `webhook` | deliver next event for a conversation stream | conversation | schedule in section 9.2 |
| `kb-ingest` | one pipeline stage for one document | per workspace cap | 5, exponential |
| `kb-sync` | scheduled re-crawl | source | 3 |
| `eval` | run one eval case | per workspace cap | 1 |
| `maintenance` | janitor, partition creation, usage roll-up, retention | singleton | — |

Per-workspace fairness: a Redis token bucket per workspace gates `turn` starts; a workspace over its concurrency share is delayed, not failed.

## 12. Observability (ADR-009)

Span kinds: `turn`, `node`, `card`, `autonomy.iteration`, `llm.call`, `code.exec`, `tool.call`, `kb.search`, `table.op`, `webhook.delivery`, `error`. `attrs` holds small structured fields (model, tokens, cost, latency, ids). Payloads over 8 KB (prompts, generated code, tool input and output) go to the object store under `payload_key`; smaller ones are inline. Redaction runs before write. Retention defaults: spans 30 days, conversations 90 days, both configurable per plan.

The trace viewer and the emulator read the same spans; emulator spans stream over SSE as they are written. Optional OTLP export of span metadata (not payloads) to the operator's collector.

Platform metrics (Prometheus): turn latency histogram, queue depth, lease contention, sandbox exec time and kills, LLM error rate by provider, webhook success rate, RLS-denied queries (should be zero).

## 13. Metering and quotas

Usage kinds: `conversation` (first turn of a live conversation in a billing month with ≥ 2 user messages, counted when the second arrives), `llm_tokens`, `embedding_tokens`, `rerank_units`, `code_ms`, `kb_storage_bytes`, `table_rows`, `webhook_deliveries`. Emulator and eval modes are recorded with their `mode` and excluded from billable totals.

Quota checks use Redis counters keyed by workspace and period, reconciled from `usage_events` hourly. On exceeding a hard cap: live turns send `bot.settings.quotaMessage`, emit `error { code: 'quota_exceeded' }`, and skip model calls. A `BillingAdapter` interface receives daily roll-ups; the default implementation is a no-op that only stores them.

## 14. Evals

A case is a script of turns (`user` message, `event`, `expectSilence`, `newConversation`) with assertions: `contains`, `notContains`, `matches`, `judge` (utility model with a rubric), `toolCalled` (with input matchers), `toolNotCalled`, `toolOrder`, `reachedNode`, `exitTaken`, `variable`, `handoffRequested`, `messageType`, `citesDocument`, `maxLatencyMs` (schema: `04-contracts/eval.ts`). Runs execute through the Bridge API in `eval` mode against the draft or a version, so they exercise the real engine. Results link to the conversation and its traces.

## 15. Scaling and cost

- **Stateless tiers** (`api`, `worker`, `sandbox`) scale horizontally. The conversation lease and the outbox make workers interchangeable.
- **First bottleneck** is LLM latency, not CPU: a worker process handles ~50 concurrent turns (I/O bound). Size workers by concurrent turns, not requests per second.
- **Sandbox**: one QuickJS runtime per execution, ~1–3 ms to start from a warm pool; pool size = CPU cores × 2 per replica.
- **Postgres** grows fastest in `trace_spans`, `messages`, `kb_chunks`. Partition spans and usage monthly; drop partitions for retention. At about 50 M spans or 20 M chunks, revisit ADR-009 and ADR-007 (ClickHouse, dedicated vector store).
- **Starting footprint** (estimate, to be validated by the load test in the final phase): one 8 vCPU / 32 GB host or equivalent managed services runs everything for roughly 50 concurrent turns and 5 M chunks.

Cost per autonomous turn ≈ `iterations × (uncached_input × p_in + cached_input × p_cache + output × p_out) + rerank + embedding(query)`. With a 3,000-token cached prefix, 1,500 uncached input tokens, 250 output tokens and 1.5 iterations, model spend dominates everything else by two orders of magnitude; infrastructure per turn is negligible. Levers, in order: prompt caching (layout in 6.4), utility-model routing, transcript budget, `topK`.

## 16. Security and threat model

Assets: tenant bot definitions, conversation content, end-user data, KB documents, tenant secrets, platform model keys, platform availability.
Actors: anonymous internet, end users (through a bridge), tenant builders (authenticated, write code), compromised tenant, compromised bridge key, malicious document or web page, insider.

| # | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | Cross-tenant data access through a missing filter or guessed id | Forced RLS; `withWorkspace`; no raw pool; ids are unguessable but never relied on | Two-tenant test harness on every repository; RLS-denied metric |
| T2 | Tenant code or model-generated code escapes the sandbox | Four layers in 5.3; no credentials in the sandbox; no fallback driver | Escape test suite (prototype pollution, host object probing, memory and CPU bombs, async floods); **human review**; external pen-test |
| T3 | SSRF from `fetch`, crawler or webhook URL | Single egress proxy with DNS pinning and range blocks | SSRF test matrix (IPv4/IPv6 literals, decimal and octal IPs, redirects, DNS rebinding) |
| T4 | Prompt injection through user text, KB content or tool output | Data never enters the system prompt; schema-validated tools, exits and variable writes; side-effect tools explicit; egress only through builder tools | Injection eval set in the adherence suite |
| T5 | Secrets leak into traces, logs or model prompts | Envelope encryption at rest; per-execution redaction set; `env` never rendered into prompts by the engine | Redaction tests with canary secrets |
| T6 | Forged or replayed webhooks at the receiver; forged inbound calls | HMAC with timestamp; rotation; bridge keys hashed at rest, scoped to one connection | Signature test vectors in the OpenAPI examples |
| T7 | Stolen session or API key | HttpOnly SameSite=Lax cookies, CSRF token on mutations, key prefixes for revocation, last-used tracking, audit log | Auth tests; **human review** |
| T8 | Noisy neighbour or abuse exhausts capacity | Per-workspace token buckets, quotas, step and time limits, body size limits | Load test |
| T9 | Stored XSS in Studio from bot content, KB text or trace payloads | All such content rendered as text or through a sanitising Markdown renderer; strict CSP; no `dangerouslySetInnerHTML` | Lint rule; Playwright XSS fixtures |
| T10 | Malicious upload (parser exploit, zip bomb) | Parser in its own container without credentials or network; size, page and time limits; MIME sniffing | Fuzz fixtures |
| T11 | Dependency compromise | Lockfile with integrity; exact pins for auth, crypto, sandbox and model packages; no install scripts; weekly audit | CI |
| T12 | Insider or support access | `app_admin_ro` role, break-glass function with audit entry | Audit tests |
| T13 | Platform model keys abused by a tenant | Platform keys only on plans that allow it; per-workspace spend cap; utility calls metered | Metering tests |

Tasks touching T1, T2, T3, T6 or T7 are marked **HUMAN REVIEW REQUIRED** in the build plan.

## 17. Configuration

All configuration is parsed once by `packages/config` with zod; a missing or invalid variable stops the process with a message naming the variable. Secrets come from the environment or a mounted file. `MASTER_KEY` (32 bytes, base64) wraps per-row data keys; `key_version` on encrypted rows allows rotation.
