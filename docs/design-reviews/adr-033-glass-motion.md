# Design review — ADR-033 glass, interaction motion and the run path

Screens: every screen re-shot (`pnpm studio:shots --update`, 414 shots, light + dark, 1440 + 1280, RTL
states included); looked at closely: home (default, rtl), canvas (selection, default), emulator
(trace), the New bot dialog.

Motion: checked with a throwaway Playwright script against the mocked Studio at normal motion (not
committed; the numbers below are what it measured), plus frames of the dialog entrance.

| Moment | Measured |
|---|---|
| Press on New bot | computed `scale` 0.97 while held, back to 1 on release |
| Hover on the primary button | computed `translate` 0 -2px |
| Hover on a bot row | tile `transform` is a 3D matrix (≈ 7° at the top-left corner, under `tilt.max` 8) |
| Dialog open | frame at 40 ms is mid-scale and faded; at 640 ms settled; scrim blurred |
| Reduced motion | shots run with `reducedMotion: reduce`: no tilt, no rise, static run dash |

## Pass 1

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Accent use | pass | Accent only on the selected node, active rail item, active tab, Publish / New bot; the halo is the selected node's state |
| 2 | Gradients, glows, decoration | fail | home-light: the first ambient values (alpha 0.08 / 0.06) were invisible, so the glass surfaces showed nothing behind them and the change read as no change |
| 3 | Status colours | pass | Live and Draft badges unchanged |
| 4 | Dark hierarchy | pass | canvas-selection-dark: top bar and rail translucent over the tint, panels opaque, nodes keep their category borders |
| 5 | Weights, sizes, caps | pass | No type changes |
| 6 | Sentence case | pass | No copy changes |
| 7 | Truncation and overlap | pass | emulator-trace: durations stay on one line ("940 ms") |
| 8 | Radii | pass | Glass surfaces keep their radii (toolbar 10, dialog 18, table 14) |
| 9 | Shadows | pass | Lift shadow only under the pointer, halo only on the selected node, modal shadow on the dialog |
| 10 | Spacing | pass | No spacing changes |
| 11 | Identical card grids | pass | Bots stay a table |
| 12 | One icon set | pass | Unchanged |
| 13 | Selection and primary action | pass | canvas-selection: the halo makes the selected Autonomous node the first thing seen |
| 14 | Empty space | pass | Unchanged |
| 15 | RTL fixtures | pass | home-rtl and emulator-trace: Arabic names and bubbles align to the end; the tilt and rise do not change direction |
| 16 | Names and errors | pass | No copy changes |
| 17 | States | pass | Empty and error panels on home use the same glass panel as the table |
| 18 | Focus ring | pass | dialog-open: the Name field's focus ring is visible on the glass dialog |
| 19 | Weakest element | fail | home-dark: with the faint ambient the top bar's glass looked like a plain dark bar |

Fixes made: ambient raised to alpha 0.16 / 0.12 / 0.10 (light) and 0.30 / 0.20 / 0.14 (dark) with a
third, teal tint at the bottom end; re-shot.

## Pass 2

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Accent use | pass | As pass 1 |
| 2 | Gradients, glows, decoration | pass | The tint is visible behind the top bar, rail and table edge in dark and faint in light; never behind text inside a surface |
| 3 | Status colours | pass | As pass 1 |
| 4 | Dark hierarchy | pass | home-dark: table panel reads above the backdrop, header row quieter than rows |
| 5 | Weights, sizes, caps | pass | As pass 1 |
| 6 | Sentence case | pass | As pass 1 |
| 7 | Truncation and overlap | pass | As pass 1 |
| 8 | Radii | pass | As pass 1 |
| 9 | Shadows | pass | As pass 1 |
| 10 | Spacing | pass | As pass 1 |
| 11 | Identical card grids | pass | As pass 1 |
| 12 | One icon set | pass | As pass 1 |
| 13 | Selection and primary action | pass | As pass 1 |
| 14 | Empty space | pass | home: the large empty area below the table now carries the tint instead of flat black |
| 15 | RTL fixtures | pass | As pass 1 |
| 16 | Names and errors | pass | As pass 1 |
| 17 | States | pass | As pass 1 |
| 18 | Focus ring | pass | As pass 1 |
| 19 | Weakest element | pass | None on this pass; the inspector and node library stay opaque on purpose (editable content, ADR-033) |

Result: pass (all 19) on pass 2.

Not covered: no `pnpm studio:motion` recording was added for press, lift or tilt (they are CSS
transitions, not Motion animations, so the motion spec's frame seeking does not see them); the
numbers above come from computed styles. The run sweep around a node is a one-time CSS animation and
was only seen in the static reduced-motion shot.
