# ADR-059 — Retrieval context: neighbour expansion, contextual chunk headers and an embedding bake-off

Status: proposed · Date: 2026-11-17 · Amends ADR-007 §5 · Review: `docs/research/2026-11-17-ai-layer-review.md`

## Context

ADR-007's pipeline does well on our synthetic golden sets: hybrid plus rerank has recall@5 = 1.0 on
all four dialect sets. Those sets are short FAQ passages with one intent each. The documents in real
bots look different. Majed's knowledge base is course pages: a price table here, a schedule there,
an installment rule further down, often in separate chunks under one heading.

The current design loses context in two places:

1. **Search returns single chunks of about 350 tokens.** When a question's answer spans the matched
   chunk and the next one, such as a course name in one and its price in the next, the model gets
   only half. Chunks already store `ordinal` and `heading_path`
   (`packages/db/migrations/0015_kb.sql`), so the neighbours are one query away. Nothing fetches
   them.
2. **A chunk's embedded text is its heading path plus its text** (ADR-007 §5). The document title is
   not part of it. A chunk "السعر 5,000 جنيه والتقسيط على 3 شهور" under the heading "الأسعار"
   does not say which course it belongs to. Dense and lexical search then cannot tell ten courses'
   price chunks apart.

The production stack reference names both fixes:

- "Parent-child: embed small chunks (precision), return the parent section (context). Cheap,
  consistently helps."
- "Contextual enrichment: prepend doc-summary/section-path to each chunk before embedding —
  meaningful gains at one-time LLM cost."

It also says embedding leaderboards do not transfer across domains and dialects. Candidates are
chosen on our own data, served by TEI, not Ollama.

The OpenAI embeddings guide documents `text-embedding-3-large` at 3,072 dimensions and supports
shortening to 1,024 "trading off some accuracy". It gives no Arabic or multilingual figures. The
Ollama catalogue lists self-hostable multilingual models: `bge-m3`, `qwen3-embedding`,
`snowflake-arctic-embed2`, `nomic-embed-text-v2-moe` and `granite-embedding` (278M).

## Options

1. **Change nothing until ADR-056's realistic golden set shows a loss.** This is honest, but the two
   losses above are visible by construction, and the set is being built anyway.
2. **Neighbour expansion at read time, the document title in the embedded text, opt-in LLM context
   headers, and a measured embedding bake-off.** Each step is judged by the realistic set.
   *(Recommended.)*
3. **Smaller chunks with parent sections returned.** This means re-chunking everything with a second
   chunk tier. Neighbour expansion gets most of the benefit with no re-index.
4. **GraphRAG, a dedicated vector database, semantic caching.** The stack reference's "skip in 2026"
   list says to demand an eval delta first. Not now.

## Recommendation

Use option 2, in this order. Each step merges only if ADR-056 G1 holds and G2 does not drop.

### Step 1 — Neighbour expansion (read time, no re-index)

After rerank picks `topK` chunks:

1. For each chunk, load the chunks with ordinal ±1 in the same document, index version and heading
   path.
2. Merge chunks that touch or overlap into one passage, removing the 15% overlap text.
3. Cap each passage at 900 estimated tokens: keep the matched chunk whole and trim neighbours from
   the far side.

Details:

- Two selected chunks in the same section become one passage. This frees a `topK` slot.
- Each passage keeps one citation token, registered against the matched chunk.
- The passage records the ids of the chunks it added. The trace shows them.
- The setting is `expand: "none" | "neighbours"` on `KbSearchTool` and the KB Search card. It
  defaults to `"neighbours"` for new tools and to `"none"` for existing ones, so published bots do
  not change.
- PR #141's 12,000-character result budget fits five expanded Arabic passages.

### Step 2 — The document title in the embedded and lexical text (re-index)

- The embedding input becomes `title › heading path \n text`. The lexical tokens include the title.
- The normaliser runs on it at index time and at query time, unchanged (CLAUDE.md §11).
- This bumps `index_version`. KBs re-embed in the background, and search uses the old version until
  the new one is complete (architecture §8.1).

### Step 3 — Contextual chunk headers (opt-in per KB, re-index)

- A KB setting `contextualHeaders: boolean` (default false).
- When on, the ingestion `embed` stage asks the utility model for one sentence of at most 40 words,
  per chunk. The sentence says what the chunk is about within its document, in the document's
  language.
- The model gets the document (cached, ADR-058) and the chunk, both as data.
- The sentence is stored in a new `chunks.context` column. It is prepended to the embedding input
  and the lexical tokens, and shown in the chunk inspector.
- Cost: one utility call per chunk, recorded as eval or ingestion usage, never as conversations. The
  Studio shows an estimate before the switch is turned on.
- A failed call fails the stage with a code. Ingestion stages already re-run (#137). The chunk is
  never indexed without its header while the setting is on.

### Step 4 — The embedding bake-off (method only; the choice is a config change)

The candidates:

| Candidate | Where it runs |
|---|---|
| `text-embedding-3-large` at 1,024 (current) | API |
| `bge-m3` | TEI |
| `qwen3-embedding` 0.6B and 4B | TEI, if TEI serves it; Infinity otherwise |
| `snowflake-arctic-embed2` | TEI |

Each candidate needs at least 1,024 dimensions, or a documented safe truncation to 1,024, verified
on its model card before it is tested.

Measures, on the synthetic and realistic sets:

- dense-only recall@5 and MRR;
- full-pipeline recall@5 and MRR, because the reranker can hide differences between embedders;
- ingestion cost and query latency.

The winner becomes the default embedding model in the registry through ADR-007 §6. Existing KBs
keep their model until a builder changes it. Self-hosting a model is a separate decision about cost
and operations, recorded in the gate report.

## Consequences

Contract changes:

- `docs/04-contracts/node.ts` and `card.ts`: `expand` on the KB tool and card.
- KB settings: `contextualHeaders`.
- `SearchCandidate` gains `ordinal`.
- A migration adds `chunks.context text null` (forward-only, RLS unchanged, two-tenant test
  extended).

ADR-007 §5 changes: the embedded string is `title › heading path \n [context \n] text`.

Ingestion of a KB with contextual headers costs one utility call per chunk. About 300 chunks for a
course catalogue like Majed's is cents on a small model, but it grows with the corpus.

New build-plan rows once accepted:

- **8.9** — expansion;
- **8.10** — title in the index;
- **8.11** — contextual headers;
- **8.12** — bake-off report.

8.11 waits for the realistic set (ADR-056, 8.8).

## Questions for Eyad

1. **Expansion default for new tools:** on (recommended), or off until measured?
2. **TEI:** may we add `bge-m3` next to the existing reranker for the bake-off? It needs a second
   service, CPU or GPU, on Railway.
