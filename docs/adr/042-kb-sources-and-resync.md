# ADR-042 — Knowledge base sources: config shapes, crawl rules, removal, and scheduled re-sync

Status: accepted (Eyad approved in writing on 2026-11-15) · Date: 2026-11-15

## Context

Architecture §8.1 says sitemap and crawl respect `robots.txt`, stay same-origin by default, cap pages and depth, and send 1 request per second per host; task 8.5 adds scheduled re-sync, and its acceptance says changed pages re-index and removed pages are deleted. Left open: the config of each source kind, the limits, how robots.txt failures are treated, what "removed" means when the site is unreachable, and how the schedule runs across tenants.

## Decision

1. **Config** is `KbSourceConfig` in the contracts, discriminated by kind: `file {fileId}`, `text {title, text ≤ 200k}`, `url {url}`, `sitemap {url, maxPages ≤ 1000 (100)}`, `crawl {url, maxDepth ≤ 5 (2), maxPages ≤ 1000 (100), sameOriginOnly (true)}`. Schedules are `1 hour`, `6 hours`, `1 day`, `7 days` or none.
2. **All requests go through egress** with the `WakeelBot/1.0` user agent. Per host there is at least 1 s between requests, longer if robots.txt asks for a `Crawl-delay`.
3. **robots.txt** follows RFC 9309: our group, else `*`; longest match wins, Allow wins ties; a 4xx allows everything; a 5xx or no answer disallows everything. A URL source the site disallows fails with `source_fetch_failed`.
4. **Removal**: after a successful discovery, documents of the source whose URI was not discovered are deleted with their chunks. A discovery that finds **no** pages fails the sync and deletes nothing, so an outage never empties a knowledge base.
5. **Unchanged pages** cost one fetch and stop at the fetch stage (ADR-041). The crawler fetches a page once to find links and the pipeline fetches it again to ingest; accepted for now (crawls are rate limited anyway), revisit if crawl time matters.
6. **Scheduled re-sync**: the `maintenance` queue runs `kb-resync` every 5 minutes. It calls `lookup.kb_sources_due` (security definer, owned by `app_lookup`, ids only) and adds one `kb-sync` job per due source (3 attempts). A source stuck in `syncing` for an hour is treated as dead and may start again.
