# ADR-055 — Search the knowledge base before the Autonomous Node replies

Status: accepted (Eyad approved in writing on 2026-11-17) · Date: 2026-11-17 · Tasks: 6.12 and 6.13

## Context

Today the Autonomous Node reads its knowledge base only if the model decides to. The model has to
write a `:::run` block that calls a `kb_search` tool, wait for that block's result, and then answer
in another full model call (architecture §6.3). Nothing makes it search, and the passages it finds
are kept only for the rest of that turn.

The Majed pilot (`docs/pilot/majed/README.md`, task 15.6) shows what this costs:

- **The model answers without searching.** The acceptance case about the HVAC course failed because
  `gpt-6-luna` answered the first message from its own knowledge, without calling `searchKnowledge`.
  After the pilot, Eyad judged the bot "not understanding". No one has counted how many of those
  replies came without a search; the trace records this for every reply.
- **Rules moved into the knowledge base work only if they are searched for.** Majed's
  31,924-character Botpress prompt was cut to 14,955 characters to fit the 16,000-character
  instructions limit. The offer scripts, objection answers and policies went into the KB word for
  word, so the bot now follows them only when it thinks to look them up.
- **Every search costs a full model call.** The model writes the search, the sandbox runs it, and the
  whole prompt goes to the model again with the result. That is part of the 4–30 s replies the pilot
  measured.
- **Follow-up questions do not search well.** The model writes its own query from the latest
  message. A follow-up like "طب سعرها كام؟" ("so how much is it?") does not name the course.
  The passages found in the previous turn have already been dropped, because feedback is cleared
  after each iteration.

PR #141 fixed a separate defect: search results were cut at 4,000 characters, so the model saw
about 3.5 of 5 passages. That fix is needed whatever is decided here, but it does nothing for a
model that never searches.

Botpress's Autonomous Node has a separate "RAG model" override and a "Search Knowledge" tool per KB
(research report §1.4 item 17, §1.6). The research did not establish whether it searches before the
model runs. Their retrieval itself runs in their closed cloud. We cannot copy what they do, and we
do not need to.

Constraints that bind any answer:

- CLAUDE.md §9: no implicit tools; every tool the model can call is listed on the node. KB text never
  goes into a system prompt.
- Architecture §6.4 / ADR-031: the system text stays the same for the whole conversation, so the
  prompt cache keeps working. Untrusted content goes only into user-role `<data>` blocks.
- ADR-043: one search service, one citation registry per turn, and failures are visible. A missing
  configuration is never quietly replaced by a weaker search.
- Engine rules: every step is one transaction and must be safe to run again; all I/O goes through
  ports.
- CLAUDE.md §11: anything that touches retrieval is checked with Arabic, dialect and code-switching
  fixtures.

## Options

1. **Keep model-driven search; write stronger instructions** ("always search before you answer").
   This needs no code. But the model still decides: an instruction is a request, not a guarantee,
   and `gpt-6-luna` already skipped the search in the HVAC case. Every reply that needs the KB still
   pays for one extra full model call.
2. **Search automatically, once per user message, with a rewritten query, before the model's first
   iteration.** The search uses a knowledge tool already listed on the node. The model can still
   call that tool for more passages. *(Recommended.)*
3. **Like option 2, but search with the raw message.** This saves the rewrite call. But a follow-up
   that does not name what it is about ("طب سعرها كام؟") finds nothing useful.
4. **Put the whole knowledge base in the prompt** (Majed's is about 37 K tokens; the candidate models
   take 1 M). With caching, this gives the best recall for a small KB. But the cost and latency
   grow with the KB size on every iteration, it stops working once a KB grows, and it goes around the
   retrieval pipeline that ADR-007 and ADR-043 built. Not as a general mechanism. A builder-chosen
   "always loaded" document belongs with the instructions-limit question (below), not here.
5. **Adopt LangChain or LangGraph for a retrieval chain.** These offer a retriever step and a graph
   that runs it before the model. We already have both: the search service (`packages/retrieval`)
   and a durable engine (`packages/engine`, `packages/autonomy`) with tenant isolation, a sandbox
   and traces. Adding a framework solves none of the causes above and would put a second
   orchestration layer next to ours. Rejected.

## Recommendation

Use option 2.

### Contract

`AutonomousNode` (`04-contracts/node.ts`) gets one optional field:

```ts
/** Search a knowledge tool on this node before the first iteration of each user message. */
autoSearch: z
  .object({
    /** A `kb_search` tool listed on this node. Its `kbIds` and `topK` are used. */
    toolId: ToolId,
    /** Rewrite the latest message into a standalone query with the utility model. */
    rewrite: z.boolean().default(true),
  })
  .optional(),
```

- Definition validation rejects an `autoSearch.toolId` that is not a `kb_search` tool on the same
  node. The error is `auto_search_tool_invalid` on the path `autoSearch.toolId`.
- The tool stays listed and callable, so nothing implicit is added. The automatic search is that
  tool, run once by the engine.
- `AutonomyMemory` (`04-contracts/runtime.ts`) gets an optional `knowledge` field: the passages of
  this turn's automatic search, in the tool's own shape (`token`, `title`, `section`, `text`). The
  memory is saved at the end of every step, so later iterations of the same turn reuse the passages
  and do not search again. The field is cleared when the next user message starts a turn.
- `trace.ts`: `llm.call` purposes gain `rewrite`. The `kb.search` span gains
  `trigger: "auto" | "tool" | "card" | "code"`.

### When it runs

It runs on the first iteration after an inbound user message, that is, when the step starts with
`resume.kind === "message"` or the node is entered in a turn started by a message. It does not run
on a tool result, an inactivity or other trigger, or iterations 2 and later. Those reuse
`memory.knowledge`.

The steps:

1. **Rewrite.** This is skipped when `rewrite` is false or when the message is the first inbound
   one. Otherwise the utility model (architecture §7) gets a fixed system text and, as `<data>` in
   the user turn, the conversation summary and the last six transcript messages. It returns one
   standalone query of at most 200 characters, in the user's language and dialect. If the rewrite
   fails or returns nothing usable, the raw message is used and the trace records a warning with
   its code.
2. **Search.** The same `kb.search` service and citation registry as the tool (ADR-043 §5), so the
   tokens `[[c1]]` … continue into any search the model makes later in the turn. Same `kbIds` and
   `topK` as the tool.
3. **Keep.** The passages are stored in `memory.knowledge`, using the passage shape and the size
   budget from PR #141.

### Prompt

- **Part 2 (per node, cached).** When `autoSearch` is set, the node block gets one fixed paragraph:
  "Before each reply you get passages from `<tool name>` that match the user's latest message, in
  the `knowledge` data block. Answer questions of fact from those passages, or call `<tool name>`
  for more. If neither covers the question, say you do not know; never answer it from memory." Its
  wording is decided with the eval runs (below).
- **Part 5 (per iteration, user role).** A block
  `<data source="knowledge">` holds the query that was used and the passages. If nothing was found,
  the block says so. It comes before the variables block. The system text does not change, so
  ADR-031 §5 holds and the cache is unaffected.
- `ENGINE_PROMPT_VERSION` is not bumped, because part 1 does not change.

### Failures

- **Missing configuration** (no embedding or rerank model, a KB that no longer exists) fails the node
  as a model or configuration error, as the tool does today. Definition validation should catch
  most of these before publish.
- **A failed search at run time** (reranker or embedding call down after retries) does not fail the
  turn. The `kb.search` span records the error with its code. The knowledge block tells the model:
  "The knowledge search failed. Do not answer questions of fact from memory; tell the user you
  cannot check right now." This is visible in the trace and to the model, and it is not a weaker
  search, so ADR-043 §4 holds. **Question for Eyad 1.**

### Cost and latency

Each user message adds one utility call (small; the input is about 1–2 K tokens), one embedding and
one rerank. Each main-model iteration gains the passages, about 2 K tokens. In return, a reply that
needs the KB no longer spends a whole main-model call writing a search.

Expected effect: about the same latency or faster, and more input tokens per iteration. This is
an estimate. Task 6.12 must measure it on the Majed suite before the default changes.

Usage is recorded like any other model call. Emulator and eval traffic keeps its mode and is never
counted as live conversations (CLAUDE.md §9).

### Out of scope

- **Carrying passages from one user message to the next.** The rewrite covers most follow-ups. Add
  it only if the Majed suite shows follow-up failures after this change.
- **The 16,000-character instructions limit, and "always loaded" documents for policies and
  scripts.** These need their own ADR, informed by how much of Majed's lost behaviour this ADR
  brings back.
- **A native tool-calling protocol** (architecture §6.6). That is a separate ADR, decided by the
  adherence suite.

## Questions for Eyad

Answered on acceptance (2026-11-17): Eyad approved the ADR without changing the recommendations, so
all three take the recommended answer: a failed search continues and tells the model; existing nodes
stay off and new nodes with a knowledge tool start on; the rewrite uses the workspace's utility model.

1. **A failed automatic search:** continue and tell the model (recommended, above), or fail the turn
   with `model_unavailable`?
2. **Defaults:** existing nodes stay off, so published bots do not change behaviour silently. New
   Autonomous Nodes that get a knowledge tool in the Studio start with it on. Recommended: yes to
   both.
3. **Rewrite model:** the workspace's utility model (recommended), or a separate setting per node,
   like Botpress's "RAG model" override?

## Consequences

- `docs/04-contracts/node.ts`, `runtime.ts` and `trace.ts` change as above, with fixtures, plus the
  OpenAPI agreement test where the node schema is exposed.
- `packages/autonomy` gains a `knowledge` port (search plus rewrite) supplied by the worker. The
  engine stays pure: given the same port answers, a re-run step produces the same prompt.
- Builders see every automatic search in the trace: the original message, the rewritten query, every
  stage's candidates and scores, and the passages the model got.
- If the passage budget or `topK` is set too high, prompts get longer. The node's `topK` (default 5)
  bounds that.

## Evidence required before acceptance

- Unit tests (fake LLM, fake clock):
  - search runs once per user message;
  - no search on a tool resume or a trigger;
  - later iterations reuse `memory.knowledge`;
  - a re-run step builds the same prompt;
  - rewrite failure falls back to the raw message with a warning;
  - search failure produces the knowledge block and the span error;
  - no KB text in the system text;
  - Arabic, Egyptian and Gulf dialect, and code-switched follow-ups (`packages/testing/fixtures/rtl.ts`).
- The Majed acceptance suite (13 cases), run with `gpt-6-luna` twice, with `autoSearch` off and on,
  after the eval `judge` bug is fixed. Report pass counts, median and p95 reply time, and tokens per
  reply. The HVAC case must pass with it on.
- The adherence corpus must not fall below its current 221/240 protocol-valid with the knowledge
  block present.

## Build plan

Two rows are added to Phase 6 (`docs/06-build-plan.md`) once this is accepted:

| # | Task | Acceptance |
|---|---|---|
| 6.12 | Contracts, validation, rewrite and search port, engine and prompt changes, worker wiring and trace for `autoSearch` | The unit tests and Majed comparison above |
| 6.13 | Studio: in the Autonomous node inspector's Tools section, a "Search before every reply" switch with a picker of the node's knowledge tools, and a "Rewrite follow-up questions" switch | E2E and screenshot review, design system §8 |
