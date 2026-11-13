# ADR-011 — Studio front end: Vite SPA, one canvas store, xyflow as the renderer only

Status: accepted · Date: 2026-11-13

## Context
The Studio must feel like a professional tool: 60 fps pan and zoom with 300+ nodes, purposeful motion, keyboard-first, instant local edits with background saves.

## Decision
- **Shell**: Vite + React 19, TanStack Router (typed routes, code-split per screen), TanStack Query for server state.
- **Canvas state**: one Zustand store per open workflow is the source of truth for the document (nodes, cards, edges, layout), selection and undo history. xyflow renders from selectors; it does not own the data. Commands (`addNode`, `moveCard`, `connect`, …) are the only way to mutate and each is undoable.
- **Saving**: commands mark the document dirty; a debounced saver sends the whole workflow document with `If-Match`. The UI never waits for the server to show an edit.
- **Performance rules** (enforced by a CI perf test with a 300-node fixture): memoised node and edge components; nodes subscribe by id; `onlyRenderVisibleElements`; no React state updates during pan or zoom; below zoom 0.5 nodes render a compact form; Motion layout animation is scoped to the node being edited, never the whole canvas.
- **Styling**: Tailwind 4 with every colour, radius, space, shadow and duration coming from CSS variables defined in `packages/ui/tokens.css`. Raw hex values and arbitrary pixel values are lint errors.
- **Primitives**: Radix for behaviour, our components for appearance. One icon set (Lucide, 1.5 px stroke at 16 px).
- **Code editing**: Monaco, lazy-loaded, with generated typings from the bot schema.
- **Validation**: the same `validateDefinition` as the server runs in a web worker on every change.
- **Text direction**: UI chrome is LTR English in the MVP; every surface that shows bot or user content sets `dir="auto"` and uses logical CSS properties.

## Alternatives considered
- **Next.js**: no benefit for an authenticated tool; see ADR-001.
- **Let xyflow own node state**: simpler start, but undo, validation and saving all need a document model outside the renderer.
- **Redux Toolkit**: fine; Zustand is lighter for per-document stores.
- **Canvas/WebGL renderer**: unnecessary at 300 nodes and loses DOM accessibility.

## Consequences
- A command layer to build before the canvas feels complete.
- Undo/redo is per workflow document and survives selection changes.

## Revisit when
Workflows above ~1,000 nodes become common, or real-time collaboration is scheduled (the command layer is the integration point).
