# Auth threat checklist (Phase 1)

Required by the Phase 1 definition of done (build plan). Threat numbers are from architecture §16. Each row says how the item is handled and what proves it. Rows are added as Phase 1 tasks land; **human review** is still needed for every 🔒 task.

Status: ✅ done and tested · ⏳ later task · ⚠️ known gap (accepted or open)

## Sessions and cookies (task 1.2, T7)

| # | Item | Status | How | Evidence |
|---|---|---|---|---|
| S1 | Session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain` | ✅ | better-auth `useSecureCookies`, `defaultCookieAttributes` | `apps/api/test/auth.test.ts` "sets a hardened session cookie" |
| S2 | Cookie name carries the `__Secure-` prefix, so browsers refuse it over http or from a subdomain | ✅ | `useSecureCookies` | same test |
| S3 | A stolen `sessions` row is not a usable cookie | ✅ | The cookie value is `token.HMAC(AUTH_SECRET)`; the bearer plugin is off (ADR-015) | "a forged cookie value is not a session" |
| S4 | Sessions expire after 7 days and roll forward once a day | ✅ | `session.expiresIn`, `updateAge` | config in `packages/auth/src/auth.ts` |
| S5 | Sign-out deletes the session row and clears the cookie | ✅ | `auth.api.signOut` | "sign out ends the session and clears the cookie" |
| S6 | Session responses are never cached | ✅ | `Cache-Control: no-store` on `GET /v1/auth/session` | "with the right password returns a session" |
| S7 | Sessions for one user can be listed and revoked by that user | ⏳ | Settings, later | — |

## CSRF (task 1.2, T7)

| # | Item | Status | How | Evidence |
|---|---|---|---|---|
| C1 | Every cookie-authenticated mutation needs `X-CSRF-Token` | ✅ | `requireSession` in `apps/api/src/session.ts` checks it for every method except GET, HEAD and OPTIONS | "a mutation with the session cookie but no CSRF header is rejected" |
| C2 | The token is bound to the session | ✅ | `HMAC-SHA256(AUTH_SECRET, "csrf:v1:" + session token)`, compared in constant time | "a CSRF token from another session is rejected"; `packages/auth/test/csrf.test.ts` |
| C3 | Mutations from another origin fail even with a valid token | ✅ | An `Origin` header other than `STUDIO_ORIGIN` is `csrf_failed` | "a valid token from another origin is rejected" |
| C4 | Login CSRF: sign-in and sign-up only from the Studio's origin | ✅ | `requireStudioOrigin`; a missing `Origin` is refused | "from another origin / no origin is csrf_failed" |
| C5 | Every Studio API route uses `requireSession` | ⏳ | Routes in 1.3–1.7 | Each route test in those tasks |

## Passwords and sign-in (task 1.2, T7)

| # | Item | Status | How | Evidence |
|---|---|---|---|---|
| P1 | Passwords are hashed (scrypt) and stored only in `accounts.password` | ✅ | better-auth credential provider | "stores a password hash in accounts, never the password" |
| P2 | Length 8 to 128 characters; no composition rules (NIST SP 800-63B) | ✅ | zod `Password` plus better-auth min and max | "a short password is validation_failed" |
| P3 | The same response for a wrong password and an unknown email | ✅ | Both are `invalid_credentials` | "with a wrong password is invalid_credentials, and so is an unknown email" |
| P4 | The 6th failed sign-in for one email within a minute is `rate_limited`, even with the right password | ✅ | Redis counter shared by replicas; the email is hashed in the key | "the 6th failed sign-in in a minute is rate_limited" |
| P5 | Sign-up says whether an email is taken | ⚠️ accepted | `email_taken` makes it possible to learn which emails have accounts. Needed so a user knows to sign in instead. Revisit if email verification is added | "an email that is taken … is email_taken" |
| P6 | Per-IP limit against credential stuffing across many emails | ⚠️ open | Not in the plan for 1.2. Needs a number; propose with 15.1 (rate limits on every public route) | — |
| P7 | Email verification and password reset | ⏳ | No mail provider yet; not in Phase 1 | — |
| P8 | Passwords and session tokens never appear in logs | ✅ | Request bodies are not logged; checked on the dev stack (log searched for the password after a sign-up) | 1.2 PR verification notes |

## Client address (task 1.2)

| # | Item | Status | How | Evidence |
|---|---|---|---|---|
| A1 | The address stored on a session cannot be spoofed with `X-Forwarded-For` | ✅ | Fastify `trustProxy` is off by default; the api passes `request.ip` and replaces any client forwarding header before better-auth sees it | `packages/auth/src/auth.ts` `forward()` |
| A2 | Behind a proxy, `trustProxy` is set to that proxy only | ⏳ | Deployment, 15.5 | — |

## Tenancy, roles, keys, secrets (tasks 1.1, 1.3–1.6)

| # | Item | Status | How | Evidence |
|---|---|---|---|---|
| T1 | Tenant tables have forced RLS and are isolated in both directions | ✅ | Migration 0003 | `packages/db/test/platform.test.ts` "two tenants" |
| T2 | Pre-tenant lookups return ids only and run as a role nobody can log in as | ✅ | `app_lookup` (ADR-015) | "lookups (ADR-015)", "roles around the platform tables" |
| T3 | Support tooling cannot read credentials | ✅ | `app_admin_ro` has no grant on sessions, accounts, verifications | "app_admin_ro cannot read …" |
| T4 | Audit log is append-only for the application | ✅ | `update`, `delete`, `truncate` revoked from `app_rw` | "app_rw cannot change or delete audit entries" |
| T5 | Role checks on every mutation | ⏳ | 1.3 | — |
| T6 | API keys hashed, shown once, revocable, scoped | ⏳ | 1.4 | — |
| T7 | Secrets encrypted with per-row data keys | ⏳ | 1.5 | — |
| T8 | Every mutation writes an audit entry | ⏳ | 1.6 | — |
