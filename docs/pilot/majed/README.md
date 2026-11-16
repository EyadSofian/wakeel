# Pilot: Majed (Engosoft) from Botpress

Build-plan task 15.6. Majed is Engosoft's course advisor and sales assistant. Its Botpress export
(`Majed - 2026 Nov 16.bpz`) was rebuilt on the platform on 2026-11-16.

The prompt and the knowledge-base files are Engosoft's content and stay out of this public repository:
they live in `docs/pilot/majed/private/` (git-ignored). `tools/pilot/build-majed.ts` builds the bot
export from them.

## Mapping

| Botpress | Platform |
|---|---|
| One Autonomous Node, 31,924-character prompt | Autonomous Node `Majed`. Instructions cut to 14,955 characters (limit 16,000). Moved to the knowledge base, word for word: package contents, offer scripts, attendance paths, objections, installment troubleshooting, website help (`majed_policies.md`) |
| KB `kb-default`, 4 Markdown files | Knowledge base `Engosoft` with the same 4 files plus `majed_policies.md`, `openai:text-embedding-3-large` |
| "Search Knowledge Bases" tool, Web Search tool | `searchKnowledge` (kb_search). No web search: the prompt only allowed links from the KB anyway |
| Transitions + Execute Code to n8n for notes, quiz email, calendar | Code tools `saveNotes`, `emailQuizResult`, `createCalendarEvent` (same n8n webhooks, base URL in config var `N8N_WEBHOOK_BASE`). The model calls them and keeps talking; no extra nodes |
| Complaint and sales transitions → Execute Code calling the Chatwoot API with a token in the code | Exits `salesHandoff` and `supportHandoff`, each with a schema (`summary`, `courseName`) → Handoff card. The Chatwoot adapter adds the private note, opens the conversation, assigns the team and labels it. No token in the bot |
| `preloadUserData` reading `event.payload.userData` | Code card `Read user data` reading `user.attributes` (Chatwoot contact custom attributes, plus the contact's name, email and phone from the adapter) |
| Timeout flow (3 min) + n8n `majed-timeout-handoff` | Inactivity trigger (15 min): the same follow-up messages, keyed on `pendingAction`, and the same n8n notification |
| Policy agent (competitors) | A rule in the instructions |
| Gemini 3.5 Flash | `openai:gpt-6-luna` (default and utility) |

## Botpress defects fixed in the move

1. The prompt relied on six variables that did not exist: `pendingAction` (its highest-priority
   continuity rule), `isEnrolled` (advisor vs closer; the preload set `isLoggedIn` instead),
   `userCourses`, `notesText`, `quizIndex`, `quizTotal`. All are declared now, and the node can write
   them.
2. The timeout flow read `lastAction` while the prompt wrote `pendingAction`, so the follow-up message
   was always the generic one.
3. The node called `sendPrivateNote` never sent a private note: it repeated the assign/open calls, so
   agents never saw the summary. The adapter now posts it.
4. The Chatwoot API token (an administrator token) was written in two Execute Code cards. **Rotate it**:
   anyone with the .bpz has it.
5. A catch-all transition ("When conditions are met, EXECUTE the transition") could fire into the quiz
   e-mail node at any time. Removed.
6. Two complaint e-mail nodes and a video node were not connected. Dropped.

## Gaps found on the platform

| Gap | Status |
|---|---|
| OpenAI GPT-6 models reject `temperature` and `stop`; every call failed as `model_unavailable` | Fixed (#133) |
| Validation rejected `user.attributes`, which architecture §4.5 documents as a built-in | Fixed (#135) |
| No Chatwoot adapter | Built (#134, task 14.2), running on Railway |
| Every KB embed failed (`provider:id` passed to the registry), and a failed stage could never re-run | Fixed (#137) |
| Choice options written as plain strings (10/24 in the adherence corpus) | Prompt guidance added (#136); not re-measured |
| **Inactivity trigger fires every 30 s** while its path leaves the conversation waiting: `expires_at` is not moved, so the janitor re-runs it. Majed sent its follow-up and called the n8n `majed-timeout-handoff` webhook about 28 times for two test conversations before the fix | **Open, platform bug.** Majed now ends the conversation after the follow-up (as Botpress did). Fix in the worker: after a timeout run, move `expires_at` or end the conversation |
| **Evaluations block every Code card**, even ones with no network access (`eval_side_effect_blocked`) | Open (ADR-053 behaviour). Majed loads website data with Set variable cards so its suite can run |
| **Eval `judge` assertions fail on reasoning models**: `maxOutputTokens: 16` is used up before PASS/FAIL | **Open, platform bug** (`apps/worker/src/eval/run.ts`). 3 of 13 Majed cases end as `eval_assertion_unavailable` |
| Knowledge-base search needs a rerank model, the TEI key and a reranker reachable through egress (no private hosts) | Set up: reranker got a public Railway domain (API-key protected); TEI base URL and key in Settings → Models → Rerank server |
| Railway did not deploy `main` after CI passed | api, worker and studio were deployed with `railway up` from `main`; check the services' GitHub auto-deploy setting |
| Bot code cannot read the stored user's name and email, only `user.attributes` | Worked around in the adapter (adds `contactName`, `contactEmail`, `contactPhone`) |
| Knowledge bases, model keys and connections cannot be managed with an API key; only a signed-in member can | Noted |
| Majed's 32 K prompt does not fit the 16 K instructions limit | Reference sections moved to the KB; behaviour on them depends on retrieval |

## Results

- **Adherence corpus, `gpt-6-luna`:** 221/240 protocol-valid (92%), below the 98% gate. See `packages/autonomy/evals/reports/`.
- **Majed acceptance suite** (13 cases, in the workspace as "Majed acceptance"), draft of 2026-11-16: 8 passed. Failed: the HVAC case (the model did not search on the first message). Errors: 3 judge assertions unavailable (bug above), 1 turn failed (competitor question, not yet investigated). **The acceptance criterion is not met yet.**
- **Live test through Chatwoot:** greeting with buttons, button pick as a postback, and an HVAC question that returned the real course page from the KB with the instructor's name. Replies take 4–30 s.

## Deployment (production, 2026-11-16)

| What | Where |
|---|---|
| Studio | https://studio-production-487a9416.up.railway.app, workspace `test` |
| Bot | `bot_01m7gxs7wjzrj9yeyv9prz5fvk`, published version 6 ("Majed pilot v5"), model `openai:gpt-6-luna` |
| Knowledge base | `kb_01m7gxtgpqh1ytwf9t49xyf1ww`, 5 documents, about 37 K tokens |
| Bridge connection | `conn_01m7gy1y2yb8t2qmn5jwgd0s4a`, target production, webhook to the adapter |
| Adapter | Railway service `adapter-chatwoot`, https://adapter-chatwoot-production.up.railway.app, Redis store, pair config in `ADAPTER_PAIRS` |
| Chatwoot | Agent bot 8 "Majed (Wakeel)" on the **test** web widget inbox (18) only. Live inboxes and the Botpress agent bot (6) are untouched. Handoffs go to team 2 |
| Reranker | Railway service `reranker`, public domain https://reranker-production-595bf139.up.railway.app (requires its API key) |

## Handoff

1. **Private files.** The prompt (`instructions.md`), the five KB files, the eval cases and the built export are not in this repository. Ask Eyad for `docs/pilot/majed/private/` and put it at that path; it is git-ignored. `pnpm tsx tools/pilot/build-majed.ts --kb <kb id>` rebuilds the export from it.
2. **Changing the prompt.** Edit `private/instructions.md` (limit 16,000 characters), update the Main workflow's Autonomous Node, then publish: in the Studio, or `PUT …/bots/<bot>/docs/workflow/<wf>` with `If-Match`, then `POST …/bots/<bot>/versions`.
3. **Credentials to rotate.** The OpenAI key and the Chatwoot administrator token were pasted into a chat. The administrator token was also hard-coded in the Botpress bot. The adapter uses the agent bot's own token, so the administrator token is no longer needed. The workspace API key `majed-pilot` was created for this migration; revoke it when it is no longer used.
4. **Before live traffic:** fix the inactivity bug, get the acceptance suite green, decide `gpt-6-luna` vs `gpt-6.1-sol` on quality and cost, and close the production gaps in `docs/runbooks/releases/2026-11-15-phase-12.md` (sandbox isolation, backups). Then move agent bot 8 to a live inbox and take the Botpress bot off it, never both on one inbox.
5. **n8n:** the test conversations above sent repeated `majed-timeout-handoff` calls with synthetic names ("fragrant-haze-764", "زائر"). Check the n8n workflow for test leads to delete.
