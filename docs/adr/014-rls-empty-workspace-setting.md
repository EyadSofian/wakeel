# ADR-014 — RLS policy: treat an empty workspace setting as unset

Status: proposed · Date: 2026-11-13 · **Security-critical: amends ADR-004; needs human review**

## Context
ADR-004 fixes one policy shape:

```sql
using (workspace_id = current_setting('app.workspace_id', true))
with check (workspace_id = current_setting('app.workspace_id', true))
```

and says: "If `app.workspace_id` is unset, the policy compares against NULL and returns no rows. Failing closed is the default."

That holds only for a connection that has never set the variable. Task 0.5 tested it on Postgres 17.12 as `app_rw`:

| Session state | `current_setting('app.workspace_id', true)` | Bare `insert … workspace_id = ''` | Bare `select` sees those rows |
|---|---|---|---|
| Fresh connection | `NULL` | rejected | no |
| After one `withWorkspace` (local `set_config`, then commit) | `''` | **succeeds** | **yes** |

Once a custom setting has been defined in a session, Postgres keeps it defined with an empty value after a transaction-local assignment ends. Pooled connections are reused, so after first use every pooled connection is in the second state. A query that reached such a connection without going through `withWorkspace` would see and write a shared pseudo-tenant whose `workspace_id` is `''`.

Why this is not exploitable today:

- `packages/db` never exposes the pool; the only query path is `withWorkspace`, which always sets the variable for the transaction.
- `withWorkspace` rejects anything that is not a `ws_` id, so it can never set `''`.
- A lint rule bans the Postgres drivers outside `packages/db`.

These are application-level guards. ADR-004 exists so tenant isolation does not depend on application code being right; the database layer should fail closed by itself.

## Options
1. **`nullif` in the policy** (recommended):
   ```sql
   using (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
   with check (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
   ```
   An empty setting becomes NULL, which matches no row and allows no write. Same cost as today; one place to change (`app_internal.enable_tenant_rls` and `STANDARD_POLICY_EXPRESSION` in `findRlsProblems`).
2. **A check constraint on every tenant table**, `check (workspace_id ~ '^ws_[0-9a-hjkmnp-tv-z]{26}$')`. Stops `''` rows from being written at all, but a reused connection could still read any that exist, and every table carries the regex.
3. **`discard all` / `reset app.workspace_id` when a connection returns to the pool.** Depends on the pool hook running every time (it is application code again) and costs a round trip per checkout.
4. **Keep ADR-004 as is** and rely on the application guards. Correct the ADR's wording so it does not overstate fail-closed.

## Recommendation
Option 1, and also correct ADR-004's sentence about failing closed. Optionally add option 2 later for defence in depth.

Change set if accepted (one small PR on top of task 0.5, before any tenant table exists, so no data migration is needed):

- Migration `0001_foundation.sql` is not yet applied anywhere that matters, but it is checksummed; the change goes in `0002` as `create or replace procedure app_internal.enable_tenant_rls` with the new expression. (If Phase 1 has already created tables, `0002` also re-creates their policies.)
- `STANDARD_POLICY_EXPRESSION` in `packages/db/src/rls.ts` changes to match.
- A new integration test: on a pooled connection that has already run `withWorkspace`, a bare query reads no rows and cannot insert `workspace_id = ''`.

## Consequences
- ADR-004's "one policy shape" changes text; the migration-time check enforces the new one.
- No runtime cost difference.
- Until this is decided, task 0.5 implements ADR-004 exactly as written, and the gap is documented in its PR.

## Revisit when
Postgres changes how custom settings behave after a transaction-local assignment, or we move off session-variable RLS.
