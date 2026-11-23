# ADR-058 — Model call settings: cache hints, reasoning effort and a latency budget

Status: proposed · Date: 2026-11-17 · Review: `docs/research/2026-11-17-ai-layer-review.md`

## Context

Architecture §6.4 orders the Autonomous Node's prompt so its prefix can be cached. ADR-031 keeps the
system text stable for a whole conversation. But the model layer never tells a provider what to
cache. `packages/llm/src/client.ts` sends `system`, `messages`, `stopSequences`, `temperature` and
`maxOutputTokens`, and nothing else. The effect differs by provider:

- **Anthropic** caches only up to a marked breakpoint. With no breakpoint, a Claude node pays full
  input price for the whole system text (engine rules, tool typings, up to 16,000 characters of
  instructions) on every iteration. Claude Sonnet 5.5's registry prices are $2.00 per MTok input
  and $0.10 cached.
- **OpenAI** caches long prefixes automatically. It accepts a cache key that routes requests with the
  same prefix together, and a retention setting. Neither is set.

The GPT-6 models reject `temperature` (`models.json` capabilities). That suggests they are reasoning
models, which spend time on hidden reasoning before the first visible token. The registry has no
reasoning setting, so every call uses the provider default.

The Majed pilot measured 4–30 s per reply. No one has measured how much of that comes from
reasoning, from repeated iterations, or from uncached prefixes.

The production stack reference puts both levers near the top: prefix caching is "free money", and
the latency budget comes first, before components.

Installed SDK types checked on 2026-11-17:

- `@ai-sdk/anthropic` 4.0.105: provider option `cacheControl: { type: "ephemeral", ttl?: "5m" | "1h" }`.
- `@ai-sdk/openai` 4.0.118, Chat Completions options:
  - `reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`;
  - `promptCacheKey`;
  - `promptCacheRetention: "in_memory" | "24h"`.

Where each option is placed (system message versus request) must be checked against the installed
docs and source during implementation (CLAUDE.md §9).

## Options

1. **Change nothing until a model is chosen.** This leaves Claude unmeasurable at a fair price and
   latency unexplained.
2. **Cache hints and an explicit, per-node reasoning setting, recorded in the registry and the
   trace, with a stated latency budget.** *(Recommended.)*
3. **Also route each turn by difficulty**: a small model first, a large one when the first fails or
   is unsure. This is the biggest cost lever in the stack reference. But it needs the gate data from
   ADR-056 to set the escalation rule. Deferred, not rejected.

## Recommendation

Use option 2.

### 1. Cache hints (implements §6.4; no behaviour change)

- `LlmRequest` gains `cache?: { key: string }`. The autonomy port sets it to a hash of the bot
  version and node id, so every conversation on the same node shares parts 1 and 2 of the prompt.
- **Anthropic.**
  - A breakpoint goes on the system text, which covers parts 1–3.
  - A second breakpoint goes on the last transcript message. A follow-up iteration in the same turn
    then reuses the transcript too.
  - TTL is 5 minutes. 1 hour is used only when the bot's measured gap between iterations makes it
    cheaper; cache writes cost 1.25× input at 5 minutes.
- **OpenAI.** `promptCacheKey` is set to the cache key. `promptCacheRetention` stays at the default
  until its price is confirmed on OpenAI's pricing page.
- **Other providers.** Nothing is sent.
- The trace already records `cachedInputTokens`. The ADR-056 gate report adds the cache hit ratio.

### 2. Reasoning effort

- The registry gets a capability `reasoningEfforts: string[]`, the values the model accepts, in the
  provider's own names. It is empty for models without reasoning.
- `AutonomousNode.reasoning: z.enum(["none", "low", "medium", "high"]).optional()`, together with
  matching fields on the AI cards and the utility-model settings.
  - Unset means the provider's default, so published bots do not change.
  - A value the model does not support is mapped to the nearest one it does. The trace records
    both the requested and the sent value. This is a known mapping, not a silent drop.
- Utility calls (summary, query rewrite, judge, extraction) default to the lowest effort the model
  supports. Their tasks are short and their output is checked.
- Reasoning tokens are recorded as output tokens. Their share is shown in the trace, because they
  are billed and they delay the first message.

### 3. Latency budget

The budget is stated so components can be chosen against it (ADR-056 G5 holds the bars):

| Stage, one user message with one search | p50 target |
|---|---|
| Queue and load | ≤ 150 ms |
| Query rewrite (ADR-055) | ≤ 600 ms |
| Embed + candidates + rerank | ≤ 700 ms |
| Model, time to first visible token | ≤ 1,500 ms |
| **First message sent** | **≤ 3,000 ms** |

Every stage already has a span. The gate report shows each stage's p50 and p95, so a regression
points at its stage.

### 4. An output cap for the Autonomous Node

The autonomy call gets a `maxOutputTokens` ceiling from the registry, with a node override. Today
it has none. A runaway reply ends as `finishReason: length`, which the engine already reports, and
not as a 30-second wait.

## Consequences

Contract changes:

- `docs/04-contracts/node.ts`: `reasoning` on `AutonomousNode` and on the AI cards.
- `models.ts`: the `reasoningEfforts` capability and an autonomy output cap.
- `trace.ts`: the requested and sent effort, and reasoning tokens, on `llm.call`.

The rest:

- Claude becomes affordable to run through the ADR-056 gate. That is required before G0 can name
  the strongest model.
- Effort per node becomes something a builder tunes. The Studio shows it under the model picker
  with a short explanation: lower is faster, higher is more careful.
- New build-plan rows once accepted:
  - **6.16** — llm request fields, adapters, registry, trace;
  - **6.17** — node field, Studio.

## Questions for Eyad

1. **Default effort for new Autonomous Nodes:** unset (provider default), or `low`? Recommended:
   unset until the gate has measured `low` against the default on Majed.
2. **Anthropic TTL:** 5 minutes everywhere, or 1 hour for bots whose users reply slowly (WhatsApp)?
