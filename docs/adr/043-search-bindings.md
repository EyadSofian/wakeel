# ADR-043 — Search configuration and the missing retrieval bindings

Status: proposed · Date: 2026-11-15 · Task: 8.6

## Context

Architecture §8.2 already fixes the retrieval algorithm: 30 dense candidates, 30 lexical candidates,
the shared Arabic normalizer, RRF with k = 60, and reranking of the top 30. ADR-007 requires a
configured cross-encoder. `Passage`, citations and the `kb.search` span already have contracts.
Those decisions are not being reopened.

The current implementation and documents leave these binding decisions open:

- `filters?` has no schema or named fields.
- `KbSearchCard` refers to a score floor, but no setting or default defines one.
- The registry has chat and embedding kinds, no reranker kind or rerank-capable credential provider.
  Workspace model settings have default/utility choices, but no reranker selection. There is no
  embedding or reranking model entry in the shipped registry.
- A request can select several KBs, each with a different embedding model. A single query vector
  cannot be compared to vectors from a different model, even when their dimensions match.
- Citation tokens such as `[[c1]]` need a shared allocator if two searches run during one turn.
- The optional generated answer on the Search knowledge card has a contract, but no binding to
  retrieval, model invocation or citation validation.

AGENTS.md §3 requires a proposed ADR and a separate PR before implementing a missing design.
No task 8.6 implementation accompanies this proposal.

## Options

1. Define the small bindings below and keep the documented retrieval pipeline. This enables the
   card, explicit tool and code API to share one implementation and trace.
2. Implement only a standalone search helper and leave filters, reranking configuration, generated
   answers and shared citations unresolved. This does not satisfy task 8.6.
3. Add automatic dense-only fallbacks or invent cross-model fusion. This changes the normative
   pipeline and makes failures harder to explain; it is not recommended.

## Recommendation

Choose option 1 with these explicit boundaries:

1. Add a zod search request contract with `query`, `kbIds`, `topK` and optional filters consisting
   only of `documentIds`, `sourceIds` and `languages`. Within a field, values are alternatives;
   populated fields are combined with AND. Apply them to both retrieval legs. Resolve every KB
   under `withWorkspace` and the current bot before any embedding call. Missing or foreign KB ids
   fail instead of being silently dropped.
2. Require every KB in one request to use the same active embedding model. Reject mixed-model
   requests with `validation_failed` and an actionable field error. Supporting mixed embedding
   spaces can be designed separately; raw cosine scores from unrelated spaces are not calibrated.
3. Add an optional workspace reranker model setting and a `rerank` registry kind. Introduce explicit
   provider descriptors for the documented direct rerank adapters (TEI and a hosted rerank API),
   with the corresponding credential schemas. Model ids and prices belong only in the registry.
   Deployment/model selection must provide actual reachable models before a real golden-set run;
   fake providers belong only in tests. Any tenant-configured provider URL must go through egress.
4. Add an optional finite `minScore` setting per KB, defaulting to no floor. Compare it with that
   KB's raw reranker score; no undocumented normalization or fabricated probability. With no
   candidates surviving, return no passages so the card takes `not_found`. Missing configuration
   or reranker failure is a visible model error, never an implicit dense-only result.
5. Allocate citation labels monotonically within the turn and register each against the existing
   Citation contract. The card, `kb.search` code API and explicit `kb_search` tool share that
   registry. A later search cannot replace the document behind an earlier label.
6. Generate an optional card answer only from the returned passages using the selected chat model.
   Builder-authored instructions may be trusted; rendered user/KB/tool values stay in user-role
   data blocks. Map only registered citation labels into message citations. Persist the requested
   passage/answer variable writes, and send an answer only when `answer.send` is true.
7. Keep every stage's candidate ids and raw scores in the existing `kb.search` span. Use the same
   service for the card, explicit tool, code API and Studio playground. Tests cover bot/tenant/KB
   boundaries, identical index/query normalization, filters, ties, missing configuration, reranker
   failure and repeated searches with citations. Real golden-set evidence remains task 8.7.

## Consequences

- This adds contracts and configuration; they must be reviewed before implementation, rather than
  silently introduced while writing SQL.
- Builders must choose KBs using one embedding model per search request.
- Tests can exercise the complete pipeline with fake embeddings and reranking, but that does not
  prove Arabic retrieval quality. Task 8.7 still requires its real-provider baseline.
- The current Railway deployment has neither parser nor object storage, so uploading the code is
  separate from declaring the KB system deployed and verified.

## Decision requested

Approve or amend recommendation 1–7 before task 8.6 implementation. This proposal does not approve
the earlier proposed storage/ingestion/source decisions (ADR-039, ADR-041 and ADR-042), and does not
waive the production sandbox requirements or the remaining launch gates.
