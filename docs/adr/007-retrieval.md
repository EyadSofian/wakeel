# ADR-007 — Retrieval: hybrid search in Postgres with application-side Arabic normalisation

Status: accepted · Date: 2026-11-13

## Context
Knowledge bases must work well on Arabic. Dense-only retrieval loses names, numbers and rare terms; Arabic adds orthographic variation (alef and hamza forms, ta marbuta, optional diacritics, tatweel) and rich morphology. The leverage order in RAG is parsing > chunking > retrieval strategy > reranker > embedding model > LLM.

## Decision
1. **Store**: Postgres + pgvector in the main database. HNSW on a `vector(1024)` column; all supported embedding models are configured or truncated to 1024 dimensions. Each KB records its model and an `index_version`.
2. **Lexical leg**: Postgres full-text search on a `tsvector` built with the `simple` configuration from tokens that **our code** has already normalised and light-stemmed. The same function runs on the query. Postgres never applies its own Arabic analysis, so index and query cannot drift.
3. **Fusion and rerank**: reciprocal rank fusion of the top 30 dense and top 30 lexical, then a cross-encoder reranker to `topK`.
4. **Parsing**: Docling in a Python sidecar for documents; Readability for web pages; a vision model as the OCR tier for scanned pages. Parse quality is scored and shown.
5. **Chunking**: structure-aware from the parser's heading tree, tables atomic, heading path prepended to the embedded text.
6. **Models are configuration**: embedding and reranker are chosen per workspace from the registry. Defaults are multilingual models that are strong on Arabic; self-hosted BGE-M3 and bge-reranker-v2-m3 behind TEI are supported through the OpenAI-compatible and TEI adapters.
7. **Every stage is traced** (query, candidates and scores per leg, fused order, rerank order).
8. **A golden set per language** (MSA, Egyptian, Gulf, code-switched Arabic–English) lives in `packages/retrieval/evals`; recall@5 and MRR are reported in CI for any change under `packages/retrieval`.

## Alternatives considered
- **Dedicated vector database (Qdrant)**: better filtered search and quantisation at scale; a second system to secure, back up and keep tenant-isolated. Deferred until numbers demand it.
- **True BM25 (OpenSearch, or a Postgres BM25 extension)**: better ranking than `ts_rank_cd`. Deferred: the reranker corrects most ordering error, and an extra engine or an extension with a restrictive licence is not worth it before we have eval evidence.
- **Postgres built-in `arabic` text search configuration**: rejected because its stemming cannot be reproduced exactly in application code for query-side use and for mixed-language text.
- **Node-only parsing**: rejected; tables and RTL reading order are where Arabic RAG fails.
- **A RAG framework**: rejected; the pipeline is a few hundred lines we must be able to debug.

## Consequences
- We own a small Arabic normaliser and light stemmer with thorough tests (it is the highest-leverage code in retrieval).
- Changing the embedding model re-embeds a KB in the background.
- One Python service to operate.

## Revisit when
Any KB exceeds ~5 M chunks, filtered recall drops on the golden set, or lexical-leg ranking is shown to be the limiting factor.
