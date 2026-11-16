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
| OpenAI GPT-6 models reject `temperature` and `stop`; every call failed as `model_unavailable` | Fixed in PR #133 (registry capabilities) |
| Validation rejected `user.attributes`, which architecture §4.5 documents as a built-in | Fixed in this branch |
| No Chatwoot adapter | PR #134 (task 14.2) |
| Bot code cannot read the stored user's name and email, only `user.attributes` | Worked around in the adapter (adds `contactName`, `contactEmail`, `contactPhone`) |
| Knowledge bases and model keys cannot be managed with an API key; only a signed-in member can | Noted; the pilot used the Studio session for those steps |
| Majed's 32 K prompt does not fit the 16 K instructions limit | Worked around by moving reference sections to the KB. Behaviour on those sections now depends on retrieval |
| Full adherence report for `gpt-6-luna` | 38/38 protocol-valid before the provider key was revoked mid-run; the 240-case run is still to do |
| Pilot eval suite (acceptance: "passes its eval suite") | Not written yet |

## Deployment record

- Workspace `test`, bot `bot_01m7gxs7wjzrj9yeyv9prz5fvk`, knowledge base `kb_01m7gxtgpqh1ytwf9t49xyf1ww`.
- Chatwoot: a new agent bot on the **test** web widget inbox (18) only. Live inboxes and the Botpress
  agent bot are untouched.
