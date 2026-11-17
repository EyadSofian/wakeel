# AI layer review: why the bots answer badly, and the plan to fix it

Date: 2026-11-17 · Author: Claude, for Eyad · Status: proposal. Nothing here is decided until the
ADRs it points to are accepted.

## 1. The question

Eyad's question: bots built on the platform feel much less capable than the same bots in Botpress.
Is the cause the embeddings, the database, the prompt, or something else? Should we adopt LangChain
or LangGraph? What would make the core AI layer as strong as possible?

Short answer:

- **It is not the embeddings or the database.** On our synthetic golden sets, hybrid search with
  rerank finds the right passage in the top 5 for 240 of 240 questions, in MSA, Egyptian, Gulf and
  code-switched Arabic (`packages/retrieval/evals/reports/baseline.json`).
- **The losses are in the agent layer.** These are, in order of evidence:
  - The model does not search.
  - When it did search, the results were cut short (fixed in PR #141).
  - Half of Majed's prompt was moved into the KB, where only a search can find it.
  - Majed runs on the cheapest model in the registry.
  - Nothing measures answer quality: the judge is broken, and no gate blocks a change that makes
    answers worse.
- **Do not adopt LangChain or LangGraph.** Every source below supports owning a small loop. The
  production stack reference says it directly: no "RAG framework as the system core".
  Our engine already does what those frameworks would add.

## 2. Sources and what each changes for us

| Source | What it says that matters here | Effect on this plan |
|---|---|---|
| OpenAI, *A practical guide to building agents* (PDF, 34 pp.) | Agent = model + tools + instructions, run in a loop until an exit. Build the prototype with the most capable model, set up evals, then swap in smaller models. Turn existing policy documents into numbered instructions ("routines"). Stay single-agent until instructions or tool choice break down; tool *overlap*, not tool count, is the signal. Layered guardrails: relevance, safety, PII, moderation, tool risk ratings, rules. Hand to a human after repeated failures and before high-risk actions | Our single-agent loop is the recommended shape. We broke two of its rules: we started on the smallest model, and we have no working quality evals. Guardrails (§3, G-rows) are a later layer |
| Production AI stack skill (`production-ai-stack`, from h9-tec/production-ai-stack, July 2026) | "The model is ~20% of the system." Leverage order: parsing > chunking > retrieval > reranker > embedding > LLM. Hybrid + RRF + rerank is mandatory for Arabic. Parent-child chunks and contextual chunk headers help. Golden set first: "50 hand-labeled examples beat an uncalibrated LLM-judge". Latency budget first. Prefix caching is "free money". Model routing is the biggest cost lever. Skip "a RAG framework as the system core" | Confirms what we already built: pgvector hybrid, RRF, rerank, Docling, our own loop. Adds: calibrated evals as a gate (ADR-056), latency budget, caching (ADR-058), parent/neighbour expansion and contextual headers (ADR-059) |
| GitHub blog, *agent skills* (2026-11-12) | A skill is a versioned `SKILL.md` for one bounded, repeatable job. The host supplies tools and permissions. Enforcement that must hold belongs outside the model. Use a separate verifier: "self-verification is not verification" | The pattern for long bot instructions (ADR-057). Hard rules stay in code and always-on instructions, not in loaded modules |
| addyosmani/agent-skills (MIT) | Only names and descriptions sit in context; the body loads when relevant. Descriptions say *what* and *when* (≤ 1,024 chars). Keep `SKILL.md` < 500 lines. Write the procedure, not a workaround for one model | The format rules for playbooks (ADR-057) |
| LangChain, *LangChain Skills* + langchain-ai/langchain-skills (MIT) | Skills load on demand because too many tools degrade performance. LangChain reports Claude Code passing 25% (29% elsewhere on the same page) of its tasks without skills and 95% with them, from a LangSmith eval of unstated size. Its evals philosophy: run every task with and without the skill, record outcome, cost, latency and whether the skill loaded; "one trial per profile is an anecdote". The verifier is checked against human judgment before it counts | The with/without comparison method and calibration rules in ADR-056. The 25%→95% figure is vendor-reported and is not used as evidence for bots |
| dev.to, *Skills required for building AI agents in 2026* | An agent is "a while loop plus tool-calling"; the rest is the hard part. Break tasks into subtasks with success criteria. Use a status summary each step. Know when not to use an agent. Reported multi-agent failure rates of 41–86.7% (MAST), not verified | Supports staying single-agent per node and using our workflows for deterministic steps |
| OpenAI embeddings guide | `text-embedding-3-large`: 3,072 dims, shortened with `dimensions`; at 1,024 "trading off some accuracy". Vectors are unit length; use cosine. MTEB 64.6%. No Arabic or multilingual data | We truncate client-side and re-normalise (`packages/retrieval/src/embed.ts`), which the guide allows. Arabic quality must come from our own golden set (ADR-059) |
| Ollama embedding catalogue | Self-hostable multilingual candidates: `bge-m3` (567M), `qwen3-embedding` (0.6/4/8B), `snowflake-arctic-embed2` (568M), `nomic-embed-text-v2-moe`, `granite-embedding` 278M, `embeddinggemma-2`. Ollama is "dev/edge", not a production serving tier (stack skill §1) | Candidates for the embedding bake-off, served by TEI, not Ollama (ADR-059) |

## 3. Audit of the current AI layer

Evidence is from `main` at `456b199` unless marked. Severity: **A** loses answers today, **B**
costs quality or money at scale, **C** a later layer.

| # | Finding | Evidence | Sev. | Fix |
|---|---|---|---|---|
| 1 | The model decides whether to read the KB. In Majed's HVAC case it answered without searching | `docs/pilot/majed/README.md` Results | A | ADR-055 (proposed, PR #142) |
| 2 | Search results were cut at 4,000 chars mid-JSON; ~3.5 of 5 Arabic passages reached the model | `packages/autonomy/src/engine.ts:604` | A | PR #141 |
| 3 | Instructions are capped at 16,000 chars; Majed's 31,924-char prompt lost its scripts, objections and policies to the KB | `docs/04-contracts/common.ts:63`, pilot README | A | ADR-057 |
| 4 | Majed runs on `gpt-6-luna` ($0.10/$0.50 per MTok, the cheapest model in the registry). The adherence run had it at 221/240, below the 98% gate. `gpt-6.1-sol` and Claude were never measured; Claude failed on credits | `packages/llm/src/models.json`, `packages/autonomy/evals/reports/SUMMARY.md` | A | ADR-056 gate G0: measure the strongest model first |
| 5 | The eval judge has `maxOutputTokens: 16`; reasoning models spend that on reasoning, so 3 of 13 Majed cases end as `eval_assertion_unavailable` | `apps/worker/src/eval/run.ts:218` | A | Bug fix, no ADR |
| 6 | No quality gate: a prompt, model or retrieval change can ship without a before/after comparison | build plan 12.x builds the runner, not the gate | A | ADR-056 |
| 7 | Passages found in one user turn are gone by the next; follow-ups search with the model's own query | `engine.ts` clears `memory.feedback` each iteration | B | ADR-055 rewrite; measure before carrying passages over |
| 8 | No cache breakpoints for Anthropic models. The prompt is ordered for caching (§6.4), but nothing marks the prefix, so Claude bills the whole system text on every iteration. OpenAI caches long prefixes automatically | `packages/llm/src/client.ts:304-320`, `adapters.ts` | B | ADR-058 |
| 9 | No reasoning-effort setting. GPT-6 models reject `temperature`, which suggests they are reasoning models. Their default effort may explain part of the 4–30 s replies. Unmeasured | `models.json` capabilities | B | ADR-058 |
| 10 | Search returns isolated 350-token chunks. A price or a date that sits in the next chunk of the same section is lost | `packages/retrieval/src/search.ts` | B | ADR-059 neighbour expansion |
| 11 | A chunk's embedded text is its heading path plus its text. There is no document-level context, so "the price is 5,000" does not say for which course | `packages/retrieval/src/chunk.ts` `embeddingInput` | B | ADR-059 contextual headers |
| 12 | The golden set is synthetic FAQ passages, one intent each (recall@5 = 1.0). It does not have long course pages, tables, follow-ups or unanswerable questions, so it cannot show the losses in rows 10–11 | `packages/retrieval/evals/README.md` | B | ADR-056 adds a realistic set |
| 13 | No web search or URL fetch at run time. URL, sitemap and crawl sources exist only for KB ingestion | ADR-042 | C | ADR-060 |
| 14 | No relevance, safety or PII classifiers in the turn path. Containment is architectural: listed tools, schemas, granted variables, egress | architecture §6.5 | C | Later ADR after the gates exist |
| 15 | Protocol v1 (`:::say`/`:::run`) costs adherence on small models: 92% on `gpt-6-luna`. The native tool-calling protocol is designed but not built | architecture §6.6 | B | Decided by ADR-056 measurements, not now |

What is already strong, and stays:

- Hybrid dense + Arabic-normalised lexical search, RRF, cross-encoder rerank, and per-stage scores in
  the trace.
- Docling parsing, structure-aware chunks with tables kept whole, and versioned indexes.
- A durable step engine with RLS, a sandbox, and egress for every tenant URL.
- Prompt layout that is ready for caching, and untrusted content kept in user-role data blocks.

This is the shape the production stack reference recommends ("Postgres-first", "own the pipeline").

## 4. Decisions this review recommends

1. **Keep our own engine. Do not adopt LangChain, LangGraph or Deep Agents.** Every capability they
   would add exists in `packages/engine`, `packages/autonomy` and `packages/retrieval`: the loop,
   durable steps, checkpoints, tools, retrieval and tracing. None of the A-rows above is caused by
   orchestration. PydanticAI, the stack skill's default, is Python and does not fit a TypeScript
   engine.
2. **Stay single-agent per node.** OpenAI's guide and the stack skill agree: split into more agents
   only when instructions or tool choice measurably break down. Our workflows already handle the
   deterministic branches.
3. **Measure before tuning.** No AI-layer change merges without a before/after run on the gates in
   ADR-056. This is the strict condition Eyad asked for, written so a reviewer can check it.
4. **Strongest model first, then step down.** Majed's next measured run uses the strongest model
   available in the registry. Smaller models are adopted only where they keep the gate.

## 5. The quality bar (summary of ADR-056)

These are proposed thresholds. Eyad sets the final numbers when accepting ADR-056.

| Gate | Measure | Proposed bar |
|---|---|---|
| G0 Baseline | Every suite run first on the strongest available model | Recorded before any smaller model is chosen |
| G1 Retrieval | recall@5 and MRR on the synthetic sets **and** a realistic set (long pages, tables, follow-ups); every dialect slice | recall@5 ≥ 0.90 per slice on the realistic set; no slice drops more than 2 points |
| G2 Grounding | Share of factual answers that cite a passage; judged faithfulness; correct "I don't know" on unanswerable questions | ≥ 95% cited; faithfulness ≥ 0.95; ≥ 90% correct refusals |
| G3 Protocol | Adherence corpus, protocol-valid | ≥ 98% (architecture §6.6, unchanged) |
| G4 Task success | Each bot's acceptance suite | 100% of cases marked critical; ≥ 90% overall |
| G5 Latency | Time to the first message and to the full reply, p50 and p95, for a turn with one search | First message p50 ≤ 3 s, p95 ≤ 8 s |
| G6 Cost | Cost per reply, on the same report as quality | An increase > 20% needs written approval |
| G7 Judge | LLM judge agreement with human labels on the same cases | ≥ 90% on ≥ 50 labelled cases before its scores count |

## 6. Order of work

Steps 1–4 are bug fixes, or implement what the architecture already says. They need no ADR. Every
other step waits for its ADR.

| # | Work | Needs | Why this order |
|---|---|---|---|
| 1 | Merge PR #141 (whole passages) | review | Already done; unblocks honest measurement |
| 2 | Fix the eval judge token limit | bug fix PR | Without it no acceptance suite can be trusted |
| 3 | Anthropic cache breakpoints on the system prefix | implements §6.4 | Makes Claude affordable to measure |
| 4 | Majed suite on `gpt-6.1-sol` and Claude Sonnet, alongside `gpt-6-luna` | credits on the Anthropic account | Gate G0. Separates the model's share of the problem from the platform's |
| 5 | ADR-056 gates and the realistic golden set | ADR-056 | Every later change is judged by it |
| 6 | ADR-055 automatic search | ADR-055 | Largest expected gain (row 1) |
| 7 | ADR-057 playbooks | ADR-057 | Gets Majed's lost 17,000 characters of behaviour back |
| 8 | ADR-058 reasoning effort | ADR-058 | Latency (row 9) |
| 9 | ADR-059 neighbour expansion, contextual headers, embedding bake-off | ADR-059 | Rows 10–12; measured by the realistic set |
| 10 | ADR-060 web search and URL fetch tools | ADR-060 | Secondary, per Eyad |
| 11 | Native tool-calling protocol | a new ADR, only if G3 still fails on the chosen model | Row 15 |

## 7. Open questions for Eyad

1. Which bars in §5 do you want to change before ADR-056 is accepted?
2. Can the Anthropic account be topped up so Claude can be measured (step 4)?
3. Can Engosoft's KB be used for a private, git-ignored realistic golden set, like the Majed
   suite? CLAUDE.md bans real customer data in fixtures. Course pages are company content, not
   customer data, but the set would stay out of the repository either way.
