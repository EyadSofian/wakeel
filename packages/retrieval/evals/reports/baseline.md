# Retrieval baseline — 2026-11-15

The run used 240 authored questions and 240 synthetic passages in disposable Postgres. It compared dense-only retrieval with the production hybrid fusion and real cross-encoder reranking.

- Embedding model: `text-embedding-3-large`
- Reranker: `bge-reranker-v2-m3` via TEI with ONNX revision `5ae1fc0cfa7c2097ba2303c8a0db443d0597b3a7`
- Fixture SHA-256: `4d533199f88f1042c1d728ba407fe083d947987654eed92fe695fc5584366e2e`

| Set | Queries | Dense recall@5 | Hybrid recall@5 | Dense MRR@30 | Hybrid MRR@30 | Acceptance |
|---|---:|---:|---:|---:|---:|---|
| msa | 60 | 0.8833 | 1.0000 | 0.6688 | 1.0000 | Pass |
| egyptian | 60 | 0.8000 | 1.0000 | 0.5795 | 0.9667 | Pass |
| gulf | 60 | 0.8167 | 1.0000 | 0.6308 | 1.0000 | Pass |
| code-switched | 60 | 0.8167 | 1.0000 | 0.6471 | 1.0000 | Pass |

**Result: passes all four sets.**

The evaluator recorded 484 model calls and 7200 reranked text pairs in eval mode. The recorded embedding cost was $0.003900 USD. Railway service compute is separate.

The accompanying JSON preserves the fixed judgments and both ranked lists for each question.
