# ADR-001 — Stack: accept the default, with five additions

Status: accepted · Date: 2026-11-13

## Context
The brief proposes: TypeScript monorepo (pnpm + turbo), Fastify, Postgres + pgvector with RLS, Redis + BullMQ, React + xyflow + Motion + Radix + Tailwind, Monaco, provider-agnostic LLM layer. It asks for challenges where a better option exists.

## Decision
Accept the default. Add or pin the following:

| Area | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5.x strict, ESM only | Current LTS; one module system |
| Validation | zod 4 everywhere; `packages/contracts` is the only place schemas are defined | One source for API, DB JSON columns, Studio forms |
| DB access | Drizzle ORM for typed queries; **migrations are hand-written SQL files** applied by a small runner | RLS policies, partitions and roles must be reviewed as SQL, not generated |
| Auth | `better-auth` for sessions, password hashing and OAuth only; workspaces, memberships and RBAC are our own tables | Avoids hand-rolling session crypto; keeps the tenancy model under RLS |
| Studio shell | Vite SPA, TanStack Router and Query, Zustand for canvas state | An authenticated tool gains nothing from SSR; see ADR-011 |
| Document parsing | A Python sidecar (`apps/parser`) running Docling | The one place the TypeScript-only rule is broken; Node PDF libraries lose tables and reading order, worst on Arabic; see ADR-007 |
| API docs | OpenAPI 3.1 generated from zod for the Studio API; the Bridge API spec is hand-written and is the contract | The bridge spec is a product surface |
| Tests | Vitest (unit, integration against real Postgres and Redis via Testcontainers), Playwright (e2e and screenshots) | |
| Lint/format | Biome | One fast tool |

## Alternatives considered
- **Next.js for Studio**: adds a server we do not need and couples deploys.
- **Prisma**: weaker control over RLS session settings and raw SQL migrations.
- **Kysely**: fine; Drizzle chosen for schema-as-code ergonomics. Either works; do not mix.
- **NestJS**: heavier than the service count justifies.
- **Temporal** instead of BullMQ: see ADR-008.

## Consequences
- One non-Node service to build and deploy.
- The executor must read current docs for `better-auth`, Drizzle, zod 4 and xyflow 12 before using them; do not rely on memory for their APIs.

## Revisit when
A dependency is abandoned or a security advisory cannot be patched within a week.
