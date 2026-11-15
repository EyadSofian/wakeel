# Design review — node editing and the missing card forms (after 6.9)

Screens: canvas (node-actions, card-run-workflow, card-ai-condition, card-generate, card-generate-rtl, card-extract, card-handoff, card-handoff-rtl; card-ask and picker re-shot because the card header changed) · light + dark · 1440, 1280. The Studio was also tried by hand in the browser pane against the local dev stack, at a 1024 px window, which is where passes 1's findings 13, 14 and 15 came from.

Motion: no new values. The pan to a node added from the library uses `duration.slower`, as `F8` focus and fit do; the node menu uses its existing `enterTransition`.

Not in this review: Search knowledge, Table and Set timeout still have no form ("This card's settings are not editable here yet"); they arrive with phases 8 and 9. The Model field shows "Bot default" only in the shots, because the mock api lists no keyed provider.

## Pass 1

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Accent use | pass | Accent only on the selected node, the switch that is on, the active rail item and Publish; Delete in the node menu uses the error colour, not the accent |
| 2 | Gradients, glows, decoration | pass | None; the AI cards use the `ai` category tile like the Autonomous node |
| 3 | Status colours | pass | card-extract: the schema field turns red only for invalid JSON (tried by hand), not on open |
| 4 | Dark hierarchy | pass | card-ai-condition-dark: option boxes are hairline on surface, fields one step darker, same steps as light |
| 5 | Weights, sizes, caps | pass | Field labels medium small, help small tertiary, card title `text-title`; no caps |
| 6 | Sentence case | pass | "Text to read", "Save the text to", "Also send it to the user", "Variables to include", "Duplicate node" |
| 7 | Truncation and overlap | fail | card-ask-1280: the new two-span header shrank both spans, so the node name read "Greet…" |
| 8 | Radii | pass | Fields and buttons 8, option boxes 8 as in Condition, the node menu 10 |
| 9 | Shadows | pass | Only the node menu (floating) has one |
| 10 | Spacing | pass | Fields 24 apart, as in the other card forms; Duplicate and Delete node 16 apart under a hairline |
| 11 | Identical card grids | pass | Options, inputs and included variables are lists |
| 12 | One icon set | pass | Lucide at 1.75: Copy, Trash2, Sparkles, GitFork, ScanText, UserRound, Workflow |
| 13 | Selection and primary action | fail | By hand: a Standard node added from the library landed half under the inspector, so the selected node was not visible |
| 14 | Empty space | fail | Same cause: the canvas panned to the centre of its width before the inspector opened, leaving empty canvas on the left |
| 15 | RTL fixtures | fail | By hand: the card header joined "Standard node · " and an Arabic summary in one string, so it showed the summary's end first ("ومهذب بالعامية المصرية…") |
| 16 | Names and errors | fail | Run workflow help said "An expression of type string" where §3 and the Variables screen say "Text"; card names match §3.1 ("Run workflow", "Hand off to a person") |
| 17 | States | pass | Run workflow: "Check order takes no inputs." and "…returns nothing." as designed empty lines; missing workflow says what happened and how to fix it |
| 18 | Focus ring | pass | No focus state added; fields use the shared focus border |
| 19 | Beside Linear or Figma | fail | card-handoff: "Message type" was a dropdown with a single choice, Text |

Fixes made:
- 7: the node name keeps its width up to half the line (`max-w-1/2 shrink-0`); only the summary truncates.
- 13, 14: the pan waits for the inspector to narrow the canvas, reads the canvas size from the DOM (xyflow learns it later), and only pans when the node is not already in view.
- 15: name and summary are separate `dir="auto"` spans, so an Arabic summary starts at its beginning and its ellipsis falls at its end.
- 16: input help reads "Required · Text", using the Variables screen's type labels.
- 19: the handoff message offers every message type the contract allows, so the picker means something.

## Pass 2

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Accent use | pass | Unchanged from pass 1 |
| 2 | Gradients, glows, decoration | pass | Unchanged |
| 3 | Status colours | pass | Unchanged |
| 4 | Dark hierarchy | pass | card-handoff-rtl-dark: preview bubble, fields and switch keep the light theme's steps |
| 5 | Weights, sizes, caps | pass | Unchanged |
| 6 | Sentence case | pass | Unchanged |
| 7 | Truncation and overlap | pass | card-ask-light-1280: "Greeting · What can I help you with …" |
| 8 | Radii | pass | Unchanged |
| 9 | Shadows | pass | Unchanged |
| 10 | Spacing | pass | Unchanged |
| 11 | Identical card grids | pass | Unchanged |
| 12 | One icon set | pass | Unchanged |
| 13 | Selection and primary action | pass | By hand at 1024 px: the added node sits whole in the canvas beside the inspector, selected |
| 14 | Empty space | pass | Same check: the node is centred in the visible canvas, not the canvas plus the inspector |
| 15 | RTL fixtures | pass | card-generate-rtl-light-1280: "ترحيب · اكتب رد قصير ومهذب بالعامية الم…"; Arabic instructions wrap right to left with `{{conversation.orderNumber}}` kept whole |
| 16 | Names and errors | pass | "Required · Text"; invalid schema says "This is not valid JSON." and "Check the quotes, commas and brackets." |
| 17 | States | pass | Unchanged |
| 18 | Focus ring | pass | Unchanged |
| 19 | Beside Linear or Figma | pass | The node menu's Delete row: error colour on both icon and label, last, with its shortcut; nothing else stands out on the second pass |

Result: pass (all 19) on pass 2.
