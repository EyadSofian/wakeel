# Retrieval golden sets (8.7)

The shared synthetic corpus has 240 FAQ passages: twenty intents across twelve fictional program codes.
Sixty authored questions per set cover MSA, Egyptian Arabic, Gulf Arabic, and Arabic–English switching.
Each question's relevant passage key is fixed before model calls. Near neighbors differ in exact code
or intent; no customer text, model-generated judgments, or provider output is used as ground truth.

Run `pnpm evals:retrieval --env-file /path/to/model.env --env-file /path/to/reranker.env`.
The runner creates a disposable Postgres database with the normal migrations and forced RLS,
embeds the original fixture text, and invokes the production candidate queries and hybrid pipeline.
Model calls carry `mode=eval`; usage is reported separately and never counted as live traffic.

Recall@5 is averaged per question; MRR considers the first relevant passage in the thirty-candidate
ranking (absent means zero). Each dialect must strictly beat dense-only on both metrics. A failed
set remains failed even if the aggregate improves. No reranker or model error is replaced with fake
scores. Reports include every ranked result, fixture hash, model ids/revisions, timings and eval usage.

Fixture edits invalidate the fingerprint and require a fresh baseline. Keep a failing real baseline
rather than changing relevance labels or removing questions to manufacture a pass.

The CI workflow needs a dedicated repository `OPENAI_API_KEY` secret. It starts the pinned
cross-encoder image on the runner's loopback interface with an ephemeral bearer key and cleans
up the container on exit. CI needs neither a public Railway endpoint nor a stored TEI key.
Scheduled runs and runs on main report a missing embedding credential explicitly.

The optional Railway fixture service uses `infra/railway/reranker.Dockerfile` with the
CPU-compatible ONNX export and revision recorded in THIRD_PARTY_NOTICES. Set the TEI bearer key
through the deployment environment and keep `LOG_LEVEL=error`. Verify `/rerank` rejects requests
without the key before sending fixtures. The service needs no application database credentials.

## Realistic set (8.9, ADR-056)

`realistic/` holds a fictional academy's twelve engineering course pages (prose, a modules table, a
cohorts table, a price and installments table, an FAQ) and 200 hand-written questions. Pages go
through the production chunker; a chunk is relevant when it belongs to the question's course and
contains the answer text after Arabic normalisation. If no single chunk holds an answer, the set
refuses to build: that is chunking losing a fact, not a label to relax.

| Slice | Questions | What it tests |
|---|---|---|
| single | 50 | Facts in a page's prose |
| follow-up | 50 | "طب وبكام؟" after an opener about a course; only the conversation names it |
| table | 40 | Prices, installments, early-bird prices, cohort dates, inside tables |
| near-miss | 30 | Look-alike courses (Revit Architecture / MEP, AutoCAD Civil / MEP, ETABS / SAP2000, …) |
| unanswerable | 30 | Not in the catalogue; counted, not scored, for the grounding gate (G2) |

Every slice is spread evenly over MSA, Egyptian, Gulf and code-switched questions. ADR-056 G1 asks
for recall@5 ≥ 0.90 on every answerable slice.

Run it as written, then with ADR-055's rewrite (the production prompt from `@wakeel/autonomy`):

```bash
pnpm evals:retrieval --set realistic --env-file /path/to/model.env --env-file /path/to/reranker.env
pnpm evals:retrieval --set realistic --rewrite-model gpt-6-luna --env-file /path/to/model.env --env-file /path/to/reranker.env
```

Reports go to `reports/realistic-as-asked.json` and `reports/realistic-rewritten.json`.
