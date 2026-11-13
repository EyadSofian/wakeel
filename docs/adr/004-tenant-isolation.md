# ADR-004 — Tenant isolation: one database, forced row-level security

Status: accepted · Date: 2026-11-13 · **Security-critical: changes need human review**

## Context
Many workspaces share one Postgres. Application-level `where workspace_id = ?` filters fail silently when one query forgets them; Flowise, Dify and Typebot all rely on that pattern.

## Decision
- Every tenant-owned table carries `workspace_id` and has `enable row level security` and `force row level security`.
- One policy shape: `using (workspace_id = current_setting('app.workspace_id', true)) with check (same)`.
- The application connects as `app_rw` (`NOBYPASSRLS`, no DDL). Migrations run as `app_migrator`.
- The only way to run a tenant query is `withWorkspace(id, fn)`, which opens a transaction and sets `app.workspace_id` with `set_config(..., true)` (transaction-local, safe with connection pooling in transaction mode).
- Pre-tenant lookups (key prefix → workspace, session → memberships) are `security definer` SQL functions owned by `app_migrator`, each returning only ids.
- If `app.workspace_id` is unset, the policy compares against NULL and returns no rows. Failing closed is the default.
- A migration test asserts that every table with a `workspace_id` column has RLS forced and exactly the standard policies.

## Alternatives considered
- **Schema or database per tenant**: strongest separation, but migrations, pooling and pgvector indexes multiply per tenant. Reserved for the dedicated-instance tier, where it is a whole separate deployment.
- **Application filters only**: rejected; one missed filter is a breach.

## Consequences
- Every new table needs a policy in the same migration; CI fails otherwise.
- Queries that aggregate across tenants (platform analytics, janitor scans) must use explicit `security definer` functions and are reviewed.
- Vector search always filters by `kb_id`; RLS adds the workspace predicate. pgvector iterative scan is enabled so filtered ANN does not under-return.
- Slight per-transaction overhead for `set_config`.

## Revisit when
A tenant requires physical isolation, or a single tenant's data dominates a shared index.
