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

The CI workflow expects the repository secrets `OPENAI_API_KEY` and `TEI_API_KEY` and the
repository variables `TEI_BASE_URL` and `TEI_MODEL_REVISION`. Configure them using credentials
dedicated to eval traffic. Scheduled runs and runs on main fail visibly if configuration is missing.

The optional Railway fixture service uses `infra/railway/reranker.Dockerfile` with the
CPU-compatible ONNX export and revision recorded in THIRD_PARTY_NOTICES. Set the TEI bearer key
through the deployment environment and keep `LOG_LEVEL=error`. Verify `/rerank` rejects requests
without the key before sending fixtures. The service needs no application database credentials.
