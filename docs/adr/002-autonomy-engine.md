# ADR-002 — Autonomous Node: own engine, not an LLMz fork

Status: accepted · Date: 2026-11-13

## Context
The Autonomous Node must work in the style of Botpress LLMz: the model writes code that calls tools, exits map to transitions, errors are fed back for retry. LLMz is public (`botpress/botpress`, `packages/llmz`, v0.9.19). We can fork it or write our own.

Findings from source (see `01-research-report.md` §1.4):
1. Licence is permissive (`ISC` in package.json, MIT at repo root) but there is no LICENSE file in the package.
2. Hard dependencies on `@botpress/client`, `@botpress/cognitive`, `@bpinternal/zui`, `@bpinternal/thicktoken`: the model layer and schema library are Botpress's.
3. Pre-1.0 and moving fast: the response format changed from a single TSX program to `■` blocks and the sandbox from isolated-vm to QuickJS; the package's own docs are stale.
4. The sandbox runs **in the host process** and falls back to an **unsandboxed** Node driver if QuickJS fails to load.
5. Hooks exist, but tracing, metering and persistence are shaped for Botpress Cloud.

## Decision
Write our own engine in `packages/autonomy`. Reuse LLMz's **ideas**, copy no source:

- code-generation instead of JSON tool calls;
- a line-oriented response protocol where messages stream before code runs and there is at most one code block per response (`:::say`, `:::run`, `:::exit`, `:::end`);
- tools documented to the model as TypeScript declarations;
- typed exits; reflection by returning a value; suspension that stores a JSON checkpoint with the pending tool call.

Differences we want:
- Code runs out of process in `apps/sandbox` (ADR-003), never in the worker.
- No implicit tools; no fallback driver.
- Variable writes are validated patches, not live proxies.
- Protocol sits behind an `AutonomyProtocol` interface so a native tool-calling variant can be added without touching the engine loop.
- Tracing and metering are first-class ports.

## Alternatives considered
- **Fork LLMz**: fastest to a demo. Rejected: we would replace the model client, the schema library, the VM host and the tracing, which is most of the package, while tracking upstream protocol churn.
- **Depend on `llmz` from npm**: rejected for points 2 and 4.
- **Native tool calling only**: simplest and well supported by providers. Rejected as the default because multi-tool logic costs one model round-trip per call and the brief asks for the LLMz style. Kept as the planned second protocol.

## Consequences
- We own prompt engineering and adherence across models. An eval suite (`packages/autonomy/evals`) gates which models are marked supported.
- More work up front: parser, prompt builder, typings generator (~2,000 lines estimated).
- `THIRD_PARTY_NOTICES.md` lists LLMz under "concepts, no code".

## Revisit when
LLMz reaches 1.0 with a pluggable model client and an out-of-process VM host, or adherence evals show the directive protocol under 95% on the models customers want.
