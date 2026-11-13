# ADR-018 — Expression batches: the engine's sandbox port and what an expression failure means

Status: proposed (implemented as proposed in task 3.5; review with that PR) · Date: 2026-11-13 · **Touches the sandbox contract: changes need human review**

## Context

Architecture §4.6 says a pure property path (`workflow.email`, `user.attributes.plan`) is resolved natively, and "anything else is evaluated in the sandbox in one batched call per card". §5.1 gives the sandbox wire frame: `{ execId, kind: 'code'|'expressions'|'autonomy_run', source, scopes, toolManifest, limits, capabilityToken }`, answered by `{ t:'result', value, scopePatches, stats }` or `{ t:'error', code, message, line, column }`.

Task 3.5 builds the engine side. The docs leave these questions open:

1. **The engine's port.** The engine declares its ports (CLAUDE.md §4), but no port for expressions is written down.
2. **How a batch travels.** `source` is one string, yet a batch holds several expressions. If one of them throws, should the other results be lost?
3. **What the guest may do.** An expression can be an assignment (`workflow.x = 1`) or call `fetch`. §5.2 describes the guest for code, not for expressions.
4. **`undefined`.** An expression can yield `undefined`, which JSON cannot carry.
5. **Which error code.** `errors.ts` has `expression_error` ("An expression failed: {message}", fix "Fix the expression `{expression}`") and `template_error` ("A message template could not be filled in", fix "Check `{expression}` in the highlighted field"). §4.6 says "a runtime exception in an expression is `expression_error`" but does not say when `template_error` applies.
6. **How a value becomes text** in a template: `null`, `undefined`, objects, arrays.
7. **What counts as a pure path.**

## Options

For the batch (question 2):

- **A. One exec per expression.** Simple, but it breaks "one batched call per card" and multiplies the per-exec overhead (fresh QuickJS context, ~5 ms target).
- **B. One exec, all-or-nothing.** The batch fails as a whole when any expression throws. The builder then sees one error, and the engine cannot tell which expression failed.
- **C. One exec, one outcome per expression (recommended).** The guest evaluates each expression in its own `try`, and the result value is an array of outcomes in request order.

## Recommendation

**1. Engine port** (`packages/engine/src/expr/sandbox-port.ts`):

```ts
interface ExpressionBatch {
  expressions: readonly string[];       // distinct sources, never path-only ones
  scopes: Readonly<ExpressionScopes>;   // bot, user, conversation, workflow, event, env, turn
}
type ExpressionOutcome = { ok: true; value: Json | undefined } | { ok: false; message: string };
interface SandboxPort {
  /** Same length and order as `expressions`. Rejects only when the batch as a whole could not run. */
  evalExpressions(batch: ExpressionBatch): Promise<ExpressionOutcome[]>;
}
```

The engine sends each distinct source once, and calls the port at most once per `evalExpressions` or `renderTemplates` call. A card puts all its fields into one such call (4.3).

**2. Wire mapping** (for the sandbox client, 3.3): `kind: 'expressions'`, `source` is the JSON array of expression strings, and `result.value` is the JSON array of outcomes. In an outcome, `{ ok: true }` without a `value` key means `undefined`. The sandbox evaluates each source as `(<source>)` in its own `try`, so a `SyntaxError` or a throw affects only that expression's outcome.

**3. Guest for `expressions`:** the scopes are deep-frozen, and the guest runs in strict mode, so an assignment throws and becomes that expression's failure. There is no `fetch`, `tables`, `kb`, `ai`, `say` or `log`, and no tool manifest. `scopePatches` must be empty, and the client treats a non-empty one as a protocol error. The deadline comes from `limits.ts` (proposed: 1 s per batch). A whole-batch failure (deadline, memory, sandbox unavailable) rejects the port call. The engine then gives each expression in that batch a failure that carries the sandbox's message.

**4. Error codes:**

- A standalone expression (a condition, a Set variable value, call inputs, Exit outputs) fails with `expression_error` and params `{ expression, message }`.
- A template fails with `template_error` and params `{ expression }`. That covers a placeholder that throws, a template that does not parse at run time (drafts run in the emulator before publish validation), and a value that cannot become text. When an expression threw, the `expression_error` is kept as the `cause`, and its message is the `detail`. So the trace still shows the message, and the builder is sent to the field.

**5. Value to text:** strings as they are; numbers and booleans by `String()`; `null` and `undefined` as the empty string; objects and arrays as `JSON.stringify`. Text is never trimmed, reordered or wrapped in bidi marks. Arabic and mixed-direction text pass through unchanged (CLAUDE.md §11).

**6. Pure path:** a scope root (`bot`, `user`, `conversation`, `workflow`, `event`, `env`, `turn`), then any number of `.name`, `?.name`, `[0]`, `?.[0]`, `["key"]` or `['key']` steps. Whitespace between tokens is allowed. Anything else goes to the sandbox, including a comment, an escape sequence in a key, a computed key and a call. The fast path matches JavaScript exactly or steps aside:

- an own property gives its value, a missing one gives `undefined`, and `length` and indexes of strings and arrays work;
- reading a property of `null` or `undefined` without `?.` is a failure, with the message JavaScript would give;
- an inherited name such as `constructor` or `toString` goes to the sandbox, because only the interpreter can produce that value.

A false negative costs one sandbox call. A false positive would be a wrong answer, so the grammar stays narrow.

## Consequences

- 3.3's sandbox client implements the wire mapping above, and 3.2/3.3 tests cover a batch where one expression throws and the rest succeed.
- `limits.ts` gains an expression batch deadline when 3.3 lands.
- The engine never parses or runs builder code beyond recognising the path grammar. There is still no `eval`, `Function` or `vm`.
- If Eyad prefers different rendering for `null` and `undefined` (for example the literal text), only `stringifyValue` in `packages/engine/src/expr/template.ts` changes.
