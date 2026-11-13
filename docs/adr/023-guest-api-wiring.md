# ADR-023 — Guest API wiring: the bridge, scope patches, platform calls, fetch identity and redaction

Status: proposed (implemented as proposed in task 3.3; review with that PR) · Date: 2026-11-14 · **Security-critical: changes need human review**

## Context

Task 3.3 builds the guest API that architecture §5.2 lists by name and ADR-022 (proposed, PR #37) types. ADR-018 (proposed) fixes the `expressions` wire mapping. ADR-020 (proposed) fixes how callers use egress. It also says the exec frame's `capabilityToken` should get a format in 3.3. ADR-019 (proposed) fixes the core runner.

The documents still leave these questions open:

1. How guest calls reach the host without exposing host objects.
2. The shape of `scopePatches`, which §5.1 names but nothing defines.
3. How `say`, `tables`, `kb` and `ai` travel. §5.1 has `tool_call` and `log` frames only, and ADR-003 says data access happens in the worker through the exec stream.
4. Who calls egress for the guest `fetch`, and how egress learns the workspace.
5. Which `env` values are secret. `ConfigVariable.secret` exists in the bot definition, but the exec frame carries only values. Nothing says where the `ctx.idempotencyKey` value or the table names come from either.
6. What redaction covers, and how much a guest may log.
7. Strict mode for `code`.

## 1. One string bridge, guest API written as guest code

- **A. Host functions per API** (`fetch`, `say`, `tables.x.find`…) that build guest objects from the host side with handles.
- **B. One host function that takes and returns only strings.** The guest API (`fetch`, `axios`, `tables`, `log`…) is a prelude of plain JavaScript evaluated inside QuickJS before the code. It captures the bridge in a closure and deletes it from the global object.

**Recommendation: B.** Only JSON text crosses the boundary in either direction. The host parses that text with its own `JSON.parse`, checks the size and validates the operation name against a fixed list. No host function, object or prototype is ever reachable from the guest, so prototype pollution of a "bridged object" can only affect guest copies. The prelude takes its intrinsics (`JSON`, `Promise`, `Object.freeze`…) before the code runs. If the guest later replaces them, it breaks only its own run. The prelude is a string run by QuickJS, not by Node, so no `eval`, `Function` or `vm` is involved (ADR-003).

The bridge has two entry points:
- `call(op, json)` returns a guest promise that the host settles later. It serves `fetch` and the platform calls.
- `emit(op, json)` is synchronous and returns nothing. It serves `log`.

## 2. Scope injection and `scopePatches`

The frame's `scopes` hold `bot`, `user`, `conversation`, `workflow`, `event`, `env` and `turn` as JSON. The guest gets deep copies.
- `bot`, `event`, `env` and `user.attributes` are deep-frozen.
- `workflow`, `conversation`, `user` (apart from `attributes`) and `turn` are plain mutable objects.

After the code's promise settles, the prelude serialises the four mutable scopes with the captured `JSON.stringify`, and the host compares them with what it sent, one top-level variable at a time:

```
scopePatches: {
  workflow?:     { set?: { [name]: Json }, unset?: string[] },
  conversation?: { set?: …, unset?: … },
  user?:         { set?: …, unset?: … },   // never `attributes`
  turn?:         { set?: …, unset?: … }
}
```

A variable whose JSON text changed is in `set` with its whole new value. A variable that was deleted, or set to `undefined`, is in `unset`. Keys are variable names, as the guest sees them. The worker maps them to `VariableId`, validates the types (`variable_type_mismatch`) and applies the state size limit. A scope that did not change has no key. When the code fails, no patches are returned: an error frame has no `scopePatches`, so a failed step writes nothing.

## 3. Platform calls are `tool_call` frames with reserved names

**Recommendation:** `say`, `tables`, `kb` and `ai` each send one `tool_call` frame and wait for its `tool_result`. Their names come from a fixed list that cannot collide with builder tool names, because builder names have no dot and `say` is reserved:

| Guest call | `name` | `input` |
|---|---|---|
| `say(m)` | `say` | `{ message }` (a string becomes `{ type: "text", text }`) |
| `tables.<t>.find(o)` | `tables.find` | `{ table, ...o }` |
| `tables.<t>.get(w)` | `tables.get` | `{ table, where }` |
| `tables.<t>.insert(v)` | `tables.insert` | `{ table, values }` |
| `tables.<t>.update(w, v)` | `tables.update` | `{ table, where, values }` |
| `tables.<t>.upsert(v, on)` | `tables.upsert` | `{ table, values, on }` |
| `tables.<t>.delete(w)` | `tables.delete` | `{ table, where }` |
| `kb.search(q, o)` | `kb.search` | `{ query, ...o }` |
| `ai.generate(o)` / `extract` / `classify` | `ai.generate` / `ai.extract` / `ai.classify` | `o` |

- A `tool_result` with `ok: false` carries `error: { code, message }`. The guest sees an `Error` with that `message` and a `code` property (ADR-022).
- The frame's `toolManifest` (builder tools) is not exposed to `code` or `expressions`. It is for `autonomy_run` (Phase 6). This keeps "every tool the model can call is listed on the node" true there.
- The frame gains `tables: string[]`, the names of the workspace tables this bot may use. `tables.<name>` exists only for those names, so `tables.missing` is `undefined`, not a proxy.
- Limits per exec: 16 calls in flight at once and 500 in total. Past either limit the call rejects with `code_error`. Each `tool_result` frame fits the 4 MB frame limit (ADR-019 §5).

## 4. `fetch` goes from the sandbox service to egress, identified by a capability token

The sandbox runs in a network where only egress is reachable (§5.3 layer 4).

**Recommendation:**
- The guest's `fetch` goes through the bridge to the sandbox service's main thread, which calls `POST /v1/fetch` on egress. The runner thread itself makes no network calls.
- The service sends `Authorization: Capability <capabilityToken>`, using the token from the exec frame as it is. This adopts identity option b from ADR-020.
- Token format: `wkc1.<payload>.<signature>`.
  - `payload` is the base64url JSON of `{ ws: WorkspaceId, exec: string, exp: epochSeconds }`.
  - `signature` is the base64url HMAC-SHA256 of `wkc1.<payload>`, keyed with `EGRESS_CAPABILITY_KEY`.
  - The worker mints the token when it starts an exec, with `exp` set to the exec deadline plus 30 s. The code is in `packages/contracts/src/capability.ts` and uses WebCrypto.
  - Egress verifies the signature in constant time and checks the expiry. It takes the workspace from the token: the body must leave out `workspaceId` or give the same one.
  - The sandbox never holds the key, so a compromised sandbox can only use tokens for its own execs, and only until they expire.
- Egress still accepts `Bearer EGRESS_TOKEN` with `workspaceId` in the body, for platform callers (webhook delivery, crawler). The sandbox is never given `EGRESS_TOKEN`.
- An exec with no `capabilityToken` has `fetch`, but every call rejects with `fetch_failed` ("this run has no network access"). Expressions have no `fetch` at all (ADR-018 §3).
- The guest request has `method`, `headers` and a string `body`.
  - The service lowers `timeoutMs` to the time left before the exec deadline. It never raises egress's limits (10 s, 5 MB, 5 redirects).
  - The response reaches the guest as `{ status, statusText, url, headers: [name, value][], body }`, with the body decoded as UTF-8. `text()` and `json()` read it, and `headers.get()` joins repeated values with `, `.
  - An egress refusal (`fetch_blocked`, `fetch_failed`, `rate_limited`, `validation_failed`, `payload_too_large`) rejects the guest promise with an `Error` that has that `code`. A 4xx or 5xx from the remote service is a normal response.
- At most 4 fetches are in flight per exec, and they count toward the 500 calls.

## 5. Frame additions

The exec request frame (§5.1) gains three optional fields, each with a default:

- `secretKeys: string[]` (default `[]`): `env` keys whose values are secret, taken from `ConfigVariable.secret`.
- `tables: string[]` (default `[]`): see section 3.
- `ctx: { idempotencyKey: string }` (default: the `execId`). The worker derives it from the step so it is the same on every retry (ADR-022).

`kind: "expressions"` uses none of them. The `result` and `error` frames are unchanged apart from the `scopePatches` shape in section 2.

## 6. Redaction and log limits

- The redaction set holds the values of `env[k]` for every `k` in `secretKeys` that are at least 4 characters long. A shorter value would blank out ordinary text, and it is too short to be a credential worth hiding.
- Every occurrence of a value in the set, in a `log` frame argument or an error frame `message`, is replaced by `[redacted]`. The set is checked longest value first, and also in its JSON-escaped form.
- `result.value` and `scopePatches` are data, not log text. The worker's trace redaction applies the same set to them (§12, T5).
- Log arguments go through the captured `JSON.stringify`. Strings stay as they are. Values that cannot be turned into JSON become their `String()` form.
- Each exec may send up to 200 `log` frames of up to 8 KB each. Longer frames are cut with `…`. Past 200, one last frame says how many were dropped.
- `log` is synchronous and never blocks the guest.

## 7. Strict mode

**Recommendation:** `code` runs in strict mode, as ADR-018 already requires for `expressions`. A write to a frozen scope (`env.KEY = 1`) then throws a `TypeError` that points at its line, instead of being ignored. Assigning to an undeclared name also throws. Code moved from other platforms may need `let` added in a few places, and that is the only cost.

## 8. Line and column

The code is not transpiled. Lines are the code's own, and columns on line 1 are shifted back by the prefix (ADR-019 §7). The prelude is evaluated as a separate script, so it never shifts lines. When a bridge call rejects, the guest `Error` is created inside the guest at the call site, so its line and column point at the `await fetch(…)` that failed. "Source-mapped" in the build plan needs nothing more until code is transpiled (TypeScript in the editor compiles to JS with the same lines).

## Consequences

- `packages/sandbox-client` holds the frame schemas (ADR-019 §10) and a typed `exec()` that answers tool calls through a handler. It also holds the ADR-018 expression port and `mintCapabilityToken`.
- `apps/egress` gains the capability authorisation path and the `EGRESS_CAPABILITY_KEY` setting. `apps/sandbox` gains `EGRESS_URL`.
- A contract test checks that every global in the ADR-022 typings exists in the sandbox with the right kind (function or object).
- The egress wire schemas stay in `apps/egress`. The sandbox keeps its own copy of the response schema until they move to `packages/contracts` (ADR-020), and a follow-up does that move.

## Revisit when

Code is transpiled (then real source maps are needed), builder tools become callable from code cards, a tenant needs binary response bodies, or a guest needs streaming.
