# ADR-045 — Resolve the Studio surface rules before release

Status: proposed · Date: 2026-11-15 · Tasks: 0.8, 8.6 visual review

## Context

The current executor instructions prohibit gradients, glass blur and shadows on surfaces that do
not float. ADR-033 is still marked proposed, while docs/05 and the running UI already refer to its
ambient backdrop and glass effects. `packages/ui/src/effects.css` also applies blur and a node
shadow to `.wk-panel`, including the non-floating provider table on Settings → Models. Even the
bounded-glass option in ADR-033 says editable docked content should remain opaque.

The task 8.6 review found this mismatch in actual light/dark screenshots at 1280 and 1440 widths.
It cannot truthfully pass checklist items 2 and 9 under the current executor instructions. This
proposal records the conflict instead of silently changing the design or approving the inherited
visual effects on the owner's behalf.

## Options

1. Restore flat surfaces as required by the current instructions: opaque backgrounds, hairlines,
   no ambient gradients, no backdrop blur, and shadows only on floating overlays. Keep existing
   token-based interaction motion and its reduced-motion behavior.
2. Explicitly approve ADR-033's bounded-glass design, amend the executor instructions accordingly,
   and remove the extra blur/shadow on non-floating `.wk-panel` surfaces. This retains an ambient
   backdrop and glass only on the floating surfaces named in that ADR.

## Recommendation

Choose option 1. Implement it as a separate shared-surface correction, update docs/05 to remove the
unapproved exceptions, and mark ADR-033 superseded. Keep token values intact; remove their forbidden
applications from the shared effects classes. Retake every affected screen, inspect both themes,
widths and Arabic states, and commit new baselines with evidence. Task 8.6's backend checks may
continue while this decision is pending, but its visual review must keep the inherited failures open.

## Consequences

The correction affects the entire Studio, so changing only the Models table would hide a global
rule conflict. A complete shared-surface screenshot review is required. The retrieval algorithm,
contracts, tenant boundaries and production isolation requirements do not change.
