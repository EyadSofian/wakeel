# ADR-035: Workflow tool calls and resuming a suspended tool

Status: proposed
Date: 2026-11-14
Task: 6.6 (part 2)

## Context

Build plan 6.6 asks for workflow tools "inline and suspending" and for `submitToolResult` resume.
Architecture §6.3 says a workflow tool *whose workflow waits for user input* aborts the run block at
the call site, and that the node then gets "tool X finished with …; code after that call did not run".
The contracts already carry the mechanics: a `call` step outcome with `toolCallId`, a frame's
`call.toolCallId`, `AutonomyMemory.pendingTool`, the `tool_resumed` feedback kind, `WaitSpec` kind
`tool`, and the `tool_result` inbound event (ADR-029). The engine (task 4.2) pushes the workflow as a
frame and, on its return, adds `tool_resumed` feedback to the calling node.

Nothing says:

1. what "inline" means when the run block cannot know in advance whether the workflow will wait;
2. what happens to the run block's variable writes when it stops at the call;
3. how the `toolCallId` is made, and whether a resumed tool restarts the iteration budget;
4. where citation sources live until knowledge bases exist (Phase 8).

## Options for "inline"

- **A. Run the workflow inside the tool call.** The worker would run a nested engine while the
  sandbox waits, and hand the outputs back to the model's code. A workflow's cards send messages,
  call code and may still wait; all of that would have to happen inside one autonomy step. That
  breaks "every step is one transaction" (§4.4), gives the nested steps no message ids or commits
  of their own, and needs a second path for a workflow that turns out to wait halfway.
- **B. Replay the run block with recorded results.** Run the code again after the workflow returns,
  answering earlier tool calls from a journal. QuickJS code is not guaranteed deterministic, and a
  tool with side effects called before the workflow would run twice if the journal missed it.
- **C. Every workflow tool call ends the run block at the call site.** The workflow runs as
  ordinary frames (§4.4). If it does not wait, it finishes in the same turn with no round trip to
  the user ("inline"); if it waits, it finishes in a later turn ("suspending"). Either way the node's
  next iteration starts with the outputs and the note that code after the call did not run.

## Decision

**C.**

1. A call to a workflow tool is checked in the worker: the tool is on the node, the workflow exists,
   and the input matches the workflow's declared inputs (names, required, types), else
   `tool_input_invalid`. The worker then stops the sandbox exec (it never answers the call), and the
   step returns `call` with the workflow, the inputs, no output mapping, and the `toolCallId`.
2. The run block's variable writes and `memo` changes are dropped, as for a failed run: the exec is
   stopped before the sandbox computes its scope diff. `:::say` messages before the run are sent.
   Tools called earlier in the block did run; their effects are not undone. The feedback says all
   of this.
3. `toolCallId` is `<idempotencyKey>:<tool name>` (the step's `turnId:stepSeq`, then `:run`), so a
   re-run step produces the same id. One call can be pending per node; it is kept in
   `pendingTool` until the result arrives.
4. When the workflow returns, the engine's `tool_resumed` feedback (`{ toolCallId, outputs }`) is
   turned by the node into "Tool X finished with … Code after that call did not run, and the
   variables it set were not kept." A `tool_result` event for the pending call (submitToolResult)
   does the same with its `result`, or "failed: <message>" with its `error`; a result for another
   call is ignored (engine, ADR-029 §2).
5. A `tool_result` arrives in a turn of its own, so the node gets a fresh iteration budget, as after
   `listen`. A workflow return does not reset it; a workflow that waited for the user continues the
   budget it started with. This keeps a model that calls an inline workflow in every iteration
   inside `maxIterations`.
6. `tools.d.ts` says on every workflow tool: "Calling it ends your code at this call, and you get
   its outputs in your next step; call it last." Its declared return type is `Promise<never>`, and
   the outputs' shape is in the doc comment as what the next step receives.
7. **Code tool suspension is deferred.** `ctx.suspend(reason)` (§6.3) needs `ctx.toolCallId` and a
   bridged call in the Code guest, which has no bridged platform calls yet (`fetch` included), so a
   code tool cannot tell an outside system which call to answer. The node already handles a
   `tool_result` resume and the `wait` kind `tool`; the producer follows when the Code guest gains
   bridged calls.
8. **Citations.** `[[cN]]` tokens in outgoing text are mapped to `Citation`s from the citation
   sources the node knows and stripped from the text; unknown tokens are stripped. Until `kb_search`
   exists (Phase 8) there are no sources, so tokens are only stripped. Phase 8 decides where sources
   are kept between iterations and how `messages.citations` is written.

## Consequences

- The model cannot use a workflow's outputs in the same block that called it. The prompt tells it
  to call the workflow last; the protocol's "return a value to iterate" is unaffected.
- No nested engine, no replay journal: one step stays one transaction.
- `submitToolResult` reaches the node end to end, but nothing produces a `tool` wait until the
  Code guest gains `ctx.suspend`.
