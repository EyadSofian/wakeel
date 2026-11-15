# ADR-046 — Knowledge management and test search in Studio

Status: proposed · Date: 2026-11-15 · Task: 8.8

## Context

Design system §5.5 specifies the Knowledge list, Sources, Documents, Test search and Settings.
ADR-039 defines the presigned upload flow. ADR-041 and ADR-042 define indexing stages and source
jobs, and ADR-043 defines retrieval. The current API registers file uploads, but has no routes
or response contracts for managing these bot-owned resources. There is also no answer for whether
a playground search should create a conversation trace or expose its stages directly.

## Options

1. Add bot-scoped Studio routes using existing repository and queue boundaries. Return a scoped
   retrieval result and its trace from a test search. Use the same retrieval against the active index.
2. Treat test searches as emulator turns, with rows in conversations and traces. This lets the
   existing trace page open them but adds a conversation lifecycle to a synchronous inspection.
3. Use direct database or object-store access from Studio. This lacks the API membership,
   validation and per-bot checks used in other Studio resources.

## Recommendation

Choose option 1:

- Mount the resource under `/v1/workspaces/:workspaceId/bots/:botId/knowledge-bases`. Check
  workspace membership with `bot.read` for reads and test searches, and `bot.update` for
  writes and source synchronization. Every nested resource lookup also checks bot, KB and parent
  ownership in `withWorkspace`. Return `not_found` for mismatches.
- List bases, sources, documents and chunks with stable cursor pagination. Use zod contracts for
  public summaries. Return opaque revision ETags on mutable documents and require `If-Match`
  on their writes. Keep storage keys, internal job payloads, credentials and raw parser errors
  out of Studio responses.
- Commit a source before scheduling its initial sync. Use the existing idempotent source job.
  Return current status and stage counts from the existing ingestion records. A manual sync uses
  the same queue. Reuse the signed upload and completion sequence before creating a file source.
- Return document metadata, parsed Markdown and active-index chunks under the KB's Documents
  resource. Serve Markdown through the authenticated API and render through the existing safe text
  boundary with direction set per content. Deleting a KB referenced by the current published
  definition returns `resource_in_use` with usages per architecture §3.
- `POST .../knowledge-bases/:kbId/test-search` accepts the ADR-043 query, topK and filter fields.
  The route fixes kbIds to its path KB and invokes the shared search service in emulator mode.
  Return validated passages and the existing `kb.search` stage data. The Studio can open that
  response's trace in the Why panel without creating a conversation, consuming live quota or
  generating an answer.
- Expose the existing KB settings and embedding selection when creating a base. Editing the
  embedding model requires the active-index swap defined in architecture §8.1. Until that
  transaction and re-index workflow are implemented, restrict editing to name, description,
  OCR settings and score floor. Surface the same bot's KBs in the existing card and tool forms.

## Consequences

This supplies the missing Studio API and trace contract without changing Bridge or the definition
schema. Tests cover cross-tenant and cross-bot references at every nested boundary, stale revisions,
upload through ready/search, and RTL trace rendering. The active-index model-change workflow needs
its own acceptance before the Studio can offer that setting on an existing KB.
