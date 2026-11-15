# ADR-031 — Prompt layout details: instructions without end-user text, the transcript window, data blocks

Status: proposed (implemented as proposed in task 6.4; review with that PR) · Date: 2026-11-14

## Context

Architecture §6.4 orders the Autonomous Node's prompt for caching and places the "rendered instructions" in system part 3. Instructions are a template (`AutonomousNode.instructions`), and a template may reference `user.*`, `conversation.*`, `workflow.*` or `event.*`, which hold end-user text. CLAUDE.md §9 says end-user text never goes into a system prompt. §6.4 also leaves open:

1. How tokens are counted for the transcript window (no tokenizer is shared across providers).
2. What "a clearly delimited data block" looks like.
3. How bot messages other than text appear in the transcript.

## Decision

1. **Instructions are rendered with `bot` and `env` values only.** A reference to any other root (`user`, `conversation`, `workflow`, `event`, `turn`) renders as `‹user.name›`. The values themselves are listed in the final user-role block (§6.4 part 5), where the model reads them as data. System part 3 therefore has no end-user text, and stays the same for the whole conversation, which keeps it cached.
2. **Tokens are estimated as `ceil(characters / 3)`.** That overcounts English (about 4 characters a token) and suits Arabic (closer to 2–3). An overestimate only makes the window smaller. The budget defaults to 6,000 tokens (§6.4).
3. **Data blocks** are `<data source="…">` … `</data>` on their own lines. Any `</data` inside the content is written as `<\/data`, so content cannot close its own block. Tool output, KB passages, the conversation summary and variable values all go in data blocks, in user-role messages.
4. **Transcript roles:** inbound messages are `user`, the bot's are `assistant`. A non-text bot message appears as a one-line description, such as `[choice: Track it | That's all]`, so the model sees what it showed without a payload dump.
5. **The static prefix** is the system text: parts 1, 2 and 3 joined with one blank line, in that order. Parts 1 and 2 depend only on the engine version and the node, and part 3 only on the conversation. Nothing that changes per turn (time, iteration, feedback) is in it.

## Consequences

- An instruction like "Greet {{user.name}}" still works: the model sees `‹user.name›` in the instructions and the value in the variables block.
- The summary is produced by the utility model from the overflowed messages (task 6.4 ships the call; the engine wires it in 6.5).
