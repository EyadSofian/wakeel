# ADR-015 — Auth tables follow better-auth; pre-tenant lookups run as a dedicated role

Status: accepted (decision 1, Eyad, 2026-11-13) · proposed (decision 2, reviewed with task 1.1) · Date: 2026-11-13 · **Security-critical: changes need human review**

## Context

Two documents disagree, and one rule cannot be built as written.

1. ADR-001 picks `better-auth` for sessions, password hashing and OAuth. Architecture §2.3 lists `users(… password_hash, email_verified_at …)` and `sessions(… token_hash …)`. better-auth 1.7.23 (read from the installed package, `@better-auth/core/dist/db/get-tables.mjs` and `better-auth/dist/db/internal-adapter.mjs`) needs four tables:
   - `user(id, name, email unique, emailVerified boolean, image, createdAt, updatedAt)`
   - `session(id, userId, token unique, expiresAt, ipAddress, userAgent, createdAt, updatedAt)`. The token is a random 32-character string stored as it is. The cookie carries the token signed with HMAC under the auth secret.
   - `account(id, userId, accountId, providerId, password, accessToken, refreshToken, idToken, …)`. The password hash is stored here, under provider `credential`.
   - `verification(id, identifier, value, expiresAt, createdAt, updatedAt)`
   Table and column names can be remapped (`modelName`, `fields`), and ids can come from our generator (`advanced.database.generateId`). Which tables exist and what each column holds cannot be changed.

2. ADR-004 says pre-tenant lookups are `security definer` functions **owned by `app_migrator`**. Every tenant table is created by `app_migrator` and has `force row level security`, so its owner is bound by the policy too. Inside such a function `app.workspace_id` is unset, so the function would see no rows and every lookup would return nothing.

## Decision 1 — the auth tables follow better-auth (accepted)

Architecture §2.3's platform auth tables become:

- `users(id usr_, email citext unique, name, email_verified boolean, image?, locale)`
- `sessions(id ses_, user_id, token unique, expires_at, ip_address?, user_agent?)`
- `accounts(id acc_, user_id, provider_id, account_id, password?, access_token?, refresh_token?, id_token?, access_token_expires_at?, refresh_token_expires_at?, scope?)`, unique `(provider_id, account_id)`
- `verifications(id vrf_, identifier, value, expires_at)`

All four are platform tables (no `workspace_id`) with snake_case columns, mapped through better-auth's `modelName` and `fields` options. better-auth's ids are replaced with `newId("usr" | "ses" | "acc" | "vrf")`.

What this means for security (T7):
- A row from `sessions` alone is not a usable credential: the cookie must carry the token signed with the auth secret (`AUTH_SECRET`). The bearer plugin, which accepts the token without that signature, is **not** enabled. Turning it on later needs an ADR.
- Password hashing is better-auth's (scrypt), not ours.
- Once OAuth is enabled, tokens in `accounts` must be stored encrypted (`account.encryptOAuthTokens`). That is part of the task that adds OAuth.

Alternative considered: drop better-auth and own sessions (scrypt from `node:crypto`, SHA-256 token at rest). It matches the old §2.3 exactly and adds no dependency, but OAuth would become our own work, and ADR-001 deliberately avoids hand-rolled session code. Rejected by Eyad.

## Decision 2 — lookup functions are owned by `app_lookup` (proposed)

- `bootstrapDatabase` creates `app_lookup`: `nologin`, `bypassrls`, no other attributes. Nobody can connect as it.
- `app_migrator` gets membership in `app_lookup` with `inherit false, set true`, only so a migration can make it the owner of a function. `app_migrator` already owns every table and could turn RLS off, so this gives it no new power. `app_rw` and `app_admin_ro` get no membership and cannot `set role app_lookup`.
- `app_lookup` gets `select` on exactly the columns each lookup reads, granted in the migration that creates the function.
- Each lookup is a `security definer` SQL function in the schema `lookup`, owned by `app_lookup`, with `set search_path = pg_catalog, public`. It returns only ids. Execute is revoked from `public` and granted to `app_rw` one function at a time, before the owner changes, because after that `app_migrator` can no longer change the grants. `app_lookup` has `create` on `lookup` only, because a new function owner needs it, and no `create` anywhere else.
- The lookups for task 1.1: a user's workspace ids, an API key prefix to its key and workspace ids, and an invitation token hash to its invitation and workspace ids.

Alternatives considered:
- A second, permissive policy per table for the lookup: rejected. ADR-004 allows exactly one policy shape, and `findRlsProblems` enforces it.
- Giving `app_migrator` `bypassrls`: rejected. Every function and table it owns would then skip RLS by default, not just the reviewed lookups.
- A shadow table without `workspace_id` that maps a key prefix to its workspace: rejected. It would hide tenant data from the RLS check.

## Consequences

- Architecture §2.2 gains the prefixes `ses acc vrf sec`. §2.3 changes as in Decision 1. ADR-004's lookup line points here.
- `roles.test.ts` asserts that `app_lookup` cannot log in and that `app_rw` cannot assume it. The migration test asserts that every `security definer` function is owned by `app_lookup`, pins `search_path` and is not executable by `public`.
- If a lookup has to return more than ids, it goes through human review like any other 🔒 change.

## Revisit when

better-auth starts storing hashed session tokens (then hash at rest), or we drop it.
