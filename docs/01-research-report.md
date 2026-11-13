# 01 — Research report

Status: complete for the design phase. Retrieved 2026-11-13.
Audience: the executor model and Eyad. Read this before `02-product-thesis.md`.

## 0. How to read this report

Every factual claim carries a marker:

- **[V]** Verified. Seen in source code or official docs on the retrieval date. A URL follows.
- **[I]** Inferred. A conclusion drawn from verified facts, from product behaviour, or from prior knowledge that was not re-checked in source this session. Treat as a hypothesis.
- **[E]** Eyad's production experience (from his Botpress Cloud skill notes: Majed, Fahad, Sayeq, HR-in-a-Box). First-hand, not independently verified.

Source pins (shallow clones, commit and commit date):

| Repo | Commit | Date | License (verified in repo) |
|---|---|---|---|
| botpress/botpress | `0658a90` | 2026-11-11 | MIT at root; `llmz`, `zai`, `vai` declare `ISC` in package.json; no per-package LICENSE file |
| botpress/v12 | `179cb69` | 2025-04-07 | AGPL-3.0 |
| FlowiseAI/Flowise | `9291856` | 2026-08-13 | Apache-2.0, except `packages/server/src/enterprise` (commercial) |
| langflow-ai/langflow | `2cf9ce8` | 2026-11-11 | MIT |
| langgenius/dify | `7967f4e2` | 2026-11-13 | Modified Apache-2.0 (no multi-tenant use, no logo removal) |
| baptisteArno/typebot.io | `532c83e` | 2026-11 | FSL-1.1-Apache-2.0 |
| RasaHQ/rasa | `60a3cff` | 2025-12-18 | Apache-2.0 (maintenance mode; CALM is not in this repo) |
| Hexastack/Hexabot | `5ef8b0a` | 2026-11-12 | FCL-1.0-ALv2 (Fair Core License) |
| emcie-co/parlant | `a754b1b` | 2026-11-12 | Apache-2.0 |
| langbot-app/LangBot | `4625b57` | 2026-11-13 | Apache-2.0 |
| n8n-io/n8n | `f0828362` | 2026-11 | Sustainable Use License; `.ee` files separately licensed |
| xyflow/xyflow | `1bc405c` | 2026-11-02 | MIT |

URL convention: `gh:<org>/<repo>@<sha>:<path>` expands to `https://github.com/<org>/<repo>/blob/<sha>/<path>`.

---

## 1. Botpress (primary reference)

### 1.1 What is and is not open

- **[V]** The MIT monorepo contains `packages/{llmz,zai,sdk,client,cognitive,cli,chat-api,chat-client,vai,zui,common,sdk-addons}`, 83 integrations, `interfaces/`, `plugins/` and example `bots/`. It does **not** contain Studio, the cloud runtime, the Tables service, the Files/KB indexing service or the dialog engine that runs Studio workflows. `gh:botpress/botpress@0658a90:packages`
- **[V]** v12 is the last self-hostable runtime, AGPL-3.0, last commit April 2025. Botpress docs state v12 and all self-hosted versions are sunset. `gh:botpress/v12@179cb69:LICENSE`, https://botpress.com/docs/studio/guides/advanced/v12
- **[I]** Consequence: for Studio workflow execution, Tables and KB internals we only have docs, API surface and v12 as a conceptual ancestor. LLMz, the SDK contract and message schemas are the only parts where source is authoritative.

### 1.2 Studio data model: workflows, nodes, cards, transitions

Cloud Studio's storage format is closed. What is verifiable:

- **[V]** A node is "a single step in a conversation"; it runs its cards in order, then transitions when it finishes all cards or when a card transitions manually. https://botpress.com/docs/studio/concepts/nodes/introduction
- **[V]** Node types: Standard, Autonomous, Start (Main workflow only, no cards, selects KBs), Entry (every non-main workflow; only Expression/Intent and Log cards), Exit (returns to parent, can pass variables), End (clears session and all variables), Trigger (event-driven, cannot be transitioned into, built around one card), Exception handler (one per workflow, overrides the global Error workflow), Comment. Same URL.
- **[V]** Transitions are drawn from a node's right edge to another node's left edge. Expression cards are inline branch points: `true` follows the connected node, `false` falls through to the next card. Conditions can be written in natural language and are compiled to a JavaScript expression by an LLM at design time. https://botpress.com/docs/studio/concepts/cards/flow-logic
- **[V]** The Intent card is deprecated in favour of AI Transition. Same URL.
- **[V]** Cards are configured in a right-hand inspector; when no card is selected the right panel shows the Emulator, and the two are tabs. https://botpress.com/docs/studio/concepts/cards/introduction
- **[V]** Conceptual ancestor (v12, **concepts only, AGPL**): a `Flow` is `{ name, startNode, nodes: FlowNode[], catchAll, timeoutNode, timeout[] }`; each node has `onEnter[]`, `onReceive[]`, `next[{condition, node}]`. The per-conversation `DialogContext` is `{ currentFlow, currentNode, previousFlow, previousNode, queue, jumpPoints[], hasJumped }`. `jumpPoints` is the sub-flow call stack. `gh:botpress/v12@179cb69:packages/bp/src/sdk/botpress.d.ts`
- **[I]** Cloud Studio most likely keeps the same shape (nodes with ordered instructions, an instruction queue, a jump-point stack) with cards replacing `onEnter` actions and Autonomous Nodes delegating to LLMz.

### 1.3 Runtime execution across turns

- **[V]** v12 (concepts only): `DialogEngine.processEvent(sessionId, event)` builds an instruction queue for the current node, executes instructions until one waits for user input, then persists the context. A janitor job processes session timeouts under a distributed lock, jumps to the flow's `timeoutNode`, and has infinite-loop detection on the jump-point stack. `gh:botpress/v12@179cb69:packages/bp/src/core/dialog/dialog-engine.ts`, `.../janitor.ts`
- **[V]** Cloud: an inactivity timeout exists per conversation and can be changed by a card (minutes; `0` never expires, `-1` resets to default). https://botpress.com/docs/studio/concepts/cards/set-inactivity-timeout
- **[V]** Cloud: End node clears the session and erases variables and user data. https://botpress.com/docs/studio/concepts/nodes/introduction
- **[V]** Retention: logs 30 days; conversations, messages and events 90 days; files indefinite. https://botpress.com/docs/studio/guides/advanced/retention-period
- **[E]** Conversation state is capped at 131 KB. Exceeding it produces slow state swaps, stale data and silent dropouts.
- **[E]** Sub-workflow `workflow.*` writes do not reliably propagate to the parent even with the Exit-node toggle; teams fall back to `conversation.*`.
- **[E]** Typed `Object` variables sometimes round-trip as the string `"[object Object]"`.

### 1.4 LLMz — exactly how it works (source-verified)

Package: `llmz@0.9.19`, declared license `ISC`, no LICENSE file in the package directory. Peer dependencies: `@botpress/client`, `@botpress/cognitive`, `@bpinternal/zui`, `@bpinternal/thicktoken`. `gh:botpress/botpress@0658a90:packages/llmz/package.json` **[V]**

**Important: the in-repo docs are stale.** `packages/llmz/CLAUDE.md` still describes `isolated-vm`, Babel and a "yield JSX" response format. The code has moved on. Trust the source below. **[V]**

1. **Loop.** `executeContext()` iterates until an exit is returned, the agent listens (chat mode), or the iteration cap is hit (`LoopExceededError`). Default `loop = 3`, default `temperature = 0.7`. `gh:botpress/botpress@0658a90:packages/llmz/src/runtime/execute.ts`, `.../src/context.ts` (lines 1166–1167) **[V]**
2. **Iteration statuses.** `pending`, `generation_error`, `invalid_code_error`, `execution_error`, `thinking_requested`, `callback_requested`, `exit_success`, `exit_error`, `aborted`. Error statuses feed the error back to the model on the next iteration; that is the retry mechanism. `.../src/context.ts` **[V]**
3. **Two modes.** Chat mode (a `chat` object is supplied; messages can be sent; `listen` exit is available) and worker mode (no chat; runs to a result). Separate prompt sets under `src/prompts/chat-mode` and `src/prompts/worker-mode`. **[V]**
4. **Response protocol (current).** The model no longer returns one TSX program. It returns a sequence of line-oriented blocks delimited by the rare single-token character `■`:
   - `■start` / `■end` wrap the response.
   - `■send=<component> {props}` followed by a body sends one message **immediately** (streamed to the user before any code runs).
   - `■run` followed by plain JavaScript runs in the VM. At most one per response. If the code `return`s a value, the model gets another turn with that value and any `■next` is ignored.
   - `■next=<exit> {json}` ends the turn through a named exit (`listen` is the chat-mode default).
   - Messages must be final text: no interpolation, no placeholders. Sends must precede the run block.
   `gh:botpress/botpress@0658a90:packages/llmz/src/prompts/chat-mode/system.md`, `.../chat-mode/protocol.ts`, `.../protocol-basics.ts` **[V]**
5. **Prompt structure (chat mode).** Part 1 response format and protocol reference; Part 2 VM rules and `tools.d.ts` (TypeScript declarations generated from tool schemas; the model writes JavaScript, the typings are documentation); Part 3 identity and instructions ("trust fully"); Part 4 transcript; Part 5 security guidelines; then a closing recap listing valid tool names, readonly and writable variables, and format reminders. Same `system.md`. **[V]**
6. **VM rules stated to the model.** No `import`/`require`, no timers, no `console.log` (return values instead), no function declarations, top-level `await`, readonly variables throw on write. Same file. **[V]**
7. **Compilation.** Generated code is transformed with `acorn` + `magic-string` plugins: async wrapper, return handling, line tracking (source maps for stack traces), tool-call tracking, variable extraction, comment replacement. `.../src/compiler/plugins/*` **[V]**
8. **Sandbox.** QuickJS compiled to WASM (`quickjs-emscripten-core`), fresh runtime per execution, `setMemoryLimit(128 MB)`, interrupt handler for a deadline (default `MAX_VM_EXECUTION_TIME = 60_000 ms`). Host tools are bridged as functions; promises are pumped by a host loop. `.../src/vm/drivers/quickjs.ts`, `.../src/vm/index.ts` **[V]**
9. **Sandbox fallback is unsafe.** If the QuickJS WASM fails to load, LLMz logs a warning and falls back to an **unsandboxed Node driver** that runs code via `AsyncFunction`. On Cloudflare Workers it throws instead. `.../src/vm/index.ts` lines 80–110, `.../src/vm/drivers/node.ts` **[V]**. This is acceptable for a library, not for a multi-tenant host.
10. **Signals.** `ThinkSignal` (thrown by a tool or hook to force a reflection iteration), `SnapshotSignal` (thrown from a tool to pause; produces a `Snapshot { id, reason, stack, variables[], toolCall, status }`), `LoopExceededError`, `CognitiveError`. A snapshot is **not** a VM heap image: it stores tracked variables (each truncated above ~4 KB with a preview), the stack string and the pending tool call, and resumes by resolving or rejecting that tool call. `.../src/snapshots.ts`, `.../src/errors.ts` **[V]**
11. **Hooks.** `onTrace`, `onIterationStart`, `onIterationEnd`, `onBeforeExecution` (can mutate code), `onBeforeTool`, `onAfterTool`, `onExit` (validate exits, guardrails). `.../src/runtime/execute.ts` **[V]**
12. **Exits.** Typed (Zui schema) named terminations. Built-ins: listen, think, default. In Studio, an Autonomous Node's connected transitions and sub-workflows surface as tools `workflow.transition` and `global.<workflowName>`. `.../src/exit.ts`, https://botpress.com/docs/studio/concepts/nodes/autonomous-node **[V]**
13. **Components.** Default chat components: `Button`, `Image`, `File`, `Video`, `Audio`, `Card`, `Carousel`, `Message`, `Speech`. `.../src/component.default.ts` **[V]**
14. **Citations.** A `CitationsManager` assigns numeric ids to sources and uses rare single-token markers (`【` `】`) in model-visible text, then rewrites or strips them on output. `.../src/citations.ts` **[V]**
15. **Stop sequences and pre-warm.** Generation uses protocol stop tokens; the VM is pre-warmed as soon as the stream opens a `■run` block. `.../src/runtime/generate.ts`, `.../src/vm/index.ts` **[V]**
16. **Transcript budget.** A truncator trims the transcript and tool outputs to the model's context window; a code comment admits history still grows with many iterations. `.../src/context.ts` line 907, `.../src/truncator.ts` **[V]**
17. **Studio surface.** Autonomous Node config: Instructions, Variables (explicit read access; separate write toggle), Tools, Search Knowledge, Workflows, Exit Conditions, "Loops until exit condition" (off makes it non-conversational), model and RAG-model overrides, Vision. Built-in tools every bot has: `global.think`, `global.search`, `clock.setReminder`, `global.Message`. Inspect window shows Tools and Iterations. Docs recommend a GPT-4.1-class model because weaker models "truncate the definition wrapper". https://botpress.com/docs/studio/concepts/nodes/autonomous-node **[V]**

Why Botpress moved from "one TSX program" to `■` blocks **[I]**: (a) most turns are a plain reply, so forcing code generation for every turn wastes tokens and latency; (b) messages can stream to the user before tools run; (c) JSX and TypeScript syntax errors were a common failure with weaker models; (d) at most one run block per response makes the loop observable and bounded.

### 1.5 Execute Code

- **[V]** Runs JavaScript inside a node. No external libraries; `axios` is provided for HTTP. Secrets come from configuration variables via `env`. AI can generate the code from a prompt in the editor. https://botpress.com/docs/studio/concepts/cards/execute-code
- **[E]** Outbound HTTP from Execute Code is blocked on the free tier (`axios is not defined`).
- **[E]** The editor's TypeScript types do not know dynamic fields (`user.data`, undeclared workflow variables), so production code is full of `as any`.
- **[I]** The cloud sandbox for Execute Code is not public. Given LLMz's driver history it is isolated-vm or QuickJS in a per-request isolate.

### 1.6 Knowledge Bases

- **[V]** Sources: websites (root-domain discovery or specific pages, scheduled re-crawl), documents (`.pdf .html .txt .doc .docx .md`), tables (searchable columns), live web search (site and recency filters), rich text, integration-provided sources. Documents are managed through the Files API. https://botpress.com/docs/studio/concepts/knowledge-base/add-sources
- **[V]** In an Autonomous Node each "Search Knowledge" card is a separate tool; with several cards the model picks by each card's Instructions field, and "will pick one randomly" without them. Searching all KBs at once costs more tokens and latency. Logs show the exact KB query and results with token counts. https://botpress.com/docs/studio/concepts/knowledge-base/introduction
- **[V]** The public `knowledge` plugin calls `client.searchFiles(...)` and receives `passages`; retrieval itself runs in the closed cloud. `gh:botpress/botpress@0658a90:plugins/knowledge/src/index.ts`
- **[V]** ADK: a `Knowledge` object has a name, a description (used by the model to choose a KB) and data sources (`DataSource.Website.fromSitemap` with `filter`, `maxPages`, `maxDepth`; local directories). https://botpress.com/docs/adk-v2/data/knowledge
- **[I]** Chunking strategy, embedding model, hybrid search and reranking are not documented or exposed. Users cannot inspect chunks, tune retrieval or see why a passage ranked. Nothing in docs addresses Arabic normalisation.

### 1.7 Tables

- **[V]** Free plan: 10 tables, 20 columns (hard limit on every plan), 10,000 rows. A "row factor" multiplies the 4 KB per-row limit and the row's quota weight. Columns can be marked Searchable (indexed for natural-language search). API: list/create/update/delete table, create/find/update/upsert/delete rows, filters with logical operators and rule groups, projection and aggregation. Operations are available from the UI, cards, the client and code. https://botpress.com/docs/studio/concepts/tables

### 1.8 Integration SDK contract

- **[V]** An integration definition declares configuration, channels (each with message types), actions (typed input/output), events, states, entities and user/conversation tags; interfaces (`hitl`, `llm`, `typing-indicator`, `proactive-conversation`, `files-readonly`, …) are implementable contracts. `gh:botpress/botpress@0658a90:packages/sdk/src`, `.../interfaces`
- **[V]** Default message schemas: `text{text}`, `image{imageUrl,title?}`, `audio`, `video`, `file{fileUrl,title?}`, `location{latitude,longitude,address?,title?}`, `card{title,subtitle?,imageUrl?,actions[{action:'postback'|'url'|'say',label,value}]}`, `carousel{items:card[]}`, `choice{text,options[{label,value}]}`, `dropdown` (same shape as choice), `bloc{items[]}`. All strings are non-empty. `gh:botpress/botpress@0658a90:packages/sdk/src/message.ts`
- **[E]** A `choice` with empty `text` crashes the bot silently. The schema above explains why (`NonEmptyString`), but the failure is not surfaced to the builder.
- **[I]** We do not need the integration SDK (channels are out of scope). We adopt the message vocabulary so bridges and Botpress-experienced builders see familiar shapes.

### 1.9 Versions, emulator, observability, evals

- **[V]** Versions are created manually or on every publish; reverting overwrites the current bot; PAYG keeps 3 versions, Team keeps 15. https://botpress.com/docs/studio/concepts/versions
- **[V]** ADK evals: `.eval.ts` files with a `conversation` of turns (`user`, `event`, `expectSilence`, `newConversation`) and assertions on `response` (`contains`, `not_contains`, `matches`, `llm_judge`) and `tools` (`called` with param matchers, `not_called`, `call_order`). https://botpress.com/docs/adk-v2/testing/evals
- **[I]** Evals are an ADK (code-first) feature; Studio builders do not get a visual eval runner.

### 1.10 Pricing and commercial model (changed 2026-05-14)

- **[V]** Conversation-based pricing: Free 100 conversations; Plus $150/mo annual ($189 monthly) with 250 conversations, extra packs $65 per 100; Team $750/mo annual ($939 monthly) with 1,500 conversations, packs $50 per 100. Each conversation includes $0.10 of AI usage. Packs auto-purchase at 95% of quota and **cannot be turned off**. A conversation is any exchange with at least two end-user messages in the month. **Emulator conversations count.** Storage add-on $40/mo. https://botpress.com/pricing, https://sitegpt.ai/blog/botpress-ai-review, https://theaiagentindex.com/agents/botpress
- **[V]** Positioning has moved to "AI-native customer support platform" centred on Botpress Desk. https://theaiagentindex.com/agents/botpress
- **[V]** Human handoff starts on Plus; RBAC, teams and routing on Team. https://sitegpt.ai/blog/botpress-ai-review

### 1.11 Biggest user complaints we can fix

| # | Complaint | Evidence | Our fix (designed in 03/05) |
|---|---|---|---|
| 1 | Cost is high and unpredictable for MENA budgets; testing burns paid quota; overage cannot be capped | [V] pricing page | Emulator and eval runs are never billed as conversations; hard caps a tenant can set; BYO model keys |
| 2 | Cloud-only, no data residency choice | [V] v12 sunset; rasa.com/blog/rasa-vs-botpress; ibl.ai comparison | Single-binary-style Docker deployment; region choice; dedicated instance tier |
| 3 | Steep learning curve | [V] Capterra quote via sitegpt review | Fewer concepts, plain names, inline validation, errors that say how to fix |
| 4 | LLM writes to variables unreliably | [E] | Variable writes go through schema-validated assignment tracked by the sandbox; failures are surfaced to the model and in the trace |
| 5 | Sub-workflow variables do not come back | [E]; docs need a whole guide for it | Workflows have declared inputs and outputs, like functions |
| 6 | Silent failures (empty choice text, old template syntax, missing variable access) | [E] | Design-time validation blocks publish; runtime errors appear in the emulator with a fix hint |
| 7 | `as any` everywhere in Execute Code | [E] | Editor typings generated from the bot's real variable and table schemas |
| 8 | 131 KB state cap with opaque symptoms | [E] | 256 KB cap, a live size meter per variable, explicit `state_too_large` error |
| 9 | KB is a black box; weak on Arabic | [I] | Chunk inspector, retrieval playground, hybrid search with Arabic normalisation, per-KB eval set |
| 10 | Bridges are improvised (Trigger card + custom server, UA-string "security", handoff flags reset by hand) | [E] | First-class Bridge API with signed webhooks, ordered delivery, explicit handoff request and release |
| 11 | Webchat config URL changes on publish | [E] | Not applicable (no webchat); bot ids and bridge credentials are stable across versions |
| 12 | Version history is shallow (3 or 15) | [V] | Unlimited immutable versions with diff and one-click rollback |
| 13 | Autonomous Node is hard to debug beyond "Iterations" | [V] docs | Step-by-step trace playback: prompt, generated code, tool calls, tokens, latency |
| 14 | Built-in tools the model misuses (`clock.setReminder`) cannot be removed | [E] | No implicit tools. Every tool the model sees is listed on the node and removable |

---

## 2. Open-source competitors

### 2.1 Flowise (Apache-2.0 core, commercial `enterprise/`)

- **Flow data model [V]**: a `ChatFlow` row stores the whole canvas as one `flowData` text column (React Flow nodes and edges) plus JSON-in-text config columns; `type` distinguishes chatflow / agentflow; `workspaceId` scopes it. `gh:FlowiseAI/Flowise@9291856:packages/server/src/database/entities/ChatFlow.ts`
- **Execution [V]**: `buildChatflow.ts` and `buildAgentflow.ts` walk the graph; BullMQ-style queues (`PredictionQueue`, `UpsertQueue`, `ScheduleQueue`) with Redis pub/sub for streaming events; an `Execution` entity persists agentflow runs for resume. `.../packages/server/src/utils`, `.../src/queue`, `.../database/entities/Execution.ts`
- **Code sandbox [V]**: `executeJavaScriptCode` uses E2B cloud sandboxes when `E2B_APIKEY` is set, otherwise `NodeVM` from `vm2` with an allow-list of modules. `.../packages/components/src/utils.ts` lines 1588–1810. vm2 is a discontinued library with a history of escapes **[I]**.
- **RAG [V]**: Document Store entities with chunk rows, an upsert history, many vector-store nodes. `.../database/entities/DocumentStore*.ts`
- **Multi-tenancy [V]**: organisation, workspace, role and SSO entities live in the commercial `enterprise` directory. Isolation is an application-level `workspaceId` filter. `.../packages/server/src/enterprise/database/entities`
- **Plugin model [V]**: nodes are classes in `packages/components/nodes/*` loaded into a `NodesPool`.
- **Canvas [I]**: React Flow; every LangChain primitive is its own node, so real flows become large wiring diagrams.
- **Also [V]**: datasets, evaluators and evaluation runs are first-class entities. `.../database/entities/Evaluation*.ts`, `Dataset*.ts`

### 2.2 Langflow (MIT)

- **Flow data model [V]**: `flow` table with a JSON document; `flow_version`, `folder`, `variable`, `knowledge_base`, `traces`, `vertex_builds` models. `gh:langflow-ai/langflow@2cf9ce8:src/backend/base/langflow/services/database/models`
- **Execution [V]**: a graph of vertices and edges with checkpointing and per-vertex build state; the executor core is the `lfx` package. `.../src/lfx/src/lfx/graph`
- **Code "sandbox" [V]**: custom components are Python source compiled and run with `compile()` / `exec()` in the server process. `.../src/lfx/src/lfx/custom/validate.py`. There is no isolation boundary; this is acceptable only for single-tenant self-hosting.
- **Multi-tenancy [I]**: users and folders, not hard tenants.
- **Canvas [I]**: every component shows its source; per-node "run this component" with output inspection is its best UX idea.

### 2.3 Dify (modified Apache-2.0 — concepts only)

- **License [V]**: commercial licence required to run a multi-tenant service or to remove the logo; the licence also asserts an appearance patent on the interaction design. `gh:langgenius/dify@7967f4e2:LICENSE`. **We copy nothing, including layout.**
- **Flow model and engine [V]**: workflow graph with typed nodes (LLM, knowledge retrieval, agent, human input, triggers), a variable pool with scoped prefixes (system, environment, conversation), node execution records. `.../api/core/workflow`
- **Code sandbox [V]**: a separate `langgenius/dify-sandbox` service container; outbound HTTP goes through an SSRF proxy. `.../docker/docker-compose.yaml`
- **RAG [V]**: extractor → cleaner → splitter → index processor; keyword and vector datasources behind a factory; rerank; retrieval methods include hybrid; parent/child and summary indexes. `.../api/core/rag`
- **Multi-tenancy [V]**: `tenants` and `tenant_account_joins` tables with roles; tenant id is an application-level filter. `.../api/models/account.py`
- **Plugin model [V]**: out-of-process plugins with install and debug permissions per tenant.

### 2.4 Typebot (FSL-1.1 — concepts only)

- **Flow model [V]**: a typebot is `{ version, groups[], edges[], variables[], events[] }`; groups contain ordered blocks; the schema is a versioned discriminated union with migrations. `gh:baptisteArno/typebot.io@532c83e:packages/typebot/src/schemas/typebot.ts`
- **Execution [V]**: `startSession` / `continueBotFlow` / `walkFlowForward` walk forward until an input block, persist session state, and record `visitedEdges` for analytics. `.../packages/bot-engine/src`
- **Code sandbox [V]**: `isolated-vm` with an isolate from a session store, a bridged `fetch` through a safe dispatcher (SSRF protection, redirect cap), and a default timeout. `.../packages/variables/src/executeFunction.ts`
- **Multi-tenancy [I]**: workspaces with members and plans; application-level scoping via Prisma.
- **Canvas [I]**: groups-of-blocks is the closest public analogue to Botpress nodes-of-cards. The preview drawer that runs the flow beside the canvas, and drop-off analytics drawn on edges, are its best ideas.

### 2.5 Rasa OSS and CALM

- **[V]** Rasa Open Source is in maintenance mode at 3.6.x. The repo has no `dialogue_understanding` or flows package: **CALM is not open source**; it ships in Rasa Pro / Hello Rasa. `gh:RasaHQ/rasa@60a3cff:README.md`, `.../rasa`
- **CALM concepts [V, docs]**: business logic is a set of YAML flows; each flow has a required `description` used by the LLM to route; steps collect slots, call actions, branch and link. The LLM does not pick the next step: it emits commands that the dialogue manager executes against the flow. Conversation patterns handle corrections, digressions and cancellations. Slots reset when a flow ends unless listed in `persisted_slots`. https://rasa.com/docs/reference/primitives/flows/, https://rasa.com/docs/learn/concepts/calm/
- **[I]** The valuable idea: the LLM proposes, a deterministic engine disposes. Our Autonomous Node keeps that property at the boundary: exits and variable writes are validated by the engine, never trusted.

### 2.6 Hexabot (FCL-1.0 — concepts only)

- **License [V]**: Fair Core License on every package. `gh:Hexastack/Hexabot@5ef8b0a:LICENSE.md`
- **Engine [V]**: v3 has an `agentic` package: a YAML workflow DSL with JSONata expressions, Zod-validated actions, `do` / `parallel` / `conditional` / `loop`, and durable suspension that yields a JSON checkpoint any process can resume. `.../packages/agentic/README.md`
- **[I]** Worth noting: checkpoint-as-JSON (not a heap snapshot) is the same resumption model LLMz uses. It is the right one for us.

### 2.7 Parlant (Apache-2.0)

- **Model [V]**: no flow graph. Behaviour is a set of natural-language policies (guidelines) with attached tools and canned responses; the engine recalls, prunes and ranks the rules relevant to the current turn, selects tools, then a responder (optionally constrained to canned responses) writes the reply; a reviewer checks it. `gh:emcie-co/parlant@a754b1b:src/parlant/core/engines/compass/**` (matcher, rule_recaller, rule_pruner, rule_ranker, tool_selection, responder, reviewer, canned_response_renderer, compacter)
- **Testing [V]**: simulated personas run against the agent. `.../README.md`
- **[I]** Adopt two ideas inside the Autonomous Node: (1) conditional instruction blocks that are injected only when relevant, which keeps prompts short; (2) approved-wording responses for regulated statements.

### 2.8 LangBot (Apache-2.0)

- **Model [V]**: not a flow builder. A pipeline of stages (pre-processing, content filter, rate limit, process, response rules, long-text handling) per inbound IM message; platform adapters; out-of-process plugin runtime and a "Box" runtime for sandboxed execution with admission and file policies; workspace concept; MCP server. `gh:langbot-app/LangBot@4625b57:ARCHITECTURE.md`, `.../src/langbot/pkg/{pipeline,box,plugin}`
- **[I]** Relevant only as a reference for message-pipeline stages (rate limit, content filter, aggregation of rapid consecutive user messages).

### 2.9 n8n (Sustainable Use License — canvas UX only)

- **[V]** The editor canvas is built on Vue Flow (`@vue-flow/core 1.48.0`), i.e. the xyflow lineage. `gh:n8n-io/n8n@f0828362:packages/frontend/editor-ui/package.json`
- **UX to learn from [I]**: node creator opened by `Tab` with fuzzy search; drag from a handle into empty space opens the creator pre-wired; per-node execution status and item counts on edges after a run; pinned sample data; sticky notes; "execute to here"; an executions list that reopens any past run on the canvas.

### 2.10 xyflow / React Flow (MIT)

- **[V]** `@xyflow/react 12.12.1`. Relevant props: `onlyRenderVisibleElements`, `onReconnect` + `reconnectRadius`, `connectionRadius`, `isValidConnection`, `nodeDragThreshold`, `autoPanOnNodeDrag`, `selectionOnDrag`, `panOnScroll`, `zoomOnPinch`, `snapToGrid`, `elevateNodesOnSelect`, `colorMode`, `ariaLabelConfig`, `disableKeyboardA11y`, `deleteKeyCode`, `multiSelectionKeyCode`. `gh:xyflow/xyflow@1bc405c:packages/react/src/types/component-props.ts`
- **[I]** Performance rules that matter at 300+ nodes: memoise node and edge components; keep node data referentially stable; never read the whole nodes array in a node component (use selectors); enable `onlyRenderVisibleElements`; avoid per-frame React state during pan and zoom; render a simplified node below a zoom threshold.

---

## 3. Comparison matrix

| | Botpress Cloud | Flowise | Langflow | Dify | Typebot | Rasa (CALM) | Hexabot | Parlant | LangBot |
|---|---|---|---|---|---|---|---|---|---|
| Primary unit | Workflow → node → card | Canvas of LangChain nodes | Canvas of components | Workflow / chatflow graph | Group → block | YAML flow steps | Blocks + YAML workflows | Policies, journeys | Pipeline stages |
| Conversation-first | Yes | Partly | No | Partly | Yes (forms) | Yes | Yes | Yes | Yes |
| Turn state across messages | Session, 131 KB cap [E] | Chat memory + `Execution` | Graph checkpoint | Variable pool | Session state in DB | Tracker + dialogue stack | Checkpoint JSON | Session events | Session |
| LLM orchestration | LLMz code-generation loop | Agent nodes (tool calling) | Agent components | Agent node / tool calling | AI blocks | Command generator | Agentic actions | Rule matching + responder | Runner plugins |
| Code execution | Cloud sandbox (closed) | vm2 or E2B | In-process `exec` | Separate sandbox service | isolated-vm | Action server (your infra) | Actions | Your Python process | Box runtime |
| RAG | Closed pipeline | Document stores | Components | Full pipeline, hybrid, rerank | Minimal | Enterprise search policy | Plugins | Retrievers | Knowledge engine plugins |
| Tenancy | Workspaces | Enterprise-only orgs | Users/folders | Tenants (app filter) | Workspaces | Deployment | Single | Single | Workspaces |
| Self-host | No | Yes | Yes | Yes | Yes | Pro licence | Yes | Yes | Yes |
| Evals built in | ADK only | Yes | No | Partial | No | E2E tests (Pro) | No | Persona simulation | No |
| Licence for reuse | MIT/ISC (tooling only) | Apache-2.0 core | MIT | No | No | Apache-2.0 (legacy) | No | Apache-2.0 | Apache-2.0 |

---

## 4. Steal / avoid

### Botpress
- **Steal**: workflow → node → card hierarchy; Standard vs Autonomous node split; four variable scopes; the `■`-style block protocol idea (messages stream first, at most one code block per response, typed exits); `tools.d.ts` as the tool documentation format; typed exits mapped to canvas transitions; variable access as an explicit allow-list with a separate write toggle; card-as-tool; KB-per-tool with instructions; message type vocabulary; eval assertion vocabulary; inspector/emulator sharing the right panel.
- **Avoid**: unsandboxed fallback driver; implicit built-in tools; silent schema failures; untyped variables; opaque KB; versions cap; billing test traffic; forcing every channel through a proprietary integration layer; prompt text that tells the model its instructions are "trusted fully" while passing untrusted transcript content in the same message without marking it as data.

### Flowise
- **Steal**: evaluation runs and datasets as first-class objects; queue mode with Redis pub/sub for streaming; upsert history for KB sources.
- **Avoid**: one opaque `flowData` blob (no diffs, no partial saves, no validation); vm2; exposing framework primitives as canvas nodes; gating tenancy behind an enterprise folder.

### Langflow
- **Steal**: run a single node with the last known inputs and inspect its output; per-vertex build status on the canvas.
- **Avoid**: in-process `exec` of user code; a general-purpose AI canvas with no conversation semantics.

### Dify
- **Steal (concepts only)**: separate sandbox service plus SSRF proxy as the code-execution shape; RAG pipeline stages with a retrieval-testing screen; variable pool with scoped namespaces.
- **Avoid**: any code or layout reuse; application-level-only tenant filtering.

### Typebot
- **Steal (concepts only)**: versioned definition schema with explicit migrations; bridged `fetch` through an SSRF-safe dispatcher; visited-edge analytics on the canvas; preview beside the canvas.
- **Avoid**: isolated-vm as the only boundary (maintenance mode, shares V8 with the host).

### Rasa CALM
- **Steal (concepts)**: the model proposes, the engine validates; required flow descriptions for routing; slots reset at flow end unless explicitly persisted (maps to our workflow-scoped variables and declared outputs); built-in handling of corrections and cancellations in capture steps.
- **Avoid**: a training/build step; YAML as the only authoring surface.

### Hexabot
- **Steal (concepts only)**: suspension yields a JSON checkpoint.
- **Avoid**: code reuse (FCL).

### Parlant
- **Steal**: conditional guidelines injected only when relevant; approved-wording responses; persona-driven simulation as an eval mode (later phase).
- **Avoid**: no visual model at all; many LLM calls per turn for matching (latency and cost).

### LangBot
- **Steal**: aggregation window for bursts of user messages before starting a turn; rate-limit stage ahead of the model.
- **Avoid**: service-locator application object.

### n8n
- **Steal (UX only)**: `Tab` to add; drag-to-empty opens the add menu pre-wired; run status on nodes and edges; reopen any past execution on the canvas.
- **Avoid**: code or assets (licence); general automation scope.

### xyflow
- **Use directly** (MIT, attribution in `THIRD_PARTY_NOTICES.md`).

---

## 5. Licence findings that constrain the design

1. `packages/llmz` declares **ISC** in its `package.json` and has no LICENSE file of its own; the repository root LICENSE is MIT. Both are permissive. If any LLMz source is ever copied, attribute to "Botpress Technologies, Inc." under MIT and note the ISC declaration. Our decision (ADR-002) is to write our own engine and copy no source, so the attribution list for LLMz is "concepts only".
2. LLMz depends on `@bpinternal/zui` and `@bpinternal/thicktoken` and peers on `@botpress/client` and `@botpress/cognitive`. A fork would carry a Botpress Cloud client dependency or require replacing the model layer.
3. Dify, Typebot, Hexabot, n8n and Botpress v12: **no code, no assets, no layouts**.
4. Flowise `packages/server/src/enterprise`: commercial; do not read for implementation.
5. Fonts: IBM Plex is SIL OFL 1.1 (see `05-design-system.md`).

---

## 6. Facts that could not be verified this session

- Chatwoot Agent Bot webhook payload fields and endpoints (the docs host timed out). The adapter spec in `04-contracts/chatwoot-adapter-spec.md` is based on Eyad's working bridge [E] and must be re-verified against https://developers.chatwoot.com before the adapter phase.
- Botpress Cloud's internal chunking, embedding and reranking choices.
- Whether Botpress Cloud runs Execute Code in the same QuickJS sandbox as LLMz.

## 7. Source index

Botpress docs index https://botpress.com/docs/llms.txt · nodes https://botpress.com/docs/studio/concepts/nodes/introduction · Autonomous Node https://botpress.com/docs/studio/concepts/nodes/autonomous-node · cards https://botpress.com/docs/studio/concepts/cards/introduction · Execute Code https://botpress.com/docs/studio/concepts/cards/execute-code · flow logic https://botpress.com/docs/studio/concepts/cards/flow-logic · KB https://botpress.com/docs/studio/concepts/knowledge-base/introduction and `/add-sources` · tables https://botpress.com/docs/studio/concepts/tables · versions https://botpress.com/docs/studio/concepts/versions · inactivity timeout https://botpress.com/docs/studio/concepts/cards/set-inactivity-timeout · retention https://botpress.com/docs/studio/guides/advanced/retention-period · ADK evals https://botpress.com/docs/adk-v2/testing/evals · ADK knowledge https://botpress.com/docs/adk-v2/data/knowledge · pricing https://botpress.com/pricing
Reviews: https://sitegpt.ai/blog/botpress-ai-review · https://theaiagentindex.com/agents/botpress · https://www.voiceflow.com/blog/botpress · https://rasa.com/blog/rasa-vs-botpress · https://ibl.ai/resources/comparisons/self-hosted-ai-vs-botpress
Rasa CALM: https://rasa.com/docs/reference/primitives/flows/ · https://rasa.com/docs/learn/concepts/calm/
isolated-vm status: https://github.com/laverdet/isolated-vm (README: "currently in maintenance mode"; "does not automatically make your application safe") **[V]**
Repositories: see the pin table in section 0.
