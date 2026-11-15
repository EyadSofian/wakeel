# ADR-020 — Egress is an internal fetch service, not a CONNECT tunnel

Status: proposed (implemented as proposed in task 3.1; review with that PR) · Date: 2026-11-13 · **Security-critical: changes need human review**

## Context

Architecture §1.1 calls `apps/egress` a "Node 22 forward proxy" and the only route from the sandbox, the crawler and webhook delivery to the internet. §5.3 says the proxy "resolves DNS itself, blocks private, loopback, link-local and metadata ranges (IPv4 and IPv6), pins the resolved address for the connection, re-checks on every redirect, and enforces per-workspace rate limits". §5.2 gives the guest `fetch` limits: 10 s, 5 MB response, 5 redirects.

The docs do not say:

1. **How callers talk to egress.** A classic forward proxy takes `GET http://host/…` for plain HTTP and `CONNECT host:443` for HTTPS, after which it only relays encrypted bytes.
2. **How egress knows the workspace** it rate-limits, and how it knows a request comes from a platform service.
3. **Where the rate-limit state lives** (each replica, or Redis).
4. **The limits on what callers send**: request body size, headers.

Item 1 decides whether "re-checks on every redirect" and the 5 MB response limit can be enforced by egress at all. Through a `CONNECT` tunnel egress cannot see HTTP responses, so it cannot see redirects or decompress a body; it can only check each new tunnel the client opens.

## Options

### Protocol

1. **Standard forward proxy (absolute-form HTTP + `CONNECT`).** Callers use any HTTP client with a proxy setting. Egress checks and pins the address for each connection. Redirects are followed by the caller, and each hop is a new proxied request that is checked again. However, the response size and redirect count are enforced by the caller (inside the sandbox, which is the component we trust least). Decompression bombs reach the caller. A `CONNECT` tunnel carries any protocol to any port on a public address, not only HTTP.
2. **Internal fetch service: `POST /v1/fetch` with the URL, method, headers and body as JSON; egress performs the request and returns status, headers and body.** Egress follows redirects itself (checking every hop), enforces the deadline, the size after decompression and the redirect count, strips hop-by-hop and proxy headers, and only ever speaks HTTP(S). Callers need a small client instead of a proxy setting. Responses are buffered (≤ 5 MB), not streamed.
3. **Option 1 with TLS interception** (egress terminates TLS with its own CA). Gives egress full visibility, but it needs a CA in every caller and handles every tenant's TLS traffic in clear text inside the platform. Rejected.

### Caller identity and workspace

- **a. Shared bearer token (`EGRESS_TOKEN`) and a `workspaceId` field in the request.** Simple. A compromised sandbox process could name another workspace, which affects only rate-limit accounting and log attribution. It cannot reach anything the policy blocks.
- **b. Per-execution capability token signed by the worker** (the `capabilityToken` already in the sandbox exec frame, §5.1) and checked by egress. Binds each request to the workspace that started the execution. Needs a signing key shared by worker and egress, and a token format in the contracts.

### Rate-limit state

- **In memory per replica.** No credentials in egress (§1.1 lists it without database access; Redis is not mentioned). The effective limit is the configured limit × the number of replicas.
- **Redis.** Exact across replicas; gives egress a Redis credential and a dependency on Redis being up.

## Recommendation

- **Protocol: option 2**, the fetch service. It is the only option where egress itself enforces every rule in §5.2 and §5.3, including redirects and the response size. It is still a "forward proxy" in the sense of §1.1 (the only outbound route); the wire format is JSON rather than proxy-form HTTP.
- **Identity: a now, b later.** A shared token plus `workspaceId` is enough for 3.1, since the security property (no access to blocked addresses) does not depend on it. Adopt b in task 3.3, when the exec frame's `capabilityToken` gets a format; egress then reads the workspace from the token instead of the body.
- **Rate limit: in memory per replica** for now, with `EGRESS_RATE_PER_MINUTE` (default 600) and `EGRESS_RATE_BURST` (default 60) per workspace per replica. Every outbound request counts, redirects and blocked requests included, so probing the policy is limited too. Move to Redis only if per-workspace accuracy across replicas becomes a product requirement.
- **Caller-side limits:** request body ≤ 5 MB decoded, header names must be RFC 9110 tokens and values must not contain CR, LF or NUL, URLs ≤ 8 KB, method from a fixed list, `timeoutMs` and `maxResponseBytes` may only lower the defaults.

### Wire format (as implemented in `apps/egress/src/protocol.ts`)

```
POST /v1/fetch
Authorization: Bearer <EGRESS_TOKEN>
{ workspaceId, url, method?, headers?: {name: value}, body?, bodyEncoding?: "utf8"|"base64",
  redirect?: "follow"|"manual", timeoutMs?, maxResponseBytes? }

200 { status, statusText, headers: [name, value][], body: base64, url, redirected }
4xx/5xx problem document (ADR-012): fetch_blocked 403, fetch_failed 502, rate_limited 429 (+ Retry-After),
        payload_too_large 413, validation_failed 400, unauthenticated 401
```

An upstream 4xx or 5xx is a successful egress call (`200` with `status: 404`); only egress's own refusals and failures are problem documents.

The schemas stay in `apps/egress` until the first caller exists. When 3.3 writes the client, move them to `packages/contracts/src/egress.ts` (a contract addition, listed in that PR).

## Consequences

- Architecture §1.1 should read: "`apps/egress` — Node 22 egress service (internal fetch API, ADR-020) — the only route from sandbox, crawler and webhook delivery to the internet."
- The sandbox guest `fetch` (3.3), webhook delivery (5.2) and the KB URL fetch (8.x) call `POST /v1/fetch` through one client; none of them sets an HTTP proxy.
- Responses are buffered. Streaming downloads (large KB documents) would need a second endpoint with the same checks; not needed for any current task.
- Egress holds no database or Redis credentials.
- Rate limits are per replica until changed.

## Revisit when

A caller needs streaming or non-HTTP protocols; per-workspace limits must be exact across replicas; or the exec-frame capability token is defined (adopt identity option b).
