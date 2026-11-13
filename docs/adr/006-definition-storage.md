# ADR-006 — Bot definitions: per-workflow draft documents, immutable version snapshots

Status: accepted · Date: 2026-11-13

## Context
Flowise stores a whole canvas as one opaque text column. Botpress caps saved versions at 3 or 15 and reverting overwrites the draft. We need autosave that does not clobber, reviewable diffs, cheap unlimited versions, and safe behaviour for conversations in flight when a new version is published.

## Decision
- The definition is typed JSON validated by `packages/contracts` with a `schemaVersion`.
- **Draft**: one `manifest` document and one document per workflow in `bot_draft_docs`, each with an integer `rev`. Whole-document saves with `If-Match`; `409` on conflict returns the server copy for the client to merge or reload.
- **Layout is separate from logic** inside a workflow document (`layout` map), so moving nodes never appears in a logic diff.
- **Version**: publish validates, assembles and stores one immutable JSONB snapshot with a content hash. Unlimited. Rollback is a pointer change. "Restore to draft" copies a snapshot back into draft documents.
- **Ids are stable and never reused**, so diffs, traces and analytics can refer to nodes and cards across versions.
- **Live conversations** pin a version and migrate at the next turn if their stack positions still exist; otherwise the stack resets and still-valid variables are kept (`03-architecture.md` §3.2).
- **KBs and tables are live resources**, referenced by id. Destructive changes to anything the published version references are blocked.

## Alternatives considered
- **One blob per bot**: simplest; rejected because two tabs or two builders overwrite each other and every save rewrites megabytes.
- **Fully normalised rows per node and card**: precise but turns every edit into multi-row transactions and complicates versioning.
- **Operation log / CRDT (Yjs)**: right for real-time co-editing. Deferred; per-workflow documents with revisions are compatible with adding it later, one document at a time.

## Consequences
- Two builders editing the same workflow get a conflict prompt rather than a merge. Acceptable for MVP teams of one to five.
- Definition migrations are required for every schema change and are tested with stored fixtures.
- A version snapshot can reach a few megabytes for large bots; JSONB with TOAST handles it.

## Revisit when
Real-time collaboration is scheduled, or version snapshots exceed 10 MB.
