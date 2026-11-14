# ADR-033 — Glass on floating surfaces, interaction motion and a live run path

Status: proposed; asked for by Eyad in chat on 2026-11-14 (review with the `ui-glass-motion` PR) · Date: 2026-11-14

## Context

After testing the deployed Studio, Eyad said the dashboard still does not feel good enough and asked
for "a bit of glass effect", animation when a button is pressed and when a card opens, and cards with
some glass or 3D feel while something runs.

The design system forbids most of that in so many words (docs/05 §1 "Never: gradients, glows, blurred
glass…", §2.5 "Overlay scrim … no blur", §2.6 "No looping animation anywhere except…", checklist
items 2 and 9). Changing those rules needs an ADR (CLAUDE.md §3).

The rules exist for real reasons: the Studio is a dense tool used for hours, glass behind text lowers
contrast, and motion that answers no question is noise. The request is also real: the current surfaces
are flat enough that nothing tells the builder what floats, what was pressed, or what is running.

## Options

1. **Keep the rules.** Lowest risk, but it ignores the owner's direct feedback on the product's look.
2. **Glass and motion everywhere** (every panel blurred, every card tilting, ambient animation).
   Rejected: it hurts reading Arabic content in the inspector and the emulator, costs GPU on a
   300-node canvas, and makes nothing stand out because everything does.
3. **Bounded glass and purposeful motion** (this ADR): glass only where something floats above
   content; motion only on press, open, hover-lift and a running path; all values as tokens; reduced
   motion and reduced transparency both honoured.

## Decision

Option 3.

**Glass.** A floating surface (canvas toolbar and zoom, minimap, menus and pickers, popovers, the
shortcut sheet, dialogs, the top bar) uses `--glass-surface` (the surface colour at 72–80% opacity),
`backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`, a hairline border
`--glass-border` and a 1 px inner top highlight `--glass-highlight`. Docked panels that hold editable
content (inspector, node library, settings forms, transcript) stay opaque: text contrast there is
measured against a known colour. `@media (prefers-reduced-transparency: reduce)` and browsers without
`backdrop-filter` fall back to the opaque surface. Dialog scrims get a light blur
(`--scrim-blur`).

**Ambient backdrop.** The app background gets two very low-chroma accent radial tints
(`--ambient-a/b/c`), so glass has something to show and dark mode is not flat black. It is the one gradient
allowed, it is never behind text inside a surface, and it does not move.

**Depth on cards.** Canvas nodes lift on hover (`--lift` translate and `--shadow-lift`); the selected
node gets an accent halo (`--shadow-halo`) in addition to the existing outline. Rows in workspace
tables lift their background on hover. Bot rows' icon tiles tilt in 3D toward the pointer, at most
`tilt.max` degrees, only on hover and only on fine pointers.

**Press and open.** Every button and clickable tile scales to `press.scale` while pressed
(`duration.instant`). Dialogs and the command palette enter with `spring.gentle` from
`pop.scale` plus the existing travel. Pages fade and rise on route change (`spring.smooth`). Table
rows and node library items enter with `stagger.list`.

**Running.** While the run overlay is visible, the transitions the last test followed show a flowing
dash (`--run-dash`, one cycle per `run.loop` seconds), and the nodes it passed through get a
one-time light sweep around their border. The flowing dash is a second permitted loop (with the typing
indicator) because it answers "is it working, and which way did it go?". Reduced motion: static
dash, no sweep.

All numbers live in `tokens.css` (CSS) and `motion.ts` (Motion); components only reference them.
`glow` stays forbidden as decoration; the halo is the selection state, not decoration.

## Consequences

- docs/05 §1 (Never list), §2.5, §2.6 and checklist items 2 and 9 are updated in the same PR to point
  at this ADR.
- Every screenshot baseline changes once.
- `backdrop-filter` costs GPU; the canvas has at most four glass surfaces over it, and none of them is
  a node, so the 300-node budget is unaffected (nodes are opaque).
- If Eyad rejects any part, each effect is one class in `packages/ui/src/effects.css`, so removing it is
  local.
