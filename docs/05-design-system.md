# 05 — Design system

Normative for everything in `apps/studio` and `packages/ui`. The bar: a pro tool that looks designed by people who use it eight hours a day. Calm surface, dense information, motion only where it explains something.

Botpress Studio is the functional reference. Its branding, colours, icons and layouts are **not** to be copied. Dify's layout is legally off limits (see `01-research-report.md` §5).

## 1. Principles

1. **Quiet chrome, coloured nodes.** Hierarchy in the chrome comes from weight, size and spacing on neutral surfaces. The accent is reserved for what is selected, what has focus, the one primary action, and links. Nodes carry their category colour (ADR-017); nothing else does.
2. **Lines before shadows.** Surfaces are separated by 1 px hairlines. A shadow means "this floats above the page" and nothing else.
3. **Dense, not cramped.** 13 px base text, 28 px controls, 4 px grid. Every pixel of padding is a token.
4. **Motion answers a question.** "Where did that go?", "what changed?", "is it working?". If an animation answers none of these, remove it.
5. **Keyboard first.** Every canvas action has a shortcut and appears in the command palette. Focus is always visible.
6. **Content is bilingual.** Chrome is English and left-to-right. Anything written by a builder, a user or a model renders with `dir="auto"` and must look right in Arabic, English and both mixed.
7. **Words are plain.** Names say what a thing does. Errors say what happened and what to do.

Never: gradients, glows, blurred glass, decorative colour, emoji as icons, ALL-CAPS labels, letter-spaced eyebrow text, pulsing dots, identical rounded-card grids, a second accent colour, category colours outside nodes and the node library, drop shadows on things that do not float.

## 2. Tokens

Tokens are CSS custom properties in `packages/ui/src/tokens.css`, exposed to Tailwind 4 through `@theme`. Components use token utilities only. A lint rule rejects hex colours, `rgb()`, `oklch()` and arbitrary values (`p-[7px]`) outside `tokens.css`.

### 2.1 Colour

Cool blue-grey neutrals (hue 270–275, chroma ≤ 0.02) with an indigo accent; the dark theme is blue-black (ADR-017). Values are OKLCH; `packages/ui/src/tokens.css` is the source of truth.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-canvas` | `oklch(0.982 0.003 270)` | `oklch(0.155 0.012 275)` | Canvas, app background |
| `--bg-surface` | `oklch(1 0 0)` | `oklch(0.195 0.014 275)` | Panels, nodes, inputs, tables |
| `--bg-subtle` | `oklch(0.97 0.004 270)` | `oklch(0.225 0.016 275)` | Hover, card rows inside nodes, table header |
| `--bg-muted` | `oklch(0.945 0.006 270)` | `oklch(0.26 0.018 275)` | Pressed, counts, skeletons |
| `--border-hairline` | `oklch(0.92 0.006 270)` | `oklch(0.29 0.018 275)` | Default 1 px lines, control borders |
| `--border-strong` | `oklch(0.86 0.008 270)` | `oklch(0.37 0.02 275)` | Hovered controls and nodes |
| `--text-primary` | `oklch(0.21 0.02 275)` | `oklch(0.95 0.005 275)` | Main text |
| `--text-secondary` | `oklch(0.46 0.018 275)` | `oklch(0.75 0.014 275)` | Labels, secondary text |
| `--text-tertiary` | `oklch(0.58 0.014 275)` | `oklch(0.62 0.014 275)` | Placeholders, metadata, transitions |
| `--text-on-accent` | `oklch(1 0 0)` | `oklch(1 0 0)` | Text on the accent fill |
| `--accent` | `oklch(0.53 0.22 277)` | `oklch(0.55 0.2 277)` | Selection, focus ring, primary button, active rail item |
| `--accent-hover` | `oklch(0.48 0.22 277)` | `oklch(0.5 0.2 277)` | Primary button hover |
| `--accent-subtle` | `oklch(0.955 0.03 277)` | `oklch(0.28 0.07 277)` | Selected row, pressed tool button |
| `--accent-border` | `oklch(0.72 0.14 277)` | `oklch(0.6 0.17 277)` | Connection line while dragging |
| `--accent-text` | `oklch(0.5 0.22 277)` | `oklch(0.76 0.13 277)` | The accent used as text: links, pressed tool buttons |
| `--error` / `--error-subtle` | `oklch(0.55 0.2 27)` / `oklch(0.96 0.025 27)` | `oklch(0.7 0.17 27)` / `oklch(0.27 0.06 27)` | Errors only |
| `--warning` / `--warning-subtle` | `oklch(0.52 0.12 70)` / `oklch(0.965 0.035 85)` | `oklch(0.8 0.13 80)` / `oklch(0.28 0.05 80)` | Warnings only |
| `--success` / `--success-subtle` | `oklch(0.52 0.13 152)` / `oklch(0.96 0.03 152)` | `oklch(0.74 0.14 152)` / `oklch(0.26 0.05 152)` | Success only |

**Node categories** (ADR-017). Each category has `--cat-<c>` (icon, port, minimap), `--cat-<c>-subtle` (icon tile) and `--cat-<c>-border` (node border), light and dark.

| Category | Hue | Nodes and cards |
|---|---|---|
| `trigger` | teal 185 | Start, Entry, Trigger |
| `logic` | blue 250 | Standard node; Say, Ask, Condition, Set variable, Set timeout, Log cards |
| `ai` | violet 295 | Autonomous node; AI condition, Generate text, Extract data cards |
| `tool` | amber 60–75 | Run code, Search knowledge, Table, Call workflow cards; Note |
| `human` | rose 15 | Handoff card; Error handler |
| `flow` | slate 270 | End, Exit; End card |

Rules:
- One accent. It appears on: the selected node or edge, the focus ring, the single primary button of a view, the active tab indicator, links. Nowhere else.
- Node types are colour-coded by **category** (table above): the header icon tile, the node border, the ports and the minimap block. Category colours appear nowhere else, and never mean selection: selection is always the accent.
- Status colours appear as a 6 px dot, an icon, or text; never as a filled panel. `*-subtle` backgrounds are only for inline banners and badges.
- Contrast: `--text-primary` and `--text-secondary` on any `--bg-*` ≥ 4.5:1; `--text-tertiary` ≥ 3:1 and never used for information a user must read to proceed; `--text-on-accent` on the accent and `--accent-text` on surfaces ≥ 4.5:1; each `--cat-<c>` on its tile and on `--bg-surface` ≥ 3:1. `pnpm ui:contrast` checks every pair and fails CI below these.
- Theme follows the system by default; the user can pin light or dark. Both are first-class and both are in every screenshot review.

### 2.2 Type

**Family: IBM Plex** — Plex Sans for Latin UI, Plex Sans Arabic for Arabic content, Plex Mono for code. Licence: SIL OFL 1.1. Self-hosted WOFF2, weights 400, 500, 600 only, `font-display: swap`, Arabic subset loaded on first Arabic glyph via `unicode-range`.

Why Plex: it is one superfamily drawn to work together across Latin, Arabic and monospace, so mixed-direction content keeps a consistent weight and x-height; its slightly engineered character suits a technical tool without the default look of Inter or system UI; the Arabic cut is a true Naskh-influenced design, legible at 13–14 px, not a geometric afterthought. Two families maximum is satisfied: Sans (with its Arabic companion) and Mono.

```css
--font-sans: "IBM Plex Sans", "IBM Plex Sans Arabic", system-ui, sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, monospace;
```

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `text-micro` | 11 / 16 | 500 | Badges, port labels, key hints |
| `text-small` | 12 / 16 | 400, 500 | Metadata, table secondary cells, tooltips |
| `text-body` | 13 / 20 | 400, 500 | **Default UI text**, inputs, menus, card rows |
| `text-content` | 14 / 22 | 400 | Emulator messages, KB previews, long inspector text |
| `text-title` | 16 / 24 | 600 | Panel and dialog titles |
| `text-heading` | 20 / 28 | 600 | Page titles |
| `text-display` | 24 / 32 | 600 | Sign-in and empty-state headlines only |
| `code-small` | 12 / 18 | 400 | Inline code, trace payloads |
| `code-body` | 13 / 20 | 400 | Code editor |

Rules:
- Sentence case everywhere: "Add card", "Search knowledge". No all-caps, no tracking adjustments, no italics for emphasis.
- Three weights. 600 is for titles and the selected item; 500 for labels and buttons; 400 for everything else.
- Numbers in tables, meters and traces use `font-variant-numeric: tabular-nums`.
- Arabic content: an element whose resolved direction is RTL gets `line-height: 1.75` and `letter-spacing: 0`. Truncation uses `text-overflow: ellipsis` on a block with `dir="auto"`; never slice strings in code.
- Maximum line length for prose: 72 characters.

### 2.3 Space and size

4 px grid. `--space-0…` = `0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64`.

| Thing | Value |
|---|---|
| Control heights | 28 (compact, canvas toolbars, chips), **32 (default)**, 40 (sign-in, large actions) |
| Icon size | 16 in controls, 14 inside card rows, 20 in the left rail; icon tiles 24 / 32 / 40 |
| Icon set | Lucide, stroke 1.75, never filled, never mixed with another set |
| Row height | 32 (lists, menus, node outputs), 52 (tables), 36 (card rows on canvas) |
| Panel padding | 12 horizontal, 12 vertical; sections separated by a hairline, not by gaps |
| Left rail | 60 wide; resource panel 272; inspector 360 (resizable 320–520); emulator 380 (resizable 340–560) |
| Top bar | 52 high, full width, brand at the start |
| Content column | 1200 max, centred, 32 side padding (lists and settings) |
| Canvas node width | 288 fixed; grows in height with cards |
| Ports | 10 px dot with a 2 px surface ring, 26 px hit area |
| Canvas grid | 16 px dots at 20% of `--text-tertiary`; snap to 8 |
| Hit target | ≥ 24 × 24 for anything clickable |

### 2.4 Radius

A hierarchy, so shapes signal what a thing is.

| Token | px | Applies to |
|---|---|---|
| `--radius-xs` | 4 | Keycaps, counts |
| `--radius-sm` | 8 | Buttons, inputs, selects, card rows inside a node, icon tiles (32) |
| `--radius-md` | 10 | Toolbars, rail items, banners, popovers, menus |
| `--radius-lg` | 14 | Canvas nodes, tables, panels, the minimap |
| `--radius-xl` | 18 | Dialogs, command palette |
| `--radius-full` | 999 | Avatars, switch tracks, status dots, badges, filter chips. Nothing else. |

Panels docked to the window edge have radius 0.

### 2.5 Elevation

| Level | Token | Value (light) | Used by |
|---|---|---|---|
| 0 | — | hairline border only | Everything docked: panels, inputs, tables |
| 0.5 | `--shadow-node` | `0 1px 2px …/0.05, 0 2px 8px -2px …/0.06` (light); none (dark) | Canvas nodes: objects that can be picked up |
| 1 | `--shadow-pop` | `0 4px 12px -2px oklch(0 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.04)` + hairline | Menus, popovers, tooltips, toasts |
| 2 | `--shadow-drag` | `0 10px 24px -6px oklch(0 0 0 / 0.14)` | A node or card while it is being dragged |
| 3 | `--shadow-modal` | `0 20px 48px -12px oklch(0 0 0 / 0.20)` + hairline | Dialogs, command palette |

Dark theme: same offsets with alpha 0.4 / 0.5 / 0.6 and `--border-strong` instead of the hairline. Overlay scrim: `oklch(0 0 0 / 0.32)` light, `/ 0.5` dark; no blur.

### 2.6 Motion

Library: Motion (`motion/react`). All values come from `packages/ui/src/motion.ts`; components never write numbers.

| Token | Definition | Use |
|---|---|---|
| `duration.instant` | 80 ms | Colour and opacity on hover or press |
| `duration.fast` | 120 ms | Tooltips, menu open, focus ring |
| `duration.base` | 160 ms | Popovers, tab indicator, card insert |
| `duration.slow` | 200 ms | Panels, inspector content swap |
| `duration.slower` | 240 ms | Dialogs, node add and remove |
| `spring.snappy` | `{ type: "spring", visualDuration: 0.12, bounce: 0 }` | Small things that follow the pointer: reorder, toggle, port snap |
| `spring.smooth` | `{ type: "spring", visualDuration: 0.18, bounce: 0.06 }` | Layout changes: node height, panel width, list reflow |
| `spring.gentle` | `{ type: "spring", visualDuration: 0.24, bounce: 0.10 }` | Entrances that travel: node add, dialog, palette |
| `ease.out` | `cubic-bezier(0.2, 0, 0, 1)` | Opacity and colour (non-spring) |
| `stagger.list` | 24 ms per item, max 8 items | Trace steps, emulator message groups |

Rules:
- Bounce never exceeds 0.10. Nothing overshoots visibly.
- Enter = fade + 4–8 px travel from the direction it came from. Exit = fade only, at 0.75× the enter duration.
- Only `transform` and `opacity` animate. Layout animation uses Motion `layout` on the smallest subtree that changed.
- No animation runs during canvas pan or zoom. No looping animation anywhere except the three-dot typing indicator and a determinate progress bar.
- `prefers-reduced-motion: reduce`: all springs and travel are replaced by an 80 ms opacity change; pan inertia is off; trace playback jumps step to step; the typing indicator is static text "Typing…". `useMotionTokens()` returns the reduced set; components do not check the media query themselves.

### 2.7 Focus

A 2 px `--accent` outline with 2 px offset on `:focus-visible`, on every interactive element, including canvas nodes, cards, ports and edges. Never removed, never replaced by a colour change alone.

## 3. Vocabulary and copy

### 3.1 Names

| Concept | UI name | Never say |
|---|---|---|
| Workflow / node / card | Workflow / Node / Card | flow, block, step (reserved for traces) |
| Standard node / Autonomous node | Standard node / Autonomous node | deterministic, LLMz, agent node |
| Edge | Transition | edge, link, connection (reserved for Bridge) |
| Port | Output | port, handle, pin |
| Bridge connection | Connection | integration, channel |
| Span | Step | span, event |
| Turn | Turn | execution, run (reserved for evals) |
| Config variable | Secret (when secret) / Setting | env var |
| Publish / version | Publish / Version | deploy, release, build |
| Handoff | Hand off to a person | escalate, HITL |
| Trace | Trace | log (logs are the `Log` card output) |

Card names in the add menu: Send message · Ask · Condition · AI condition · Set variable · Run code · Search knowledge · Table · Run workflow · Generate text · Extract data · Hand off to a person · End conversation · Set timeout · Log.

### 3.2 Actions

One verb per action, everywhere: **Add** (create inside something), **New** (create a top-level thing), **Delete** (permanent), **Remove** (detach, the thing still exists), **Duplicate**, **Rename**, **Publish**, **Restore** (bring a version back), **Run** (evals), **Send** (emulator), **Save** is never a button (autosave) except in dialogs that create something.

Buttons are verbs or verb + noun: "Add card", "Publish", "Delete workflow". Never "OK", "Yes", "Submit".

### 3.3 Errors and empty states

- Error text comes from `errors.ts`: a title that says what happened and a fix that says what to do. Shown together. Technical detail goes behind "Details".
- Destructive confirmations name the thing and the consequence: "Delete workflow "Refunds"? 3 nodes in other workflows call it and will stop working." Buttons: "Delete workflow" / "Cancel".
- Empty states: one sentence on what goes here, one primary action. No illustration.
- No exclamation marks. No "Oops". No "successfully". A toast says "Published version 12", not "Successfully published!".

## 4. Components

All in `packages/ui`. Behaviour from Radix where a primitive exists; appearance ours. Every component has: default, hover, focus-visible, pressed, disabled, and where relevant loading, error, selected, read-only states, in both themes, visible on the gallery route `/__gallery`.

**Primitives** — Button (primary, secondary, ghost, danger; 24/28/32), IconButton (with required `aria-label` and tooltip), Input, Textarea (auto-grow), Select, Combobox, Checkbox, Switch, RadioGroup, SegmentedControl, Slider, Tabs, Tooltip (delay 400 ms, shows shortcut), Popover, Menu, ContextMenu, Dialog, Sheet, Toast, Badge, Tag, Kbd, Avatar, Skeleton, Spinner (only for < 1 s indeterminate waits; otherwise Skeleton or progress), ProgressBar, Banner (inline status), EmptyState, Separator, ScrollArea, ResizeHandle.

**Data** — DataTable (sticky header, 32 px rows, column resize, keyboard cell navigation, virtualised over 100 rows), Tree (workflows, KB sources), List, KeyValue, StatTile (number + label + delta; no chart junk), Sparkline, TokenMeter, SizeMeter (state size per variable).

**Editors** — CodeEditor (Monaco; theme built from tokens; generated typings), ExpressionInput (single line, monospace, variable autocomplete, inline error), TemplateInput (multi-line, `dir="auto"`, `{{` opens variable autocomplete, placeholders rendered as chips), VariablePicker, ModelPicker (shows support level for autonomous nodes), JsonSchemaEditor (field list with types; raw JSON toggle), FilterBuilder (table filters), MessageEditor (one form per message type, live preview bubble), CronPicker (re-crawl schedule).

**Canvas** — NodeShell (header: icon, name, menu; body: card rows; outputs on the right edge), CardRow (icon, one-line summary, output dot when the card has outputs, issue marker), OutputDot (8 px; 16 px hit area; grows to 12 px when a connection is being dragged near), TransitionPath (smooth-step, 1.5 px, arrowhead; label chip for named outputs), ConnectionLine, SelectionBox, NodeAddMenu, CanvasToolbar (zoom, fit, undo, redo, tidy), MiniMap (bottom-right, toggle with `M`), NoteNode, IssueMarker, RunOverlay (path taken by the last emulator turn).

**Conversation** — MessageBubble (all message types; `dir="auto"`; citations as numbered chips), Composer, TypingIndicator, QuickReplies, TranscriptList, HandoffBanner.

**Trace** — TraceTimeline (vertical list of steps with duration bars), StepRow (icon, name, duration, tokens, status), PayloadViewer (tabs: Prompt, Code, Input, Output; JSON tree, code view, diff for variable changes), PlaybackControls (play, step, speed), CostBadge.

**Shell** — AppShell, LeftRail, TopBar (breadcrumb, save indicator, issues count, Publish), ResourcePanel, Inspector (Section, Field, FieldRow, inline help), CommandPalette, IssuesPanel, SaveIndicator ("Saved", "Saving…", "Offline — changes kept locally"), ShortcutSheet.

## 5. Screens

Wireframes show structure and density, not final pixels. `│` and `─` are hairlines.

### 5.1 Studio canvas (the main screen)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▣ Botbress │ Engosoft / Store assistant / Main [Draft]        ✓ Saved  ⓘ2 ⚠1 │ [▷ Test] [Publish] │ 52
├────┬─────────────────┬──────────────────────────────────────────────────────┬───────────────────────┤
│ ⌂  │ Nodes  Workflows│            [ ↖ ✋ │ ↶ ↷ │ ⤢ ▦ ]                       │ ✦ Order assistant   × │
│ ── │ ┌ Search nodes ┐│  · · · · · · · · · · · · · · · · · · · · · · · · · ·   │   Autonomous · 2 exits│
│ ▣  │ (All)(Triggers) │  ┌[▷] Start ─────────┐    ┌[▤] Greeting ──────────┐     │ Configure  Issues     │
│ ◫  │ (Logic)(AI)     │  │ The conversation… │    │   Standard · 3 cards  │     │ Name                  │
│ ▤  │ ▾ Triggers   1  │  │             next ●──────▶ ✉ Welcome to …       │     │ [Order assistant    ] │
│ {} │  [⚡] Trigger    │  └───────────────────┘    │ ⑂ Order · Shipping     │     │ Instructions          │
│ ⟲  │ ▾ Logic      1  │                           │            Order ●─────┼──▶  │ [Help the customer…  ]│
│ ✓  │  [▤] Standard   │                           └────────────────────────┘     │ Temperature ──●── 0.3 │
│ ≡  │ ▾ AI         1  │                                                          │ Steps per turn [6]    │
│    │  [✦] Autonomous │  [− 68% +]                                    ┌minimap┐  │ Talks with the user ◉ │
│ ⚙  │ ▾ Flow       2  │                                               └───────┘  │                       │
└────┴─────────────────┴──────────────────────────────────────────────────────────┴───────────────────────┘
  60        272                               fluid                                         360
```

- **Top bar** (full width): brand mark and name; breadcrumb (workspace / bot / workflow) with a Draft badge; save state with its icon; the issue count; Test (secondary) and Publish (the view's one primary button).
- **Rail**: Home, a hairline, then Workflows, Knowledge, Tables, Variables, Versions, Evals, Conversations, Connections (ADR-030); Settings at the bottom. The active item is a filled accent tile; the rest are quiet icons with tooltips.
- **Node library** (resource panel): tabs Nodes and Workflows. Nodes has a search field, filter chips (All, Triggers, Logic, AI, Flow) and collapsible groups with counts; each entry is a category icon tile, the node's name and one line on what it does. Click adds the node at the canvas centre; dragging drops it where it lands; either way the new node is selected. Entries only valid in some workflow kinds (Exit, Error handler) appear only there.
- **Nodes**: a header with the category icon tile, the name (bold, kept next to the icon whatever its direction) and a one-line subtitle (type and the count that matters: cards, or exits and tools); a hairline; card rows as inset pills on `--bg-subtle` with a category-coloured icon; outputs as right-aligned labels with a category-coloured port on the node's end edge. Transitions enter at a port on the header's start edge. The border is the category border colour; a node with an error has an error border; the selected node has an accent border and a 2 px accent outline.
- **Transitions**: bezier curves, 1.5 px `--text-tertiary` with an arrowhead; selected: 2 px accent.
- **Toolbars** float: tools (Select `V`, Pan `H`), undo, redo, fit and minimap at the top centre; zoom at the bottom start. The minimap sits at the bottom end, its blocks in category colours.
- **Inspector**: docked on the end side while exactly one node is selected (`Esc` closes it). Header with a 40 px icon tile, name and subtitle; tabs Configure and Issues. Edits commit on blur, so one edit is one undo step.
- Issues: a marker on the card or node, an error border, and a count in the top bar that opens the Issues panel.

**Interaction**

| Action | Pointer | Keyboard |
|---|---|---|
| Pan | Space-drag, middle-drag, two-finger scroll | Arrow keys with nothing selected |
| Zoom | Pinch, Ctrl/⌘-scroll | `⌘+` `⌘−` `⌘0` (fit) `⌘1` (100%) |
| Select | Click; drag on empty canvas for a box; Shift-click adds | `Tab` / `Shift+Tab` cycle nodes; arrows move to the nearest node in that direction; `Enter` enters a node to select cards; `Esc` goes up one level |
| Add node | Double-click canvas; drag from an output into empty space | `N` (at pointer or viewport centre) |
| Add card | "+ Add card" at the bottom of a node | `C` with a node selected; `/` inside a node opens the card menu filtered as you type |
| Connect | Drag from an output to a node | With an output focused: `Enter`, arrows to choose a target, `Enter` to confirm |
| Reconnect | Drag either end of a transition | Select transition, `R`, choose a target |
| Reorder cards | Drag the row | `Alt+↑` / `Alt+↓` |
| Move node | Drag header | `Shift+arrows` (8 px), `Shift+Alt+arrows` (1 px) |
| Duplicate / Delete | Context menu | `⌘D` / `Backspace` |
| Copy / Paste | Context menu | `⌘C` / `⌘V` (pastes at pointer; across workflows and bots) |
| Undo / Redo | Toolbar | `⌘Z` / `⇧⌘Z` |
| Rename | Double-click the name | `F2` or `Enter` on a selected node header |
| Tidy layout | Toolbar | `⇧⌘L` |
| Run from here | Node menu | `⌘Enter` with a node selected |
| Command palette | Top bar | `⌘K` |
| Search in bot | — | `⌘F` (nodes, cards, text, variables) |
| Shortcut sheet | — | `?` |

Clarifications from task 2.5 (no change to the table):
- **`Enter` on a node** goes inside it (to its cards and outputs) when it has any; on a node with none it renames. `F2` always renames.
- **Inside a node** the cursor walks cards and outputs in drawing order. `Enter` on an output starts keyboard connect; on an output that already has a transition it re-points that transition, so `R` is only needed for a transition selected with the pointer. While connecting, a hint bar at the bottom of the canvas shows the keys.
- **Adding a card** that writes a value (Ask, Set variable) also creates a workflow variable for it (`answer`, `value`, then `answer_2`…) in the same undo step. Cards that need a knowledge base, a table or a sub-workflow stay in the menu, dimmed, saying what to create first.
- **Copy and paste** carry the nodes, the transitions between them, their positions and the workflow variables their cards use. Every element id is replaced on paste; references to things outside (bot variables, workflows, knowledge bases, tables) are kept and validated where they land. Start and Entry are never copied.
- **A transition can be dropped anywhere on a node**, not only on its input port; released over empty canvas it opens the add-node menu, and the new node is wired from that output in one undo step.

**Motion**

| Moment | Spec |
|---|---|
| Node add | Scale 0.96 → 1 and opacity 0 → 1, `spring.gentle`; if created by dragging from an output, the transition draws from the source in the same 240 ms |
| Node remove | Opacity → 0 and scale → 0.98 in 120 ms; attached transitions fade with it; nothing else moves |
| Card insert / remove | Node height animates with `spring.smooth` (Motion `layout` on that node only); the new row fades in over the last 80 ms; outputs below slide with the layout |
| Card reorder | Dragged row lifts to `--shadow-drag`; other rows shift with `spring.snappy`; on drop the row settles with `spring.snappy`. Transitions attached to moved outputs re-route in the same frame (no separate animation) |
| Transition drawing | Line follows the pointer with no easing. Valid targets within 24 px show their left edge in `--accent-border`; on release the end snaps with `spring.snappy`. An invalid release retracts the line to its source in 120 ms |
| Reconnect | Grabbed end detaches at once and follows the pointer; the old target's highlight fades in 80 ms; drop as above |
| Selection | Border colour to `--accent-border` and header tint to `--accent-subtle` in 80 ms. No scale, no glow |
| Pan and zoom | Direct manipulation, no easing while the input is active. After a flick, velocity decays with friction 0.92 per frame for at most 400 ms. Keyboard zoom animates to the target scale in 160 ms |
| Zoom below 50% | Nodes cross-fade (120 ms) to a compact form: header only plus a card count |
| Fit view, jump to node | Viewport animates in 240 ms `ease.out`; the target node's border flashes `--accent-border` once for 600 ms |
| Run overlay | After an emulator turn, the transitions and cards that ran are tinted `--accent-border`; visited cards get a small check. Clears on the next edit |

**Performance budget** (CI test with a 300-node, 450-transition fixture on a mid-range laptop profile): pan and zoom ≥ 55 fps average with no frame over 32 ms; selection response < 50 ms; adding a card < 100 ms to next paint; opening the workflow < 800 ms to interactive.

### 5.2 Inspector

```
┌───────────────────────────────────┐
│ ✦ Assistant                    ⋯  │  node name (editable), type icon, menu
│ Autonomous node                   │
├───────────────────────────────────┤
│ Instructions                    ⤢ │  TemplateInput, 8 rows, expands to a full editor
│ ┌───────────────────────────────┐ │
│ │ You help Engosoft students…   │ │
│ └───────────────────────────────┘ │
├───────────────────────────────────┤
│ Tools                           + │
│  ƒ searchDocs    Search knowledge │
│  ▦ orders        Table · find,get │
│  ↳ bookLesson    Workflow         │
├───────────────────────────────────┤
│ Variables                       + │
│  workflow.email          Write ▾  │
│  conversation.language   Read  ▾  │
├───────────────────────────────────┤
│ Exits                           + │
│  resolved        → End            │
│  needs_refund    → Refunds        │
├───────────────────────────────────┤
│ ▸ Advanced                        │  model, temperature, attempts, message types
└───────────────────────────────────┘
```

- Sections are separated by hairlines and can collapse; collapsed state is remembered per node type.
- Every field validates as you type; an invalid field shows the fix sentence under it.
- Selecting a tool, exit or card pushes a sub-view in the same panel with a back arrow (slides 12 px + fade, `duration.slow`); `Esc` goes back.
- Changing selection swaps inspector content with a 120 ms cross-fade; the panel itself never moves.
- "Run code" and code tools open the code editor as a bottom drawer over the canvas (60% height, resizable, `⌘Enter` runs with the last emulator scope, `Esc` closes). The drawer slides up with `spring.smooth`.

### 5.3 Emulator and trace

```
┌ Inspector │ Emulator ───────────── ⟲ ┐
│ Testing draft · as “Test user” ▾     │
├──────────────────────────────────────┤
│                    عايز أعرف حالة طلبي │  user bubble, start-aligned by direction
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ أكيد. ممكن رقم الطلب؟             │ │  bot bubble
│ └──────────────────────────────────┘ │
│   Assistant · 1.8 s · 1,420 tokens ▸ │  turn footer; click opens the trace
│                                5678  │
│ ┌──────────────────────────────────┐ │
│ │ طلبك رقم 5678 اتشحن امبارح ¹      │ │
│ └──────────────────────────────────┘ │
│  [ Track it ]  [ That's all ]        │
├──────────────────────────────────────┤
│ ▾ Trace · turn 2            ▶ 1×  ⏭ │
│ ● Assistant                  1.82 s  │
│ ├ ◇ Thinking            ▮▮▮   0.9 s  │
│ ├ ƒ orders.find          ▮    0.1 s  │
│ ├ ◇ Reply               ▮▮    0.7 s  │
│ └ ✓ Waiting for the user             │
├──────────────────────────────────────┤
│ Message…                          ↵  │
└──────────────────────────────────────┘
```

- The emulator is a Bridge client in `emulator` mode streaming over SSE. It never bills a conversation.
- "as Test user" opens a small form for user data (name, locale, attributes) and a reset.
- A third tab inside the trace area, "Variables", shows current values by scope with a size meter and highlights values changed in the last turn.
- Clicking a trace step selects the matching node or card on the canvas and opens PayloadViewer (prompt, generated code, tool input and output, tokens, cost).
- Errors render as an inline banner in the transcript: title, fix, "Show in trace".

**Motion**

| Moment | Spec |
|---|---|
| User message send | Bubble rises 8 px + fades in, `spring.snappy`; composer clears at once |
| Typing | Three dots, 1.2 s loop, opacity only. Appears if no content has arrived 300 ms after the turn starts |
| Bot message stream | Text appears as it arrives in word-sized chunks, no per-character animation; the bubble's height follows with `spring.smooth`. Choice buttons fade in (120 ms) after the text completes |
| Trace, live | Each step row appears when its span starts (fade + 4 px, 120 ms). Its duration bar grows in real time. On completion the status icon swaps with an 80 ms cross-fade |
| Trace playback | ▶ replays a finished turn: steps reveal in order, spaced by their real durations scaled to a 4 s total (speed 0.5×, 1×, 2×). The active step is highlighted in the list **and** on the canvas (card tint + the transition into it drawn in `--accent-border` over 200 ms). "Thinking → tool call → reply" therefore reads as movement across the node. ⏭ steps manually |
| Auto-scroll | Sticks to the bottom only if the user was at the bottom; otherwise a "New messages" chip appears |

### 5.4 Workspace home

```
┌──┬─────────────────────────────────────────────────────────────────────────────┐
│  │ Engosoft ▾                                              ⌘K        [New bot] │
├──┼─────────────────────────────────────────────────────────────────────────────┤
│▣ │ Bots                                                         Search…        │
│◔ │ ─────────────────────────────────────────────────────────────────────────── │
│⚙ │ Name          Status       Conversations (7 d)   Last published   Updated   │
│  │ Majed         ● Live       1,284  ▁▂▃▅▃▂▄        v12 · 2 d ago    1 h ago   │
│  │ Fahad         ● Live         412  ▁▁▂▂▃▂▂        v7  · 9 d ago    3 d ago   │
│  │ HR assistant  ○ Draft          —                 —                5 min ago │
└──┴─────────────────────────────────────────────────────────────────────────────┘
```

A table, not a card grid. Row click opens the bot's canvas. Row menu: Rename, Duplicate, Export, Delete.

### 5.5 Knowledge base

```
│ Knowledge / Course catalogue                                  [Add source ▾]   │
│ Sources │ Documents │ Test search │ Settings                                   │
│ ────────────────────────────────────────────────────────────────────────────── │
│ Source                         Type      Documents   Status          Synced    │
│ engosoft.com/courses           Sitemap        148    ● Ready         2 h ago   │
│ Refund policy 2026.pdf         File             1    ⚠ Low quality   1 d ago   │
│ ────────────────────────────────────────────────────────────────────────────── │
│ Test search                                                                    │
│ ┌ سياسة استرجاع الرسوم ───────────────────────────────────────────── Search ┐ │
│ # Score  Passage                                         Document     Why      │
│ 1 0.91   يحق للمتدرب استرجاع الرسوم خلال ٧ أيام…         Refund policy  D2 L1 → 1│
│ 2 0.74   Refunds are processed within 14 working days…  FAQ           D1 L5 → 2│
```

- Documents tab: list with parse quality, tokens, language; opening one shows the parsed Markdown beside its chunks (chunk boundaries as hairlines with heading path labels). Arabic documents render right-to-left.
- "Why" shows each stage's rank (dense, lexical, reranked). Clicking opens the retrieval trace.
- Indexing progress is a determinate bar per source with stage text ("Parsing 12 of 148").

### 5.6 Tables

Spreadsheet-like DataTable. Column header menu: Rename, Type, Required, Unique, Searchable, Delete. Add row at the bottom (`⌘Enter` commits). Cell edit on `Enter` or typing. FilterBuilder above the grid. JSON cells open a small editor popover. Row count and limit in the footer. Import CSV in the menu.

### 5.7 Variables

Table grouped by scope (Bot, User, Conversation, then each workflow). Columns: Name, Type, Default, Used in (count; click lists usages and jumps to them), Sensitive. A second tab, Secrets and settings, lists config variables with separate values for Draft and Production; secret values are write-only.

### 5.8 Versions and publish

```
│ Versions                                                                       │
│ ● v12  Live      “Refund flow v2”          Eyad · 13 Nov 10:15   [Roll back ▾] │
│   v11            “Fix language capture”    Eyad · 11 Nov 16:02   Compare · Restore
│   v10  …                                                                       │
```

Publish dialog: version label (required), notes, a summary of changes since the live version (workflows added/changed/removed, counts of nodes and cards), blocking issues if any, eval status if a suite exists ("14 of 14 passed · run 5 min ago" or "Not run on this draft"). Primary button "Publish".

Compare: two-column structural diff by workflow → node → card, with changed fields highlighted; canvas moves are ignored. Rolling back asks for confirmation and states what happens to conversations in progress.

### 5.9 Conversations

Left: filterable list (date range, connection, status, has error, handed off, search by user or text). Right: transcript with the same MessageBubble components; each bot turn has the turn footer that opens the trace in a side sheet. Header shows user data and conversation status. No reply box: this is not an inbox.

### 5.10 Evals

```
│ Evals / Core flows                         Target: Draft ▾        [Run all]    │
│ ● 12 passed   ● 2 failed   ○ 0 errors      ar-EG 6/7 · ar-SA 3/3 · en 3/4      │
│ ────────────────────────────────────────────────────────────────────────────── │
│ Case                         Tags         Result    Turns   Duration           │
│ Order status, Egyptian       ar-EG, kb    ✓         3       4.1 s              │
│ Refund over limit            handoff      ✕ turn 2  4       6.8 s              │
```

Opening a case shows a script editor (turn list: what the user says, what must be true) beside the last run's transcript with a pass or fail mark on each assertion and a link to the trace. "Add case from conversation" exists on the Conversations screen.

### 5.11 Connections (Bridge)

List of connections with status and last delivery. Detail has tabs: Setup (webhook URL, subscribed events, target Draft or Production, keys with create/revoke, signing secret with rotate, a copy-ready cURL example and the signature check in three languages), Deliveries (table with status, attempts, response code; filter Dead; Replay), Test (send a test event; send a message as a user and see the response).

### 5.12 Analytics

Four StatTiles (Conversations, Handoff rate, Turns with errors, Model spend) with period selector, then two plain line charts (conversations per day; spend per day by model) and two tables (top exits and where conversations end; slowest nodes p95). Charts: 1.5 px lines, `--text-secondary` for the primary series, `--accent` only for a highlighted series, hairline axis, no fills, no gradients, tabular numerals, direct labels instead of a legend when ≤ 3 series.

### 5.13 Workspace settings

Tabs: General, Members (table; invite; role select), API keys, Models (provider keys, default and utility model), Usage (meters against quotas, hard-cap controls, daily table), Audit log.

### 5.14 Sign in

Two halves (ADR-017). Start: the brand at the top, then a 380 px column centred in the remaining height with "Sign in" in `text-display`, one line on what the product does, email, password, the large primary button and provider buttons. End: on `--bg-canvas`, a static still of what the Studio builds, a Start node joined to an Autonomous node with Arabic content, and a short Arabic test conversation. The still is markup, hidden from assistive technology, never a screenshot.

### 5.15 Command palette

```
        ┌──────────────────────────────────────────────────────┐
        │ ⌕ Type a command or search…                          │
        ├──────────────────────────────────────────────────────┤
        │ Actions                                              │
        │   Add node                                        N  │
        │   Add card                                        C  │
        │   Publish                                      ⇧⌘P  │
        │ Go to                                                │
        │   Refunds                                  Workflow  │
        │   Greet › Choose language                      Card  │
        └──────────────────────────────────────────────────────┘
```

640 px wide, top at 20% of the viewport, `--radius-lg`, `--shadow-modal`. Opens with `spring.gentle` (scale 0.98 → 1, fade); closes in 120 ms. Lists every action with its shortcut, every workflow, node, card, variable, KB, table and settings page. Fuzzy match; results update on each keystroke without animation; arrow keys move, `Enter` runs, `⌘Enter` opens in the inspector without leaving the palette's context.

### 5.16 Issues panel

A sheet from the right listing errors then warnings: title, fix, location. Click jumps to the node or field and focuses it. `F8` / `⇧F8` step through issues.

## 6. Right-to-left and mixed content

- Bot text fields (TemplateInput), emulator bubbles, transcripts, KB previews, table cells and trace payload strings use `dir="auto"` so direction follows the first strong character.
- Layout CSS uses logical properties (`padding-inline`, `margin-inline-start`, `inset-inline-end`, `text-align: start`). Physical left/right are lint errors outside canvas geometry.
- Variable chips inside Arabic text are isolated with `<bdi>` so `{{workflow.email}}` does not reorder the sentence.
- Monospace and code are always LTR.
- Card summaries on the canvas truncate with an ellipsis at the end of the line in the text's own direction.
- Numbers: show what the content contains; never convert digits.
- Fixture set `packages/testing/fixtures/rtl.ts` must appear in screenshots of every content surface: pure Arabic, Arabic with an English product code, English with an Arabic name, Arabic with a URL, a long unbroken token, Arabic with diacritics, and an emoji.

## 7. Accessibility

WCAG 2.1 AA. All functionality by keyboard. Canvas nodes and cards are a focusable tree with `aria-label`s that read "Greet, standard node, 3 cards, 2 outputs". Live regions announce emulator replies and save state. Colour is never the only signal (issues have icons; status dots have text). Dialogs trap focus and restore it. `axe` runs in Playwright on every screen; zero serious or critical violations.

## 8. The screenshot review loop

Mandatory for every task that changes anything visible. A task is not done until this loop ends with zero failed checks.

### 8.1 Mechanics

1. `pnpm studio:shots [--screen <id>]` runs `apps/studio/tests/shots.spec.ts` (Playwright, Chromium, device scale factor 2, reduced motion on so frames are stable). It visits every entry in `apps/studio/tests/screens.ts`:

   ```ts
   { id: "canvas", route: "/b/demo/w/main", states: ["empty", "typical", "dense-300", "selection", "issues", "rtl"], sizes: [[1440, 900], [1280, 720]] }
   ```

   Data comes from seeded fixtures through a mock API layer, so shots are deterministic.
2. Output: `apps/studio/.shots/<screen>/<state>-<theme>-<width>.png` for light and dark.
3. The executor **opens the PNG files and looks at them** (Read tool on the image). Reading the DOM or trusting the test result is not a review.
4. The executor writes `docs/design-reviews/<task-id>.md` using the template below, fixes every failed check, re-shoots, and repeats.
5. When the review passes, `pnpm studio:shots --update` refreshes the visual-regression baselines (`toHaveScreenshot`, 0.1% threshold) and they are committed.
6. Motion is reviewed separately: `pnpm studio:motion --screen <id>` records a short video of each scripted interaction (node add, card reorder, connect, panel swap, emulator stream, trace playback) at normal and reduced motion. The executor extracts frames at 0, 25, 50, 75 and 100% and checks them against the motion tables above.

### 8.2 Checklist (answer each with pass or fail and one sentence of evidence)

Colour
1. Is the accent used only for selection, focus, the single primary action, active tab, active rail item or links? Are category colours used only on nodes, ports, the minimap and the node library?
2. Is there any gradient, glow, blur, or colour used as decoration?
3. Do status colours appear only where there is a status?
4. Does the dark theme have the same hierarchy as the light one (not just inverted)?

Type
5. Are there only the three weights and the defined sizes? Any all-caps or letter-spaced label?
6. Is every label in sentence case?
7. Is anything truncated mid-word, clipped, or overlapping?

Shape and space
8. Do radii follow the hierarchy (controls 8, toolbars and popovers 10, nodes and tables 14, dialogs 18)?
9. Is any shadow on something that does not float?
10. Is all spacing on the 4 px grid, and are similar things spaced identically?
11. Is anything laid out as a grid of identical rounded cards where a table or list would be denser?
12. Are all icons from the one set, same stroke, same size within a context? Any emoji?

Density and hierarchy
13. Can you tell in one second what is selected and what the primary action is?
14. Is there empty space that carries no meaning, or is anything cramped enough to mis-click?

Content
15. Do the RTL fixtures render correctly: direction, alignment, chips, truncation, line height?
16. Does every name and button match section 3? Does every error show what happened and how to fix it?

States
17. Are empty, loading, error and long-content states all designed, not defaults?
18. Is the focus ring visible on the focused element in the shot that has focus?

Overall
19. If this screenshot were shown beside Linear or Figma, which specific element would look unconsidered? Name it and fix it. "None" is acceptable only on the second pass or later.

### 8.3 Review file template

```md
# Design review — <task id> <title>
Screens: canvas (typical, rtl, dense-300) · light + dark · 1440, 1280
Pass 1
| # | Check | Result | Evidence |
| 1 | Accent use | fail | "Add card" button is accent-filled; the view's primary action is Publish |
…
Fixes made: …
Pass 2
…
Result: pass (all 19) on pass 2
```

A review that passes everything on the first pass with no evidence sentences is rejected by the human reviewer.
