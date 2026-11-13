# CLAUDE.md — rules for the executor

You are building `{{PLATFORM_NAME}}` (code name and package scope: `wakeel`), a multi-tenant platform for building and running conversational LLM agents. You build **only** from the documents in `/docs`. If the docs do not answer a question, you stop and ask; you do not invent architecture.

## 1. Read first

| Order | File | Why |
|---|---|---|
| 1 | `docs/02-product-thesis.md` | What we are building and what we are not |
| 2 | `docs/03-architecture.md` | Normative design. "Must" and "never" bind you |
| 3 | `docs/adr/*.md` | Why each big decision was made |
| 4 | `docs/04-contracts/` | Data shapes. Source of truth |
| 5 | `docs/05-design-system.md` | Everything visible |
| 6 | `docs/06-build-plan.md` | What to do next, in order, and how it is accepted |
| ref | `docs/01-research-report.md` | Evidence behind the decisions |
| ref | `docs/00-open-questions.md` | Decisions still owned by Eyad; check before assuming |

Before each task: read the task row, the architecture sections it cites and the contract files it touches. State in your first message which doc sections you are implementing.

## 2. How to work

1. **One task, one branch, one PR.** Branch `p<phase>-<task>-<slug>` (for example `p4-2-engine-core`). Do tasks in plan order.
2. **Tests first for logic.** For engine, autonomy, retrieval, auth and bridge code, write the failing test, then the code.
3. **Run `pnpm check` before you say you are done.** Paste the result summary in the PR.
4. **Verify what you built.** For API work, call it. For Studio work, run it and do the screenshot review. "It compiles" is not verification.
5. **Report faithfully.** If something is not done, not tested or not working, say so in the PR description. Never mark a task done with a skipped test.
6. **Stop at 🔒.** Tasks marked HUMAN REVIEW REQUIRED end at an open PR. Do not merge, and do not start work that depends on it until Eyad approves in writing.
7. **Small commits with a reason.** Imperative subject, body says why.

## 3. Changing the design

You may not silently change architecture, contracts, tokens or the plan.

- If a doc is wrong, incomplete or contradicts another: write `docs/adr/NNN-<slug>.md` with **Status: proposed**, covering context, the options, your recommendation and the consequences. Open it as its own PR. Continue only on work the question does not affect.
- Small clarifications (a missing field, an obviously mistyped name) may be fixed in the same PR with a line in the description under "Doc corrections".
- Never "temporarily" work around a rule. A temporary workaround is a design change.

## 4. Repo layout

```
apps/      api  worker  sandbox  parser  egress  studio  adapter-chatwoot (Phase 14)
packages/  contracts config db auth engine autonomy sandbox-client llm retrieval
           bridge telemetry evals ui testing cli
docs/      specs, ADRs, contracts, design reviews, security notes, runbooks
examples/  bridge receiver, Chatwoot compose
infra/     docker, postgres init, dashboards, deployment
tools/     lint rules, licence check, contrast check, load tests
```

Dependency direction: `apps → packages`; `engine` and `autonomy` depend only on `contracts` and declare ports; nothing imports from `apps`. `packages/ui` has no data fetching.

## 5. Commands

```bash
pnpm install
pnpm dev:infra          # Postgres + pgvector, Redis, MinIO
pnpm db:migrate         # apply SQL migrations as app_migrator
pnpm dev                # api, worker, sandbox, egress, studio
pnpm check              # typecheck + lint + unit + integration + contract tests
pnpm test --filter <pkg>
pnpm e2e                # Playwright against the dev stack with the fake LLM
pnpm studio:shots       # screenshots of every screen and state, light and dark
pnpm studio:motion      # short recordings of scripted interactions
pnpm ui:contrast        # token contrast check
pnpm evals:autonomy     # protocol adherence suite (needs model keys)
pnpm evals:retrieval    # retrieval golden sets (needs model keys)
pnpm licences           # third-party licence check
```

If a command in this list does not exist yet, creating it is part of Phase 0.

## 6. Conventions

**TypeScript.** Strict. ESM. No `any` without a comment. No default exports except where a tool requires them. Types come from zod (`z.infer`), not hand-written duplicates. Errors are values with a code from `errors.ts`; throw `AppError(code, params)` and let the boundary map it.

**Naming.** Files `kebab-case.ts`; React components `PascalCase.tsx`; database `snake_case`; JSON and TypeScript `camelCase`; ids per ADR-012 and only created through `packages/contracts/src/ids.ts`.

**Database.** Migrations are hand-written SQL in `packages/db/migrations/NNNN_<name>.sql`, forward-only, reviewed. Every tenant table: `workspace_id text not null`, RLS enabled and forced, the standard policy, a two-tenant test. All tenant queries go through `withWorkspace`. JSON columns are parsed with their zod schema on read and on write.

**API.** Routes validate input and output with zod. Errors are problem documents. Lists are cursor-paginated. Mutable documents use `ETag` / `If-Match`.

**Engine.** Pure. All I/O through ports. Every step is one transaction and must be safe to run again.

**Studio.** Tokens only: no raw colours, no arbitrary pixel values, no inline styles for colour or spacing. Motion values only from `packages/ui/src/motion.ts`. The canvas document changes only through store commands. User-, bot- or model-written text renders with `dir="auto"` and is never passed to `dangerouslySetInnerHTML`. Names and button labels follow design system §3.

**Copy.** Sentence case. One verb per action. Errors say what happened and how to fix it. No exclamation marks.

**Comments.** Explain why, not what. Public functions in `engine`, `autonomy`, `retrieval` and `bridge` have a doc comment.

## 7. Testing policy

| Code | Required tests |
|---|---|
| `packages/contracts` | Fixture parse and reject tests; OpenAPI agreement test; migration fixtures |
| `packages/engine`, `packages/autonomy` | Table-driven unit tests with the fake LLM and fake clock; ≥ 90% line coverage; no network |
| `packages/db` | Integration against real Postgres; two-tenant test per table and repository |
| `packages/retrieval` | Unit for normaliser, chunker, fusion; integration for search; golden-set report on change |
| `packages/bridge`, API routes | Integration; contract tests generated from the OpenAPI file |
| `apps/sandbox`, `apps/egress` | Integration plus the escape and SSRF suites; these suites only grow |
| `apps/studio` | Unit for stores and commands; Playwright for flows; screenshot and motion reviews |

Tests never call a real model unless they live under an `evals/` directory. Tests never sleep on real time; use the fake clock. A flaky test is a bug: fix it or delete it with a reason, never retry-wrap it.

## 8. The screenshot review loop (every visible change)

Full rules: `docs/05-design-system.md` §8. In short:

1. `pnpm studio:shots --screen <id>`.
2. **Open and look at** the PNGs in `apps/studio/.shots/<screen>/` (light and dark, both sizes, including the `rtl` state).
3. Answer all 19 checklist questions with pass or fail and one sentence of evidence in `docs/design-reviews/<task-id>.md`.
4. Fix every fail. Re-shoot. Repeat until zero fails.
5. For interactions, `pnpm studio:motion --screen <id>` and check frames against the motion tables.
6. Update baselines and commit them with the review file.

A review with no evidence, or one that passes everything on the first pass, will be sent back.

## 9. Never

Security
- Never run tenant or model-written code outside `apps/sandbox`. No `eval`, `new Function`, `vm`, or a "dev mode" fallback, anywhere.
- Never query tenant data without `withWorkspace`. Never give the application role `BYPASSRLS`. Never disable RLS "for a migration".
- Never make an outbound HTTP request to a tenant-supplied URL except through `apps/egress`.
- Never log, trace, return or put into a prompt: secrets, API keys, session tokens, signing secrets.
- Never put end-user text, KB text or tool output in a system prompt.
- Never merge a 🔒 task yourself.
- Never weaken or delete an escape, SSRF, two-tenant or redaction test to make a build pass.

Licences
- Never copy code, assets, layouts or text from: Botpress v12 (AGPL), Typebot (FSL), Dify (modified Apache, no multi-tenant), Hexabot (FCL), n8n (Sustainable Use), Flowise `enterprise/`. Concepts only. Do not clone these repositories into the workspace.
- Never copy Botpress branding, icons or screen layouts.
- When you reuse MIT or Apache-2.0 code, add it to `THIRD_PARTY_NOTICES.md` in the same PR with the source URL, commit and licence. LLMz is "concepts only": do not copy its source.
- Never add a dependency without checking its licence; `pnpm licences` must pass.

Product
- Never build native channel integrations, an agent inbox, or general workflow-automation features.
- Never add an implicit tool to an Autonomous Node. Every tool the model can call is listed on the node.
- Never bill, count or rate-limit emulator and eval traffic as live conversations.
- Never fail silently. Every failure has a code, a title and a fix, and appears in the trace.

Design
- Never use a gradient, glow, glass blur, emoji icon, all-caps label, second accent colour, or a shadow on something that does not float.
- Never ship a screen without its empty, loading, error and RTL states.
- Never write an animation value in a component.

Process
- Never change `/docs` contracts, architecture or tokens without an ADR.
- Never say a task is done when a check is failing, skipped or not run.
- Never guess a library's API from memory for `zod` 4, `@xyflow/react` 12, `better-auth`, `drizzle-orm`, `quickjs-emscripten`, `bullmq`, `motion`, Tailwind 4 or the AI SDK. Read the installed version's docs or types first.
- Never use real customer data in tests or fixtures.

## 10. When you are unsure

Ask, with a specific question and your recommended answer. Good: "The plan says per-step transactions, but streaming a model reply spans one step for 10+ seconds and would hold a transaction open. I propose writing messages as they complete and committing state at step end. OK?" Bad: silently holding the transaction open, or silently changing the persistence model.

## 11. Arabic is a gate

Any change to retrieval, message rendering, text inputs, truncation, search or evals is checked with Arabic and mixed-direction fixtures (`packages/testing/fixtures/rtl.ts`) before it is done. Normalisation for search must be the same function at index time and query time. Eval sets include Egyptian and Gulf dialect and Arabic–English code-switching.
