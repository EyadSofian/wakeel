# ADR-038 — Bot export and import: the file, the routes, and what is not carried

Status: proposed (implemented as proposed in task 7.6; review with that PR) · Date: 2026-11-15

## Context

Task 7.6 asks for export and import of a bot's definition JSON, with ids regenerated on import and knowledge base and table references reported as unresolved. The docs do not say what the file looks like, what it contains, or how the Studio reaches it.

## Decision

1. **The file** is `{ format: "wakeel.bot", formatVersion: 1, exportedAt, definition }`, where `definition` is the draft as a BotDefinition (`BotExport` in `packages/contracts/src/portable.ts`). Layout is included, so an imported bot looks the same on the canvas. Versions, config variable values (secrets above all), conversations, connections and keys are never exported.
2. **Export:** `GET /v1/workspaces/:ws/bots/:botId/export` (`bot.read`). It returns the file with `Content-Disposition: attachment; filename="<slug>.wakeel.json"`. It reads the stored draft, so the Studio saves first.
3. **Import:** `POST /v1/workspaces/:ws/bots/import { name, slug, file }` (`bot.create`, audit `bot.imported`).
   - The file must parse as `BotExport`. A future `schemaVersion` is refused as `validation_failed`.
   - Every element id the definition declares is regenerated and replaced wherever it is used (`regenerateIds`). Ids are only replaced where they are declared, so builder text that merely looks like an id is not touched.
   - The answer is `{ bot, unresolved: [{ kind, id }] }`: the knowledge bases and tables the definition names that the workspace does not have. They stay in the definition; validation then reports them on the canvas until the builder points them at the workspace's own (architecture §3.1).
4. **The Studio:** "Export bot" is a command palette action inside a bot. "Import bot" sits next to "New bot" on the workspace home.

## Consequences

- An import never brings secrets or config values. Declared config variable names come along with the manifest, and their values must be set again.
- Two imports of one file give two bots with different ids. Traces and analytics of one never mix with the other.
