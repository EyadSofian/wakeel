# ADR-036 — Versions, publish and rollback: routes, hash, and production before the first publish

Status: proposed (implemented as proposed in tasks 7.1 and 7.2; review with those PRs) · Date: 2026-11-14

## Context

ADR-006 and architecture §3 fix the model: drafts are documents, a publish stores an immutable snapshot, rollback moves a pointer, restore copies a snapshot into the draft, and live conversations pin a version (§3.2). Tasks 7.1 and 7.2 need answers the docs leave open:

1. The Studio's routes for versions, their permissions and audit entries.
2. What the content hash covers, so "identical drafts produce the same hash" (7.1 acceptance) holds.
3. What a `target=production` connection runs before the bot has ever been published. Until now every conversation ran the draft, because versions did not exist.
4. Whether `bot_versions` rows can change after they are written.

## Decision

1. **Routes** under `/v1/workspaces/:workspaceId/bots/:botId/versions`, with the builder's session as every Studio route.
   - `GET` lists versions newest first: `{ id, number, label, notes, definitionHash, createdBy, createdAt, live }`. Cursor-paginated on `number`.
   - `GET /:versionId` returns the same fields plus `definition`.
   - `POST { label, notes? }` publishes the draft (`bot.publish`, audit `bot.published`). It assembles the draft, runs `validateDefinition`, and refuses with `definition_invalid` carrying `issues` when any issue is an error. Otherwise it stores the next `number` and points `bots.published_version_id` at it in the same transaction.
   - `POST /:versionId/rollback` points `published_version_id` at that version (`bot.publish`, audit `bot.rolled_back` with `from` and `to`). Nothing else changes.
   - `POST /:versionId/restore` makes the draft equal to the version (`bot.update`, audit `bot.restored`). The manifest and every workflow in the version are saved as new revisions (existing workflow documents get `rev + 1`, missing ones are created at 0), and draft workflows that are not in the version are deleted. An open Studio sees revision conflicts and reloads, as with any other concurrent save.
2. **The hash** is SHA-256 over the canonical JSON of the BotDefinition (keys sorted at every level, arrays in order), stored as lowercase hex. It includes `layout`: a version is the whole definition, and moving a node is a change a builder may want to publish. Identical drafts therefore hash the same; the Compare view (7.4 diff) still ignores layout.
3. **Before the first publish, a production connection refuses messages** with a new error code `bot_not_published` (409, "This bot has not been published yet", fix "Publish the bot in the Studio, or use a connection with target draft."). Running the draft silently would put unreviewed edits in front of customers the moment a builder types. Emulator conversations and `target=draft` connections keep running the draft. After a publish, new production conversations pin the published version; existing ones migrate at their next turn (§3.2, task 7.2).
4. **Versions are immutable.** `app_rw` has no `update` or `delete` on `bot_versions`. Rows go away only with their bot (foreign-key cascade).

## Consequences

- The error list gains `bot_not_published`. It is added to `errors.ts` and to the Bridge OpenAPI error enum in the same PR (doc correction, recorded there).
- Internal test setups that send live messages to a production connection of an unpublished bot start getting `409 bot_not_published`. Publishing once fixes them.
- Restore is destructive for draft workflows that the version does not have. The Studio's confirmation (7.5) says so and names them.
