# ADR-021 — An Arabic face in the monospace stack

Status: proposed (found in the 2.9 design review; 2.9 works around it in the code editor only) · Date: 2026-11-14

## Context

Design system §2.2 says: "Plex Sans for Latin UI, Plex Sans Arabic for Arabic content, Plex Mono for code". The tokens are:

```css
--font-sans: "IBM Plex Sans", "IBM Plex Sans Arabic", system-ui, sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, monospace;
```

Code, expressions and trace payloads often contain Arabic: a message inside `say(...)`, a comment, an expression comparing `event.text` with an Arabic word. Plex Mono has no Arabic glyphs and `--font-mono` names no Arabic face. Arabic in a `font-mono` element therefore falls to whatever generic monospace font the system offers. In the 2.9 screenshots (Chromium, macOS) that font drew each Arabic letter on its own, unjoined, in the code editor and in the inspector's code preview. That breaks the Arabic gate (CLAUDE.md §11) for every monospace surface: ExpressionInput (2.6), trace payloads (4.x) and the code editor (2.9).

## Options

1. **Put Plex Sans Arabic in `--font-mono` before the generic fonts**: `"IBM Plex Mono", "IBM Plex Sans Arabic", ui-monospace, monospace`. Latin keeps Plex Mono. Arabic letters get the same Arabic face as the rest of the product, so they join and match the UI. Arabic is proportional, so columns of Arabic text do not line up. That already happens with any Arabic in code, and Monaco measures non-monospace runs itself.
2. **Add a separate `--font-code` token** with the Arabic face and keep `--font-mono` as it is. Two near-identical stacks would drift, and every monospace surface would have to choose the right one.
3. **Leave the token and patch each surface** (what 2.9 does for the editor and the preview). Each new monospace surface would repeat the patch or quietly break Arabic.

## Recommendation

Option 1. It is the smallest change, it follows §2.2's own rule for Arabic content, and it fixes every monospace surface at once. The Arabic subset is already loaded on first Arabic glyph (`unicode-range`), so pages with no Arabic pay nothing.

## Consequences

- `tokens.css` and the §2.2 snippet change to the stack above.
- `apps/studio/src/code/code-font.ts` (2.9) then reduces to `var(--font-mono)` and can be deleted.
- Screenshots that show Arabic in a monospace face (ExpressionInput with Arabic, the code drawer, later trace payloads) change and are re-reviewed in the PR that applies the token.
