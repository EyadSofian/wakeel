# 02 — Product thesis

Reasoned from `01-research-report.md`. This is a point of view, not a survey. Where it guesses, it says so.

## 1. What the product is

`{{PLATFORM_NAME}}` is a hosted workbench for building, running and debugging conversational LLM agents, sold to teams that already own their customer channels.

It has three parts that matter:

1. **A Studio** where a builder lays out a conversation as workflows of nodes and cards, mixes deterministic steps with LLM-directed steps, and tests it in an emulator beside the canvas.
2. **A runtime** that executes those workflows turn by turn, runs tenant code and model-generated code in a sandbox, searches knowledge bases and tables, and records a full trace of every turn.
3. **A Bridge API** through which any inbox or channel system pushes user messages in and receives bot replies out.

It is not a helpdesk, not a channel aggregator and not a general automation tool. Those already exist where our customers work (Chatwoot, n8n, their CRM). We are the brain in the middle.

## 2. Who it is for

**Primary user: the bot builder at an agency or in-house automation team in MENA.** One to five people. Comfortable with JavaScript and HTTP, not a full-time backend engineer. Builds Arabic and bilingual support, sales and education bots for several clients. Today this person uses Botpress Cloud plus a hand-written bridge server plus n8n. Eyad is the archetype.

**Buyer: the company that owns the conversations** (Engosoft first). Cares about predictable monthly cost in a currency that is not kind to USD-per-conversation pricing, about where data lives, and about being able to see why the bot said something.

**Not for (now):** non-technical marketers who want a bot from a URL in five minutes; enterprises that need on-premise air-gapped voice; teams that want the platform to own WhatsApp.

## 3. Why it beats Botpress Cloud for them

Ordered by how much each one would change a purchase decision. Evidence markers refer to the research report.

1. **The bridge is the product, not a workaround.** Botpress assumes its own channels and its own Desk. A team with Chatwoot builds a server, a Trigger card, id-padding hacks and a hand-rolled handoff flag [E]. We give them signed webhooks, ordered delivery, a sync mode for simple callers, and explicit handoff request and release. This is the wedge: it is real, nobody else treats it as first-class, and Eyad has already paid the cost of not having it.
2. **Cost you can predict and cap.** Botpress now charges $0.50–0.65 per extra conversation, counts emulator conversations, and does not let you switch off auto-purchase [V]. We do not bill test traffic, we let a workspace set a hard cap, and we let tenants bring their own model keys so the platform fee is separable from model spend.
3. **Arabic that is engineered, not assumed.** Hybrid retrieval with Arabic normalisation applied identically at index and query time, dialect and code-switched examples in the eval sets, RTL-correct emulator and previews. Botpress documents none of this [I].
4. **You can see what happened.** Per-turn trace playback: prompt, generated code, each tool call with input and output, tokens, latency, the variables before and after. Botpress exposes "Iterations" and logs [V]; we make the trace the main debugging surface.
5. **Fewer silent failures.** Typed variables, workflows with declared inputs and outputs, publish-time validation, editor typings that match the bot's real schema. Each of these removes a documented Botpress pain [E].
6. **A calmer, faster Studio.** A real differentiator only if execution is excellent. It is the hardest claim to prove and the easiest for a buyer to feel in the first ten minutes.
7. **Deployable where the customer needs it.** Because we own the whole stack and keep it boring (Postgres, Redis, containers), a dedicated instance in a chosen region is an ops task, not a re-architecture. Botpress cannot offer this at all [V].

What we deliberately do **not** claim: more integrations (we have none), a better helpdesk (we have none), or a smarter model (same models).

## 4. Product principles

1. **Deterministic by default, autonomous by choice.** The builder decides where the model is allowed to decide. Writes to external systems belong in deterministic steps or behind typed tools.
2. **The model proposes, the engine validates.** Exits, variable writes and tool inputs are schema-checked by the engine. A model cannot leave a node through an exit that does not exist or write a variable it was not granted.
3. **Nothing implicit.** Every tool the model can call is visible on the node. Every variable it can read or write is listed. No hidden built-ins.
4. **Every failure is visible and actionable.** No silent drops. An error states what happened and how to fix it, in the emulator and in the trace.
5. **Test traffic is free and first-class.** Emulator and eval runs are flagged, excluded from conversation metering, and traced like production.
6. **Replayable.** A turn can be re-run from its recorded inputs against a draft. If it cannot be replayed it cannot be debugged.
7. **Arabic is a gate, not a feature.** Any retrieval, UI or eval change is checked with Arabic and mixed-direction content before it is done.

## 5. Scope

### MVP (the smallest thing Engosoft can run in production)

- Workspaces, members, four fixed roles, API keys, audit log.
- Studio: workflows, Standard and Autonomous nodes, the card set in `04-contracts/card.ts` marked `mvp`, variables in four scopes, Execute Code with generated typings, emulator, command palette, core shortcuts.
- Runtime: turn engine with persistence, sandbox, inactivity timeouts, error workflow.
- Autonomous Node with code-generation protocol, tools from cards, exits mapped to transitions, retry with feedback.
- Knowledge bases: files and URLs (single page and sitemap), hybrid search, rerank, citations, chunk inspector.
- Tables with typed columns, filters, use from cards, code and tools.
- Draft, publish, immutable versions, rollback.
- Bridge API: inbound REST, async signed webhooks, sync mode, all message types, handoff request and release.
- Traces per turn, conversation log.
- Token and conversation metering, per-workspace quotas with hard caps.

### Next (within two phases after MVP)

- Evals with a visual runner; analytics; version diff; site crawl with schedules; billing provider hook; reference Chatwoot adapter; trace replay against draft.

### Later (designed for, not built)

- Persona simulation evals; conditional instruction blocks; approved-wording responses; real-time multi-user editing; native tool-calling protocol for models that are weak at code; microVM tier for heavy code; SSO; custom roles; dedicated-instance automation; templates.

### Never (unless the thesis changes)

- Native channels, an agent inbox, general workflow automation.

## 6. Business model sketch (to be confirmed by Eyad)

Assumption **[I]**: a platform fee per workspace tier that includes a conversation allowance sized for MENA SMBs, with model spend either bring-your-own-key (no markup) or platform-provided (pass-through plus a stated margin). Overage is off by default: at the cap the bot answers with a configurable fallback and raises a `quota_exceeded` event, unless the workspace opts into overage. This is the opposite of the Botpress default and is a selling point in itself.

The architecture supports this without committing to it: metering produces usage events; a billing adapter interface consumes them.

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sandbox escape or tenant data leak | Low | Fatal | Defence in depth (ADR-003), RLS (ADR-004), human review on every security task, external pen-test before first paying tenant |
| Autonomous Node unreliable on cheaper models or in Arabic dialects | Medium | High | Protocol adherence eval suite per supported model; publish a supported-model list; native tool-calling fallback is designed in |
| Studio craft falls short of the bar | Medium | High | Design tokens and the screenshot review loop are mandatory; perf budget tested in CI; ship fewer screens rather than rough ones |
| Scope creep toward channels or inbox | High | Medium | "Never" list above; Bridge API plus one reference adapter |
| Solo-founder operations (uptime, on-call) | High | High | Boring infra, one region first, runbooks in the final phase, managed Postgres and Redis |
| Model cost eats margin when platform keys are used | Medium | Medium | Per-turn budgets, prompt-cache-friendly prompts, cheap-model routing for utility calls, BYOK default for agencies |
| Botpress ships a first-class bridge or cuts price | Low | Medium | Residency, Arabic quality and debuggability remain |
| Legal exposure from study of restricted-licence code | Low | High | Concepts-only rule in `CLAUDE.md`; `THIRD_PARTY_NOTICES.md`; no restricted repo is vendored or kept in the workspace |
| KB quality on scanned Arabic PDFs | High | Medium | OCR tier through a vision model; parse-quality check before indexing; set expectations in the UI |

## 8. What would prove the thesis wrong

- Builders do not actually want the bridge model and ask for native WhatsApp within the first month. Then the product is an inbox competitor and this design is the wrong shape.
- The code-generation Autonomous Node needs a frontier model to be reliable, and frontier pricing makes the MENA price point impossible. Then the default must become native tool calling on a mid-tier model.
- Engosoft's own bots cannot be migrated from Botpress in under two weeks each. Then parity is further away than the MVP list assumes.

The build plan front-loads the pieces that test the first two: the Bridge API and the Autonomous Node are both running end to end before knowledge bases, tables or analytics exist.
