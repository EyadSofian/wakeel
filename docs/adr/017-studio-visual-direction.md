# ADR-017 — Studio visual direction: category-coloured nodes, node library, indigo accent

Status: accepted by Eyad in chat on 2026-11-13 (he supplied the reference design); review with the task 2.4b PR · Date: 2026-11-13

## Context

After task 2.4, Eyad reviewed the Studio and said its look was not modern and asked for a strong, professional design that is clearly different from what was there. He then sent a reference mockup of an agent builder in light and dark and said to build on that idea, and to call the product **Botbress**.

The design system as written (docs/05 §1 and §2.1) produced the plain look he rejected. Its first principle was "grey does the work": node types were explicitly *not* colour-coded, the left rail was 48 px of unlabelled icons, controls were 28 px, radii 3–12 px, and every node was the same white box. Those are normative rules, so changing them needs this ADR (CLAUDE.md §3).

What the reference establishes:

- A full-width top bar: product mark and name, breadcrumb with a Draft badge, save state, then Test and a filled Publish button.
- An icon rail whose active item is a filled accent tile, and next to it a node library: tabs, a search field, filter chips, collapsible groups with counts, each node shown as a coloured icon tile with a name and a one-line description.
- Nodes coloured by **category** (trigger, logic, AI, tool, human): a coloured icon tile in the header, a tinted border, coloured port dots; card rows as inset pills.
- A floating canvas toolbar at the top centre and zoom at the bottom start.
- An inspector on the end side with tabs.
- An indigo accent; a blue-black dark theme.

## Options

1. **Keep the design system and polish within it** (spacing, type, a labelled sidebar). Lower risk, but it keeps the rule that makes the canvas read as grey boxes, which is the thing Eyad rejected.
2. **Adopt the reference's structure and visual language, translated into tokens** (this ADR). Category colours become tokens with their own contrast checks; everything else stays token-only.
3. **Copy the reference pixel for pixel**, including its features. Rejected: the reference shows features the product thesis excludes (a native "Update CRM (Salesforce)" integration) and features that do not exist yet; we take the visual idea, not the feature list.

## Decision

Option 2.

**Colour.** Neutrals move to a cool blue-grey ramp (hue 270–275, chroma ≤ 0.02); dark is blue-black. One accent, indigo `oklch(0.53 0.22 277)` light / `oklch(0.55 0.2 277)` dark, with white text on it in both themes. A separate `--accent-text` token is the accent used as text (links, pressed tool buttons) so it reaches 4.5:1 on dark surfaces.

**Node categories** are a new, bounded colour family: `trigger` (teal), `logic` (blue), `ai` (violet), `tool` (amber), `human` (rose), `flow` (slate). Each has a strong value (icon, port, minimap), a subtle value (icon tile) and a border value (node border). They appear only on nodes, card icons, ports, the minimap and the node library — never on chrome, buttons or text. This replaces "Node types are not colour-coded" in §2.1. The accent rule is unchanged: categories are not a second accent; selection is always the indigo accent.

**Shape and size.** Controls 32 px (compact 28, large 40); table rows 52; top bar 52; rail 60; resource panel 272; node width 288. Radii xs 4 · sm 8 · md 10 · lg 14 · xl 18 (controls 8, nodes and tables 14, dialogs 18). Nodes on the canvas get `--shadow-node` in the light theme only (they are draggable objects on a surface); dark relies on borders.

**Structure.** Top bar with brand; rail with Home and the bot destinations, active item filled; node library panel on the canvas screen; inspector (Configure, Issues) for a single selected node; floating toolbars; a capped content column (1200 px) with a page header on list and settings screens; a split sign-in page whose second half is a static still of a flow and an Arabic conversation.

**Name.** `BRAND.name` is "Botbress". Headers and key prefixes keep the code name until open question #1 is closed.

## Consequences

- docs/05 §1, §2.1, §2.3, §2.4, §2.5, §5.1, §5.14 and checklist item 8 are updated in the same PR.
- `pnpm ui:contrast` now also checks text on the accent, `--accent-text` on surfaces, and every category's icon on its tile and on a node surface (3:1, WCAG 1.4.11). 58 pairs.
- Every screenshot baseline changes once.
- Test and Publish appear in the top bar, disabled with a tooltip, until the emulator (4.6) and publishing (7.1) exist.
- **Name risk.** "Botbress" differs from the Botpress trademark by one letter, in the same product category, and CLAUDE.md §9 forbids Botpress branding. I flagged this to Eyad; the name lives only in `packages/config/src/brand.ts`, so changing it is one line.
- Card editors in the inspector, the Autonomous node's tools and exits editors, and the Test/Logs tabs from the reference arrive with tasks 2.6, 6.8, 4.6 and 4.7.
