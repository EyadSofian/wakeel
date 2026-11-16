# Wakeelk project guide

This is a single entry point to the Wakeelk repository, based on the checked-in product documents, service entry points, package manifests, API routes, database migrations, Studio routes, tests, and operational notes. The public brand is Wakeelk and the compatible internal package scope remains `@wakeel`.

## What the project does

Wakeelk is a multi-tenant platform for building and running conversational LLM agents. A builder creates a bot in the Studio, combines deterministic workflow cards with optional Autonomous Nodes, tests it in an emulator, and publishes an immutable version. External channel or inbox systems send messages through the Bridge API and receive replies through signed webhooks, synchronous responses, or server-sent events. The platform stores conversation state and traces, runs custom JavaScript in a separate sandbox, and provides knowledge-base search, typed tables, metering, and evaluations.

The product is aimed at teams that already own their channels, particularly Arabic and bilingual customer conversations. It does not aim to be an inbox, a native channel aggregator, or a general workflow automation product. See [product thesis](docs/02-product-thesis.md) for the target user and scope.

## Repository map

| Area | Responsibility |
| --- | --- |
| `apps/api` | Fastify server for Studio and Bridge APIs. `ROLE=studio`, `bridge`, or `all` controls route mounting. |
| `apps/worker` | BullMQ consumers for turns, webhooks, knowledge ingestion and sync, evaluations, and maintenance. |
| `apps/studio` | React 19/Vite application: canvas, inspector, emulator, connections, versions, knowledge, tables, conversations, traces, evals, and settings. |
| `apps/sandbox` | Separate QuickJS-WASM process pool for builder and model-generated JavaScript. |
| `apps/egress` | Guarded outbound HTTP service used by sandbox fetches and other external calls. |
| `apps/parser` | Python/FastAPI and Docling service that converts uploaded documents to structured text. |
| `apps/adapter-chatwoot` | Reference adapter between a Chatwoot agent bot and the public Bridge API. |
| `packages/contracts` | Zod data contracts, identifiers, bot definitions, validation, errors, messages, evals, and trace shapes. |
| `packages/config` | Parsed environment variables, limits, and brand configuration. |
| `packages/db` | PostgreSQL migrations, Drizzle schema, repositories, RLS-scoped access, encryption, and object storage. |
| `packages/auth` | Sessions, API keys, authentication, and role checks. |
| `packages/engine` | Workflow and card execution state machine with I/O behind ports. |
| `packages/autonomy` | Autonomous Node prompt, protocol, iteration, and tool-call logic. |
| `packages/sandbox-client` | Typed client and ports for sandbox execution. |
| `packages/llm` | Model registry and provider adapters. |
| `packages/retrieval` | Arabic normalization, parsing, crawling, chunking, embedding, and hybrid retrieval. |
| `packages/bridge` | Bridge message handling, signing, delivery, and SSE helpers. |
| `packages/telemetry` | Traces, usage, metrics, audit, and billing interface. |
| `packages/evals` / `packages/cli` | Assertion logic and command-line eval runner. |
| `packages/ui` / `packages/testing` | Studio design primitives and shared test fixtures. |
| `docs` | Product thesis, normative architecture, contracts, ADRs, build plan, reviews, security notes, and runbooks. |
| `infra` / `examples` / `tools` | Infrastructure definitions, reference receiver, checks, and pilot utilities. |

The pnpm workspace includes `apps/*`, `packages/*`, `examples/*`, and `tools`. TypeScript is strict ESM. The intended dependency direction is apps to packages; the engine and autonomy packages expose ports so the worker supplies database, model, retrieval, and sandbox implementations. Start with [architecture](docs/03-architecture.md) and [build plan](docs/06-build-plan.md) for the normative design. Later ADRs and code may refine older statements in those documents.

## Runtime flow

1. A bridge client calls the authenticated `/v1/bridge` API with its external user and conversation IDs. The API writes an inbound event and enqueues a `turn` job. The same path supports synchronous waiting and SSE.
2. A worker takes a conversation lease, processes pending events in order, loads the pinned published definition or draft target, and runs the engine. Conversation state lives in PostgreSQL; the queue wakes workers but is not the source of truth.
3. The engine executes workflow cards, commits steps, and can call ports for model requests, sandboxed code, knowledge search, tables, and Autonomous Nodes. The autonomy layer proposes code, tool calls, and exits; contracts and the engine validate the result.
4. Outbound messages and lifecycle events enter an outbox. Webhook workers deliver them in conversation order, sign each request, retry failures, and surface dead deliveries for replay. A handoff silences the bot until the bridge releases it.
5. Each turn records trace spans and usage. The Studio emulator and trace viewer consume the same runtime evidence. Emulator and eval traffic carry separate modes and are excluded from billable live totals.

Useful implementation entry points: [`apps/api/src/app.ts`](apps/api/src/app.ts), [`apps/api/src/routes/bridge/index.ts`](apps/api/src/routes/bridge/index.ts), [`apps/worker/src/main.ts`](apps/worker/src/main.ts), [`apps/worker/src/turn/drain.ts`](apps/worker/src/turn/drain.ts), [`packages/engine/src/turn.ts`](packages/engine/src/turn.ts), and [`packages/autonomy/src/engine.ts`](packages/autonomy/src/engine.ts).

## Data and security model

The workspace is the tenant boundary. Tenant-owned PostgreSQL tables carry `workspace_id` and use forced row-level security. API and worker database access is scoped through `withWorkspace`; startup verifies the application database role cannot bypass RLS. Draft bot documents are revisioned, with conditional writes using `If-Match`. Published versions are immutable; a conversation pins a version and may migrate on a later turn. The SQL history is in `packages/db/migrations/0001_foundation.sql` through `0023_evals.sql`.

Builder code and generated code run in `apps/sandbox`, which has no database credentials. Network access is mediated by `apps/egress`, which checks destinations and guards against SSRF. The parser is intended to run without network access or credentials. Workspace secrets and config variable values are encrypted; trace writing redacts secrets. Bridge calls use scoped keys, while outgoing webhooks use timestamped HMAC signatures and support secret rotation. These controls require the deployment environment described in [security notes](docs/security/) and [Railway runbook](docs/runbooks/deploy-railway.md); source code alone does not establish production isolation.

## Main product surfaces

- **Studio canvas:** workflow nodes and cards, variables, inspector forms, code editor, emulator, publish controls, and trace playback. Routes are defined in [`apps/studio/src/router.tsx`](apps/studio/src/router.tsx).
- **Models and autonomy:** provider keys and defaults, model registry, autonomous prompt protocol, explicit tools and exits, and AI cards. See `packages/llm`, `packages/autonomy`, and `packages/engine/src/cards`.
- **Knowledge bases:** file/text/URL sources, document parsing, Arabic normalization, chunking and embeddings, lexical plus vector search, fusion and reranking, citations, and a test-search UI. See `packages/retrieval`, `apps/worker/src/kb`, and `apps/api/src/routes/knowledge.ts`.
- **Tables:** typed columns, row validation, filter AST compiled to parameterized SQL, CSV import, card and code bindings, and a Studio grid. See `packages/db/src/tables`.
- **Conversations and traces:** history APIs, trace spans and larger payload storage, retention maintenance, and replay against a draft. See `apps/api/src/routes/conversation-history.ts`, `apps/api/src/routes/traces.ts`, and `apps/worker/src/turn/replay.ts`.
- **Evals and usage:** eval suites and assertions, worker execution through the runtime, CLI exit status, usage events and daily rollups. See `packages/evals`, `apps/worker/src/eval`, `packages/cli`, and `packages/telemetry`.
- **Chatwoot integration:** a reference adapter that maps inbound messages and outbound events, verifies signatures, deduplicates events, and handles handoff. See [adapter README](apps/adapter-chatwoot/README.md).

The Studio supports Arabic and mixed-direction bot content. The UI chrome is currently English by design. Retrieval applies the same Arabic normalization to indexed text and queries; Arabic and code-switched fixtures are a project gate.

## API orientation

The API service has `/health/live`, `/health/ready`, and `/metrics`. Studio-facing routes under `/v1` cover authentication, workspaces and members, bots and draft documents, versions, connections, emulator, models, files, knowledge, tables, conversations, traces, evals, and audit. Bridge-facing routes under `/v1/bridge` accept messages and events and expose conversation, turn, handoff, tool-result, delivery, and connection operations. The API returns structured problem documents on errors and attaches `X-Request-Id`. Request and response schemas live in `packages/contracts` and the reference contracts in [docs/04-contracts](docs/04-contracts/README.md). Check route code and those contracts before depending on a specific path or payload.

## Running locally

Prerequisites: Node.js `>=22.12 <23`, pnpm `9.12.0`, Docker for local infrastructure, and Python/uv for the parser. Model-dependent features also need provider credentials. The example environment contains **local development values only**.

```bash
pnpm install
cp .env.example .env
pnpm dev:infra
pnpm db:bootstrap
pnpm db:migrate
pnpm exec turbo run dev --filter=@wakeel/api --filter=@wakeel/worker --filter=@wakeel/sandbox --filter=@wakeel/egress --filter=@wakeel/studio
```

`pnpm dev:infra` starts PostgreSQL 17 with pgvector, Redis 7.2, and a RustFS S3-compatible store. The filtered dev command starts the core application and leaves out the optional Chatwoot adapter, which requires `ADAPTER_PAIRS`. For document parsing, also run `docker compose --profile parser up -d --build parser`; its image is large and it is not started by `dev:infra`. The API defaults to port 3000, Studio to Vite's port 5173, sandbox to 4300, egress to 4400, and parser to 4500, subject to environment configuration. Open `http://127.0.0.1:5173` for Studio. Use `pnpm dev:infra:down` to stop local dependencies without deleting volumes. See [`.env.example`](.env.example) and [`docker-compose.yml`](docker-compose.yml).

On this Mac's Colima setup, the parser's isolated Docker network does not expose its declared host port. If `curl http://127.0.0.1:4500/health/live` cannot connect after the parser starts, attach a local proxy to the two Compose networks:

```bash
docker run -d --name wakeel-parser-proxy --network wakeel_default -p 127.0.0.1:4500:4500 alpine/socat TCP-LISTEN:4500,fork,reuseaddr TCP:parser:4500
docker network connect wakeel_parser-internal wakeel-parser-proxy
```

## Checks and tests

```bash
pnpm check              # lint, licence checks, package typechecks and tests
pnpm typecheck
pnpm test
pnpm e2e                # Studio Playwright flow suite
pnpm studio:shots       # visual review artifacts
pnpm studio:motion      # interaction recordings
pnpm ui:contrast
pnpm evals:autonomy     # requires model credentials
pnpm evals:retrieval    # requires model credentials
```

Package tests use Vitest; the parser uses pytest; Studio end-to-end tests use Playwright. Database and API integration tests exercise tenant isolation and route behavior. The autonomy and retrieval model evals are separate from deterministic tests and require working model keys. The repository's [release note](docs/runbooks/releases/2026-11-15-phase-12.md) reports a 43/43 `pnpm check` run at that release; that is historical evidence, not a fresh run for this document.

## Current status and known gaps

The Wakeelk public identity is defined in `packages/config/src/brand.ts`; the compatible `@wakeel/*` packages and Bridge contracts remain unchanged. The approved raster logo is in `apps/studio/public/brand/`. The brand migration inventory and verification results are in [ADR-054](docs/adr/054-wakeelk-brand-identity.md).

The [build plan](docs/06-build-plan.md) defines Phases 0–15. The November 15 release note records an integrated Railway stack through Phase 12 and explicitly says production security acceptance and later phases remain open. The [Majed pilot note](docs/pilot/majed/README.md), dated November 16, records a Chatwoot test-inbox deployment, an 8/13 acceptance-suite result, and a 221/240 autonomy protocol-valid result, below its 98% gate. It also records open platform bugs involving repeated inactivity triggers and judge assertions on reasoning models. These are recorded project findings, not independently retested here. The pilot is not approved for live customer traffic in its own handoff notes.

The release note also leaves sandbox runtime isolation, outbound network policy, parser isolation, scheduled backups and restore testing, and real-model evaluation credentials unresolved. Consult the current deployment and issue tracker before treating any of these as closed. `apps/adapter-chatwoot/README.md` separately notes that bot-sent images/files are links and the full real-Chatwoot compose acceptance path is unfinished.

## Where to go next

| Need | Start here |
| --- | --- |
| Product intent and scope | `docs/02-product-thesis.md` |
| Normative architecture and security boundaries | `docs/03-architecture.md`, `docs/adr/`, `docs/security/` |
| Contracts and errors | `docs/04-contracts/`, `packages/contracts/src/` |
| Planned work and acceptance criteria | `docs/06-build-plan.md` |
| UI behavior and design rules | `docs/05-design-system.md`, `docs/design-reviews/` |
| Local and production operation | `.env.example`, `docker-compose.yml`, `docs/runbooks/` |
| Current pilot findings | `docs/pilot/majed/README.md` |

Repository conventions and review gates are in [`CLAUDE.md`](CLAUDE.md). Some older planning documents retain stale implementation details, such as naming the local object store MinIO; prefer the actual compose file and newer ADRs or release notes for the current implementation.
