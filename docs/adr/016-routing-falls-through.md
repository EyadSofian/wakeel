# ADR-016 — An unconnected routing output falls through, and is a warning

Status: proposed (implemented as proposed in task 2.2; review with that PR) · Date: 2026-11-13

## Context

Architecture §3.1 lists this validation rule: "every non-terminal port of a routing card is connected or marked 'falls through'". The contracts have no such marker. `card.ts` instead defines the behaviour directly. For a Condition card: "If none match, execution continues with the next card". For an AI condition card: "no match continues". Capture options (`routeByOption`) have no stated behaviour.

So `validateDefinition` cannot check for a marker that does not exist, and an error would block publishing bots that do exactly what the card documentation says.

## Options

1. **Add `fallsThrough: boolean` to each branch and capture option** and keep the rule an error unless the output is connected or marked. This is explicit, but it is a contract change with a definition migration (§3), and it adds a setting to every branch.
2. **No marker. An unconnected routing output falls through to the next card, and validation reports a warning** (`routing_port_unconnected`) that says so and does not block publishing. The behaviour is the same as option 1 with the marker always on.
3. **No marker; an unconnected output is an error.** This contradicts `card.ts` and blocks valid bots.

## Recommendation

Option 2. It matches the card contracts as written, needs no migration, and still tells the builder about every unconnected output in the Issues panel. If builders ask to silence the warning for one output, add the marker then (option 1) with its migration.

Architecture §3.1 would then read: "every non-terminal port of a routing card is connected, or it falls through to the next card (warning)".

## Consequences

- Unconnected branch and option outputs appear as warnings, and publishing goes ahead.
- The engine (4.3) implements "no matching connected branch → next card" for Condition, AI condition and Capture with `routeByOption`.
- Capture's `failed` output and the `error` and `not_found` outputs are not routing outputs. When unconnected they follow error resolution (§4.4), or simply continue for `not_found`, and they produce no warning.
