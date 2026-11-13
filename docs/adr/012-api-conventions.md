# ADR-012 — API conventions: ids, errors, pagination, versioning

Status: accepted · Date: 2026-11-13

## Decision

**Ids.** Text, `<prefix>_<lowercase ULID>` for stored entities; `<prefix>_<10-char nanoid>` for elements inside a bot definition. Prefixes are listed in `03-architecture.md` §2.2. Ids are opaque to clients.

**Paths.** `/v1/…`. Studio API under `/v1/workspaces/{workspaceId}/…` (session cookie or workspace API key). Bridge API under `/v1/bridge/…` (bridge key; workspace and bot are implied by the key).

**Errors.** RFC 9457 `application/problem+json`:

```json
{
  "type": "https://docs.{{PLATFORM_DOMAIN}}/errors/revision_conflict",
  "title": "This workflow was changed elsewhere",
  "status": 409,
  "code": "revision_conflict",
  "detail": "Your copy is based on revision 41; the saved revision is 42.",
  "fix": "Reload the workflow, then reapply your change.",
  "requestId": "req_01j…",
  "errors": [{ "path": "nodes[3].cards[0].text", "code": "required", "message": "Text is required" }]
}
```

`code` is from the enum in `04-contracts/errors.ts`. `title` and `fix` are user-facing sentences; they are shown as-is in the Studio.

**Pagination.** Cursor-based: `?limit=` (default 50, max 200) and `?cursor=`; responses return `{ data, nextCursor }`. No offset pagination.

**Concurrency.** Mutable documents return `ETag: "<rev>"` and require `If-Match` on write.

**Idempotency.** `Idempotency-Key` accepted on every `POST` in the Bridge API; stored 24 h per connection.

**Time.** ISO 8601 UTC strings with milliseconds.

**Auth.**
- Session cookie for the Studio (HttpOnly, Secure, SameSite=Lax) plus a CSRF header on mutations.
- API keys: `wk_live_<prefix>_<secret>` (workspace) and `wk_bridge_<prefix>_<secret>` (one connection). Only the SHA-256 of the secret is stored; the 8-character prefix locates the row. Shown once at creation.

**Rate limits.** Token bucket per key and per workspace; `429` with `Retry-After` and `RateLimit-*` headers.

**Versioning.** Additive changes within `/v1`. Breaking changes require `/v2` and an ADR. Webhook payloads carry `apiVersion`.

## Consequences
One error shape and one pagination shape across both APIs; the Studio can render any error without special cases.
