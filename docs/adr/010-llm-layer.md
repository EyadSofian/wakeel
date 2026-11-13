# ADR-010 — Model layer: our own narrow interface, provider SDKs behind adapters

Status: accepted · Date: 2026-11-13

## Context
The platform must be provider-agnostic (OpenAI, Anthropic, Gemini, local), support bring-your-own-key per workspace, meter every call, and keep prompt caching effective.

## Decision
- `packages/llm` defines four operations: `stream` (text with stop sequences and cache hints), `generateObject` (schema-constrained output), `embed`, `rerank`.
- Adapters wrap the Vercel AI SDK (`ai` and its provider packages, Apache-2.0) for chat and embeddings, with an OpenAI-compatible adapter for vLLM, Ollama and OpenRouter, and small direct adapters for rerank APIs and TEI.
- A **model registry** (`models.json`, edited by humans) lists each model's id, provider, context window, capabilities (vision, caching, structured output), prices and Autonomous Node support level. Nothing else in the codebase names a model.
- Credentials resolve per call: workspace key, else platform key if the plan allows.
- The Autonomous Node uses plain streaming text with a stop sequence. It does not depend on any provider's tool-calling or structured-output feature, which keeps it portable.
- Every call emits a usage event and an `llm.call` span.

## Alternatives considered
- **LiteLLM proxy**: broad coverage and budgets, but a Python gateway holding every key in the request path, with a recent supply-chain incident. Rejected.
- **Call provider SDKs directly everywhere**: leaks provider shapes into the engine.
- **Depend on the AI SDK's types throughout**: rejected; the SDK changes major versions often. It stays behind our interface.

## Consequences
- Adding a provider is one adapter and registry entries.
- Provider-specific features (reasoning effort, cache breakpoints) are expressed as optional hints that adapters may ignore.

## Revisit when
We need a network-level gateway for many services, or self-hosted serving becomes the main path.
