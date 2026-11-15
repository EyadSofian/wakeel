# Egress proxy security review (task 3.1 🔒)

For the human review the build plan requires on 3.1 (threat T3, architecture §16). This file says what the egress service guarantees, how, what proves it, and what is still open. Read it with ADR-020 (proposed), which records the protocol choice.

Status: ✅ done and tested · ⏳ later task · ⚠️ known gap (accepted or open)

## What egress is

`apps/egress` is the only route from the sandbox, the crawler and webhook delivery to tenant-supplied URLs (CLAUDE.md §9). It is an internal HTTP service:

- `GET /health` → `200 {"status":"ok"}`; no token.
- `POST /v1/fetch` with `Authorization: Bearer $EGRESS_TOKEN` and a JSON request (`apps/egress/src/protocol.ts`). Egress performs the request itself and returns the status, headers and base64 body, or a problem document.

Configuration is `egressEnv` in `packages/config/src/variables.ts`: `EGRESS_TOKEN` (secret, ≥ 32 characters), `EGRESS_HOST`, `EGRESS_PORT` (4400), `EGRESS_RATE_PER_MINUTE` (600), `EGRESS_RATE_BURST` (60). Limits are `EGRESS_LIMITS` in `packages/config/src/limits.ts` and come from the guest `fetch` limits in the contracts (10 s, 5 MB, 5 redirects).

Egress holds no database, Redis or object-store credentials.

## How one request is handled

For every hop (the first request and each redirect):

1. **Rate limit.** Take one token from the workspace's bucket. If none is left, `rate_limited` (429, `Retry-After`). Blocked requests use a token too.
2. **Scheme.** Only `http:` and `https:`. Anything else is `fetch_blocked`.
3. **Host.** The WHATWG URL parser has already rewritten decimal, octal, hex, short and percent-encoded IPv4 hosts and full-width digits into dotted decimal, and IPv6 into compressed form. Zone ids and malformed hosts fail parsing (`validation_failed`).
   - IP literal → checked against the range policy.
   - Name → `localhost`, `*.localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback` are refused before any lookup. Otherwise the name is resolved **once**, and **every** address in the answer must pass the policy; one blocked address blocks the name.
4. **Pin.** The socket is opened to the first checked address. The HTTP client receives an IP address, so Node never resolves the name again. For HTTPS, the original name is still the SNI and the name the certificate is verified against.
5. **Send.** Hop-by-hop headers, every `proxy-*` header, headers named in `Connection`, `Host`, `Content-Length`, `Accept-Encoding` and `Expect` from the caller are dropped. `Host` is set from the URL. No connection reuse (`agent: false`), so a connection pinned for one request never carries another.
6. **Redirect** (`redirect: "follow"`, the default). A 301, 302, 303, 307 or 308 with `Location` closes the response and starts the next hop at step 1 with the new URL. More than 5 hops is `fetch_failed`. 303 (and 301/302 after a POST) becomes a GET without a body. `Authorization` and `Cookie` are not sent to another origin. With `redirect: "manual"` the 3xx comes back as the result and nothing is dialled for its `Location`.
7. **Read.** gzip, deflate and br are decoded inside egress, and the 5 MB limit counts **decoded** bytes, so a compression bomb stops at the limit. One deadline (10 s, or less if the caller asks) covers DNS, connect, TLS, every hop and the body.

## Range policy

`apps/egress/src/address-policy.ts`.

**IPv4: blocklist** of every special-purpose range: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (CGNAT; Alibaba metadata `100.100.100.200`), `127.0.0.0/8`, `169.254.0.0/16` (link-local; metadata `169.254.169.254` for AWS, GCP, Azure, Oracle, DigitalOcean), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4` (includes `255.255.255.255`), and `168.63.129.16/32` (Azure wire server: public space, internal service).

**IPv6: allowlist.** Only global unicast `2000::/3` passes, minus `2001::/23` (IETF assignments, including Teredo), `2001:db8::/32` and `3fff::/20` (documentation). That excludes `::`, `::1`, IPv4-compatible `::a.b.c.d`, SIIT `::ffff:0:a.b.c.d`, `100::/64`, `64:ff9b:1::/48`, `fc00::/7` (including AWS metadata `fd00:ec2::254`), `fe80::/10`, `fec0::/10` and `ff00::/8`.

**Embedded IPv4** is judged by the IPv4 it carries: IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d` (needed: DNS64 networks hand these out for ordinary IPv4-only hosts) and 6to4 `2002:aabb:ccdd::/48`.

Inputs must be canonical text. Anything the parser does not recognise is refused, not guessed at.

## Checklist

| # | Item | Status | How | Evidence |
|---|---|---|---|---|
| E1 | Decimal, octal, hex and short-form IPv4 to loopback, private and metadata addresses are blocked | ✅ | URL parser normalisation, then the IPv4 policy | `test/ssrf.test.ts` "IPv4 literals in every notation" (21 rows) |
| E2 | `localhost` variants are blocked, before any DNS lookup | ✅ | `checkHostname` | "localhost variants"; "localhost is refused before any DNS lookup" |
| E3 | IPv6 loopback, unspecified, link-local, unique-local, multicast are blocked | ✅ | IPv6 allowlist | "IPv6 literals: loopback, mapped and embedded IPv4" (16 rows) |
| E4 | IPv4-mapped, NAT64, 6to4 and IPv4-compatible forms of blocked IPv4 addresses are blocked | ✅ | Embedded IPv4 check | same; `test/address-policy.test.ts` |
| E5 | Cloud metadata is blocked: `169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `168.63.129.16`, `metadata.google.internal` | ✅ | Ranges above | E1 rows and "names that resolve to blocked addresses" |
| E6 | A name that resolves to a blocked address is blocked, including when only one of several answers is blocked | ✅ | Every answer is checked | "one blocked address in the answer blocks the name" |
| E7 | DNS rebinding: the address used is the one checked | ✅ | One lookup per hop; the socket dials that address | "the first answer is pinned"; the resolver is called once and the canary sees nothing |
| E8 | DNS rebinding across redirects or across requests is blocked | ✅ | A new lookup and check on every hop and every request | "rebinds … between redirects", "on the second request" |
| E9 | Every redirect hop is checked again; relative, protocol-relative and non-HTTP `Location` values included | ✅ | Redirect loop re-enters the full check | "redirects are checked again on every hop" (12 targets, a chain, and a 307 POST) |
| E10 | Only `http` and `https` | ✅ | Scheme check | "only http and https" (7 schemes) |
| E11 | Userinfo, fragment, query and percent-encoding tricks do not change the host that is checked | ✅ | The check uses the parsed `URL.hostname` | "URL tricks" |
| E12 | A public server stays reachable over IPv4, IPv6, a literal, a redirect, and HTTPS | ✅ | — | "public servers stay reachable" |
| E13 | Pinning does not weaken TLS: the certificate is verified against the name | ✅ | `servername` = URL name; system CAs | "over https, with the certificate checked against the name"; "to an address the certificate does not name, the request fails" |
| E14 | Response limit 5 MB, counted after decompression | ✅ | Streaming count | `test/service.test.ts` "size limit", including a 20 MB gzip bomb |
| E15 | One 10 s deadline for the whole request | ✅ | `AbortController` on the injected clock | "time limit (fake clock)" |
| E16 | At most 5 redirects | ✅ | Hop counter | "redirects" |
| E17 | Per-workspace rate limit; redirects and blocked requests count | ✅ | Token bucket | "per-workspace rate limit (fake clock)" |
| E18 | Only platform services can call egress | ✅ | Bearer token compared in constant time (SHA-256 digests, `timingSafeEqual`) | "callers" |
| E19 | Callers cannot smuggle headers or raise limits | ✅ | zod schema: token header names, no CR/LF/NUL in values, limits are maximums; hop-by-hop and proxy headers dropped | "callers", "requests go out as asked" |
| E20 | Logs carry no secrets | ✅ | Egress logs `requestId`, `workspaceId`, origin (`scheme://host:port`), hop count, status or error code, and the blocked range. Never path, query, headers or bodies: tenant URLs often carry API keys in the query string | `src/server.ts`; the logger also redacts `authorization` |
| E21 | The blocked range is not returned to the caller | ✅ | Logged only | `fetch_blocked` problem has the host and nothing else |
| E22 | The tests prove something | ✅ | A canary server receives every connection to a non-public address; every test asserts it stayed empty. With the policy switched off, all 95 SSRF tests fail with canary hits (checked while writing this PR) | `test/harness.ts` |
| E23 | No test touches the internet or real time | ✅ | Test resolver, local servers, fake clock | `test/harness.ts` |
| E24 | Sandbox guest `fetch` goes through egress | ⏳ | Task 3.3 | — |
| E25 | Webhook delivery and KB URL fetch go through egress | ⏳ | Tasks 5.2 and 8.x | — |
| E26 | The network allows the sandbox to reach only egress | ⏳ | Deployment (Phase 15) | — |

## Known gaps and decisions for the reviewer

| # | Gap | Status | Notes |
|---|---|---|---|
| G1 | Rate limits are per replica, in memory | ⚠️ accepted in ADR-020 | With N replicas a workspace gets N × the limit. Redis would make it exact and give egress a credential. |
| G2 | The caller asserts `workspaceId` | ⚠️ accepted in ADR-020 | A compromised sandbox process could spend another workspace's rate limit. It cannot reach a blocked address. Plan: read the workspace from the signed exec capability token (3.3). |
| G3 | Any port on a public address is allowed | ⚠️ open | Only HTTP is spoken, so this is HTTP to a public host on, say, port 25. Restricting to 80/443 would break tenants whose APIs use other ports. Reviewer: keep, or add a port denylist? |
| G4 | `getaddrinfo` cannot be cancelled | ⚠️ open | A slow DNS server holds a libuv threadpool thread past the request deadline (the request itself still fails on time). Under a flood this could delay other lookups. Mitigations for deployment: a raised `UV_THREADPOOL_SIZE`, or a `dns.Resolver` (c-ares) lookup with its own timeout. |
| G5 | System resolver behaviour | ⚠️ deployment | `/etc/hosts` entries and resolv.conf search domains apply. Every answer is still checked, so a search-domain hit on an internal name resolves to a private address and is blocked. Recommended: no search domains in the egress container. |
| G6 | Egress itself can route to internal networks | ⚠️ deployment | The policy is the guard. Defence in depth for Phase 15: put egress in a network segment whose firewall also drops RFC 1918, link-local and metadata destinations. |
| G7 | No keep-alive | accepted | A new TCP and TLS connection per hop. It costs latency and makes sure a pinned connection is never reused for another request. |
| G8 | Raw deflate (without zlib wrapper) is not decoded | accepted | Such a response fails with `fetch_failed` ("could not be decoded"). Rare in practice. |
| G9 | `2001::/23` is blocked as a whole | accepted | It includes a few globally reachable service addresses (AS112, AMT). Ordinary hosts are not there. |
| G10 | Test seams `dial` and `tls.ca` | accepted | `createEgressServer` accepts them so tests can send connections to local servers and trust a test certificate. They are code options only; `src/main.ts` never sets them and no environment variable reaches them. |
| G11 | No operator allowlist for internal destinations | by design | A tenant cannot call its own private network through the platform. If this is ever needed it must be an explicit, per-workspace, audited setting with its own ADR. |
| G12 | `HTTP_PROXY` and similar variables | ✅ | Node ignores them unless `NODE_USE_ENV_PROXY` is set (Node 22.21 and later). With it set, requests could leave through that proxy instead of the checked address, so `src/main.ts` refuses to start. Checked by hand: `NODE_USE_ENV_PROXY=1 pnpm --filter @wakeel/egress start` exits 1. |

## Questions for the reviewer

1. Accept ADR-020 (fetch service, shared token now, signed capability token in 3.3, per-replica rate limit)?
2. G3: allow every port, or deny a list (for example 22, 25, 3306, 5432, 6379, 11211)?
3. Rate-limit defaults: 600 requests a minute with a burst of 60, per workspace per replica?
