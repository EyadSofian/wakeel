# ADR-060 — Web search and page fetch as Autonomous Node tools

Status: proposed · Date: 2026-11-17 · **Security-critical: changes need human review** · Review: `docs/research/2026-11-17-ai-layer-review.md`

## Context

Bots can read only their knowledge bases. A KB can index a URL, a sitemap or a crawl (ADR-042). All
of that happens at ingestion, through egress, on a schedule. At conversation time a bot cannot:

- search the web;
- read a page a customer links to;
- add a page to its KB when the builder allows it.

Botpress offers live web search as a knowledge source, with site and recency filters (research
report §1.6). The original Majed bot had a Web Search tool that its prompt restricted to KB links,
and it was dropped in the move (`docs/pilot/majed/README.md`).

The OpenAI agents guide lists web search as a standard "data" tool. The production stack reference
warns that a fetch tool is exactly the risky combination:

- the model reads untrusted text;
- the conversation holds private data;
- a URL the model chooses is a way to send that data out.

It says to remove at least one of the three, and to put egress allowlists on "anything that fetches
URLs".

Binding rules:

- Every outbound request to a tenant-supplied URL goes through `apps/egress` (CLAUDE.md §9,
  ADR-020).
- Every tool the model can call is listed on the node.
- Untrusted content reaches the model only in user-role data blocks.

## Options

1. **The providers' built-in web search** (OpenAI and Anthropic server-side tools). Nothing to
   operate. But it ties a node to one provider, the requests and costs are invisible to our trace
   and egress, and it needs native tool calling, which protocol v1 does not use.
2. **Two listed tool types, `web_search` and `web_fetch`, backed by a search API and egress, with
   the fetch target limited by provenance and allowlist.** *(Recommended.)*
3. **No runtime web access.** Builders keep using KB URL sources. This is safe but leaves a
   capability gap that Botpress fills.

## Recommendation

Use option 2.

### `web_search`

```ts
export const WebSearchTool = z.object({
  ...toolBase,
  type: z.literal("web_search"),
  /** Restrict results to these sites (host suffixes). Empty means the whole web. */
  sites: z.array(Hostname).max(20).default([]),
  recencyDays: z.number().int().min(1).max(3650).optional(),
  maxResults: z.number().int().min(1).max(10).default(5),
});
```

- The model sees `search(query: string): Promise<Array<{ token, title, url, snippet }>>`.
- Results get citation tokens in the turn's registry (ADR-043 §5), with `uri`, so replies cite
  them like KB passages.
- **Provider.** A search API behind a `WebSearchPort`, called through egress, with the
  workspace's own key in `workspace_secrets` (BYOK, like model keys). The first adapter is one
  provider chosen by Eyad (question 1). A second provider is a new adapter, not a contract change.
- Each call is recorded as a usage unit. Eval and emulator traffic is never counted as live
  conversations.

### `web_fetch`

```ts
export const WebFetchTool = z.object({
  ...toolBase,
  type: z.literal("web_fetch"),
  /** Hosts the model may fetch from at any time (host suffixes). */
  allowedHosts: z.array(Hostname).max(50).default([]),
  /** Also allow URLs that arrived in this conversation from the user or from a search result. */
  allowProvidedUrls: z.boolean().default(true),
  /** If set, a fetched page may also be added to this KB as a `url` source. */
  indexInto: KnowledgeBaseId.optional(),
});
```

- The model sees `fetch(url: string): Promise<{ token, title, url, text }>`.
- **What it may fetch.** A URL is fetched only if one of these holds:
  - its host matches `allowedHosts`;
  - `allowProvidedUrls` is on and the same URL, exactly, appeared in an inbound user message of this
    conversation;
  - `allowProvidedUrls` is on and the URL is a result of this turn's `web_search`.

  Anything else fails with `web_fetch_not_allowed` and a fix the model can act on: it can only
  fetch links the user sent or search results. This means the model cannot build a URL that
  carries conversation data out. That is the leg of the risky combination this design removes.
- **How it fetches.** GET only, through egress (private ranges blocked, redirects re-checked per
  hop), `WakeelBot/1.0`, robots.txt honoured as in ADR-042. Limits are 5 MB and 10 s. The page
  goes through Readability and Markdown, the same code as KB HTML parsing. Text is capped at 12,000
  characters, with the cut marked.
- **The content is untrusted.** It is returned in a data block and never placed in system text.
  It gets a citation token.
- **`indexInto`.** The tool takes `index: true` as an optional second argument. It then also
  creates a `url` source in that KB through the existing ingestion pipeline.
  - This is a side effect, so the tool is marked `sideEffects: true` and is never retried
    automatically.
  - It is limited to the same allowed URLs.
  - In eval mode it is blocked (ADR-053 behaviour) and recorded.

### What is not included

- POST or any other method, request bodies, cookies or headers set by the model.
- `fetch` inside the model's `:::run` code. That code still has no network access (ADR-032); these
  tools run in the worker and call egress.
- Following links inside fetched pages without the model calling `fetch` again on an allowed URL.

## Consequences

- Contract changes:
  - `docs/04-contracts/node.ts`: two tool types;
  - `connections.ts` or settings: the search provider key;
  - `errors.ts`: `web_fetch_not_allowed`, `web_search_unavailable`;
  - `trace.ts`: `tool.call` spans carry the URL, the status and the provenance rule that allowed it.
- Security tests are added to the egress/SSRF suite. Escape and SSRF suites only grow. The tests
  include:
  - a model-built URL with conversation data in its query is refused;
  - a user-sent URL that redirects to a private address is refused;
  - an allowlisted host that redirects off the list is refused.
- New build-plan rows once accepted:
  - **6.18** — `web_fetch`;
  - **6.19** — `web_search` and the first provider adapter;
  - **6.20** — Studio tool editors.
- Like ADR-020, this is security-critical: a 🔒 human review on the implementation PR.

## Questions for Eyad

1. **Which search provider first?** It needs a commercial API with a key per workspace. Brave Search
   API, Tavily and Exa are candidates. Prices, terms and Arabic result quality must be checked before
   choosing; this ADR does not pick one.
2. **Should `allowProvidedUrls` default to on?** It lets a customer's link be read, which is the
   point of the tool. The page is untrusted data either way.
