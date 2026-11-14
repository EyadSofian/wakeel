# ADR-027 — When the `conversation_started` trigger runs

Status: proposed (implemented as proposed in task 4.8; review with that PR) · Date: 2026-11-14

## Context

Task 4.8 builds the Trigger and Error handler nodes. Task 4.2 already built most of them: custom events, `inactivity` and `handoff_released` triggers, the trigger frame that restores the wait it interrupted, and the error resolution order (§4.4 "Errors").

One trigger kind has no behaviour anywhere in the docs. `04-contracts/node.ts` defines `on.kind = "conversation_started"` as "First inbound activity of a new conversation, before Start", but:

1. **The event table in architecture §4.4 has no row for it.** It says nothing about which inbound kinds count as "activity", or what "new" means once a conversation has ended and starts a new session (§4.4: a `message` in `ended` resets the state).
2. **The engine cannot tell that a conversation is new.** `ConversationState` for a fresh conversation (`emptyState()`) is the same as one that finished Main and went back to `idle`. The engine is pure, so it cannot look at earlier turns.
3. **"Before Start" has no defined order.** The docs don't say whether Start runs after the trigger's path, or what happens if that path waits or ends.

The Chatwoot adapter spec (`04-contracts/chatwoot-adapter-spec.md`) also sends a custom event named `conversation_started` when a pair is set to greet first, so a custom event can be a conversation's first activity.

## Options

**A. A `started` flag in `ConversationState` (recommended).** Add `started: z.literal(true).optional()`. The engine sets it when a session begins and fires the trigger when it is absent. `emptyState()` leaves it out, so a new conversation and a session reset by `ended` both count as new.
- Pure, no new port, and saved per step like the rest of the state, so a re-run step behaves the same.
- One small additive field in a contract.

**B. The worker passes `isNewConversation` in `TurnInput`.** The worker counts earlier turns.
- No state change, but it misses the new session after `ended` (same conversation row), and it has to define "earlier turn" carefully (a `user_update`-only turn, or a crashed first turn).

**C. Treat the first `message` in `idle` with empty conversation variables as new.** No contract change, but it is wrong for any bot that sets no conversation variables. Rejected.

## Decision

Option A.

1. **New field.** `ConversationState.started?: true`. `emptyState()` does not set it, so the `ended → new session` reset clears it.
2. **What starts a session.** The engine sets `started` and runs the trigger when the state has no `started` flag and the event is:
   - a `message` in `idle` or `ended` (the rows that push Main at Start), or
   - a custom `event` in any state the table lets events run in (not `handed_off` or `ended`).

   `user_update`, `tool_result`, `handoff_release` and `timeout` neither start a session nor fire the trigger. `user_update` runs no steps (§4.4), and the other three cannot arrive before a session exists. `run_from` (emulator only, ADR-025) sets `started` without firing the trigger: the builder chose where to start.
3. **Where the trigger is looked up.** Main only, as for `inactivity`, since nothing else is on the stack yet. The first Trigger node in Main with `on.kind = "conversation_started"` wins, the same way `findMainTrigger` picks the others.
4. **Order: the trigger's path runs first, then the event's own work.** The engine pushes what the event would normally push (Main at Start for a `message`, the matching event trigger for a custom `event`, or nothing), then pushes the `conversation_started` trigger frame on top. When the trigger's path finishes, its frame pops (§4.4: no edge means an implicit return) and the frame below runs.
   - If the trigger's path waits (for example, an Ask card), the conversation waits there. Start runs after that path finishes in a later turn.
   - If the trigger's path ends the conversation or hands off, the frames below are dropped as usual, and Start does not run.
5. **A custom event named `conversation_started`** matches only triggers with `on.kind = "event"` and that name, as for any custom event. If it is the conversation's first activity, the `conversation_started` kind also fires (rule 2). So the adapter's greet-first pair works with either kind of trigger.
6. **Validation.** No new rule. A `conversation_started` trigger outside Main never fires. A warning for that belongs with the other trigger checks if they are added later. This ADR does not add one.

## Consequences

- `ConversationState` gains one optional field. Conversations stored before this change have no `started` flag, so a conversation that was already `idle` would fire the trigger on its next message. Nothing is in production yet (Phase 15), so no data migration is needed. After launch, a change like this would need one.
- State comparisons in engine tests now include `started: true` after any turn that began a session.
- The trace shows the trigger's path before Start's path. The Trigger node itself, like Start, passes straight through and runs no step, so it has no span (ADR-026 builds spans from step commits, so no trace change is needed).
- Docs changed with this ADR: the `conversation_started` row in the architecture §4.4 event table, and `started` in `04-contracts/runtime.ts`.
