# 04 — Contracts

These files are the source of truth for data shapes. In Phase 0 the executor copies the `.ts` files unchanged into `packages/contracts/src/` and from then on edits them only there, with an ADR for any breaking change.

Verified on 2026-11-13: `tsc --strict` passes against `zod@4.6.7`; a smoke test parses a sample bot definition, a bridge event, a conversation state, a table filter and an eval case, and rejects the negative cases. `bridge-api.openapi.yaml` validates with `@redocly/cli lint`.

| File | Contains |
|---|---|
| `common.ts` | Id formats, identifiers, templates, expressions, JSON, locale, model reference |
| `variable.ts` | Variable, scopes, types, config variables, workflow inputs and outputs, access rules |
| `message.ts` | Bot and user message payloads, citations, stored message |
| `table.ts` | Column types, table schema, filter AST, find request |
| `card.ts` | Message templates, all card types, card ports, MVP card list |
| `node.ts` | Autonomous Node tools and exits, all node types |
| `workflow.ts` | Ports, edges, layout, workflow, `nodePorts`, `checkWorkflowStructure` |
| `bot-definition.ts` | Settings, manifest, BotDefinition, draft documents |
| `event.ts` | Bridge requests, the `event` scope, outbound events, signing constants |
| `runtime.ts` | Frame, wait, autonomy memory, ConversationState, step outcome, limits |
| `trace.ts` | Span kinds and attributes, payload reference, trace |
| `errors.ts` | Error catalogue with user-facing title and fix, problem document |
| `eval.ts` | Eval case, turn, assertions, result |
| `bridge-api.openapi.yaml` | The Bridge API (OpenAPI 3.1, including the webhook) |
| `chatwoot-adapter-spec.md` | Reference adapter behaviour |

## Rules for the executor

1. **zod is the only schema language.** TypeScript types are always `z.infer`. JSON columns in the database are parsed with these schemas on read and write.
2. **The OpenAPI file and `event.ts` / `message.ts` must agree.** A test in `packages/contracts` loads the YAML, converts each zod schema with `z.toJSONSchema`, and compares field names, required lists and enums for: `SendMessageRequest`, `SendEventRequest`, `UserData`, every message type, every event type, `Problem`. A mismatch fails CI.
3. **Ids**: never construct an id by string concatenation outside `packages/contracts/src/ids.ts` (to be written: `newId(prefix)` for ULIDs, `newElementId(prefix)` for nanoids).
4. **Adding a card type** means: schema in `card.ts`, port keys in `cardPortKeys`, executor in `packages/engine/src/cards/<type>.ts`, inspector form in the Studio, canvas summary renderer, validation rules, docs entry, tests for each. The build plan's "card checklist" lists these.
5. **Changing a definition schema** means: bump `SCHEMA_VERSION`, add `migrations/<n>-to-<n+1>.ts`, add a fixture of the old shape and a test that migrates it.
6. **Error text** lives only in `errors.ts`. UI and API never hard-code an error sentence.

## Conventions worth knowing

- **Port ids** on edges: `next`, `error`, `exit:<exitId>`, `card:<cardId>:<key>`. `nodePorts(node)` is the single function that says which ports exist; the canvas, the validator and the engine all call it.
- **Inactivity** is handled by a Trigger node with `on.kind = "inactivity"` in the Main workflow. Without one, the conversation ends with reason `inactivity`.
- **Message templates** (`card.ts`) are rendered, then validated against the strict payloads in `message.ts`. A template that renders to an invalid message fails the card with `message_invalid`; it never reaches the bridge.
- **Variable values** in state are keyed by variable id, not name, so renaming a variable does not lose data.
- **`event.exit`** carries the data a model supplied when leaving an Autonomous Node, for the cards that run next.
