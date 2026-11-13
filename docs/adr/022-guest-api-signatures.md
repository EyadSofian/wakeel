# ADR-022 — Signatures of the sandbox guest API

Status: proposed (task 2.9 generates editor typings with these signatures; 3.3 implements them in the sandbox) · Date: 2026-11-14

## Context

Architecture §5.2 lists the guest API by name: `workflow`, `conversation`, `user`, `bot`, `event`, `env`, `turn`, `fetch`, `tables.<name>.{find,get,insert,update,upsert,delete}`, `kb.search`, `ai.{generate,extract,classify}`, `log.{info,warn,error}`, `say(message)`, `ctx.idempotencyKey`, and an `axios`-shaped helper. It also says: "The Studio code editor receives a generated `.d.ts` for exactly these globals using the bot's real variable and table schemas."

The scope objects are fully defined by the contracts (`variable.ts`, `event.ts`). The functions are not: no document gives their parameters, return values or errors. Task 2.9 (the editor typings) has to print them, and task 3.3 (the guest layer) has to implement them. If each guesses separately, the editor will promise an API the sandbox does not have.

Two smaller gaps:
- `CodeTool.source` is documented as the body of `async (input, ctx) => { ... }`. `CodeCard.source` says only "Run JavaScript in the sandbox".
- Table rows have no `id` column in `TableSchema`, but `get`, `update` and `delete` need some way to name a row.

## Options

1. **Derive the signatures from the card contracts** that already do the same jobs. A Table card has `where`, `search`, `sort`, `limit`, `values` and `upsertOn`. Generate text has `instructions`, `input`, `model` and `maxOutputTokens`. Extract data has `input`, `schema`, `instructions` and `model`. Search knowledge has `kbIds`, `query` and `topK`. Code and cards then offer the same operations with the same names and limits.
2. **Copy another platform's API** (for example Botpress Execute Code). This makes migration easier but brings in names and shapes the rest of our contracts do not use. We also may not copy their text.
3. **Leave the functions untyped** (`any`) until 3.3. Autocomplete would work for variables only, and nothing would stop 3.3 from choosing different shapes.

## Recommendation

Option 1, with these signatures (the generated `.d.ts` in `packages/contracts/test/__snapshots__/typings-sample.d.ts` is the full text):

- **Run code body.** `CodeCard.source` is the body of an `async` function, as for code tools. `return` and top-level `await` are allowed, and the returned value is ignored.
- **`say(message: string | BotMessage): Promise<void>`.** A string is a text message. `BotMessage` is `BotMessagePayload` from `message.ts`.
- **`fetch(url, init?)`** with `method`, `headers` and a string `body`. It resolves to `{ ok, status, statusText, url, headers.get(), text(), json() }`. Limits are as in §5.2.
- **`axios.{get,delete}(url, config?)`, `axios.{post,put,patch}(url, data?, config?)`.** `config` takes `headers` and `params`. Each resolves to `{ status, statusText, headers, data }`, where `data` is parsed JSON or the text.
- **`tables.<name>`**, where every row has a read-only `id: string`:
  - `find({ where?, search?, sort?, limit? })` resolves to the rows.
  - `get(where)` resolves to the first match or `null`.
  - `insert(values)` resolves to the new row.
  - `update(where, values)` resolves to the number of rows changed.
  - `upsert(values, on)` resolves to the row.
  - `delete(where)` resolves to the number of rows deleted.
  - `where` is `Filter` from `table.ts`, with values instead of expressions and exactly one operator per column condition.
- **`kb.search(query, { kbIds?, topK? })`** resolves to `Passage[]` (from `card.ts`).
- **`ai.generate({ instructions, input?, model?, maxOutputTokens? })`** resolves to the text.
- **`ai.extract({ input, schema, instructions?, model? })`** resolves to JSON that matches `schema`. The schema uses the builder subset in `json-schema.ts`.
- **`ai.classify({ input, labels, instructions?, model? })`** resolves to one of the labels.
- **`log.info|warn|error(...args)`** returns nothing.
- **`ctx.idempotencyKey: string`** is the same on every retry of the step.

Failures throw an `Error` whose `code` is one from `errors.ts` (for example `fetch_blocked`, `table_row_invalid`, `model_unavailable`). An uncaught error ends the card through its `error` port (§4.4).

## Consequences

- 2.9 prints exactly these signatures. Changing one later means changing `packages/contracts/src/typings.ts` and its snapshot in the same PR as the sandbox.
- 3.3 implements the guest layer to these shapes, and a contract test checks that every global in the `.d.ts` exists in the sandbox. That test belongs with 3.3.
- `TableSchema` does not gain an `id` column. Every row gets a system `id` (`row_<ULID>`) when phase 10 builds tables.
- `classify` has no card yet. It is listed in §5.2, so it is typed now.
