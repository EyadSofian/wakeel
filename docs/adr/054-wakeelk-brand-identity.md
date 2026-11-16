# ADR-054 — Wakeelk public identity and theme

**Status:** accepted (approved brand brief, 2026-11-16)

## Context

The public UI used Botbress while the technical monorepo, Bridge contract and deployed resources use `wakeel`. The previous indigo visual direction in ADR-017 is superseded for public branding. Existing package names, database identifiers, webhook headers, keys, export formats and production URLs must keep working.

## Decision

- The English public name is **Wakeelk**, the Arabic name is **وكيلك**, and the approved domain is `wakeelk.org`. `packages/config/src/brand.ts` owns public identity metadata. `codeName: "wakeel"` remains a technical identifier.
- `packages/ui/src/tokens.css` remains the single source of foundation, semantic and component tokens. The five approved anchors are `#FAFAFA`, `#CDCDCF`, `#939599`, `#2BCFCE`, and `#EC4D25`. Turquoise is the primary action colour; orange is restrained and never replaces error, warning or success semantics. Light and dark share token names and are contrast checked.
- The existing IBM Plex family and mixed-direction content rules remain. Studio theme choice uses its existing `data-theme` CSS contract, a stored preference and system preference when no choice is stored.
- The supplied `wakeelk-logo.png` is the approved artwork. The Studio uses a cropped display copy in the header and sign-in screen, plus a resized favicon. The original image remains untouched. Vector artwork has not been supplied.
- Current product documents and examples use Wakeelk. Historical ADRs, screenshots, release records, external provider names and technical identifiers remain historically accurate.

## Consequences

The new UI can ship independently of a backend or production resource rename. It does not require a database migration. The existing GitHub repository URL, Railway resources, API contracts and `@wakeel/*` package scope are intentionally unchanged.

## Migration inventory

| Classification | Updated | Preserved |
|---|---|---|
| Public identity | Studio title, header, sign-in, design gallery, current product docs, OpenAPI display title, and an Arabic test fixture | Historical ADR-017 and the pilot's named Chatwoot bot |
| Artwork | Supplied `wakeelk-logo.png`; cropped mark and favicon display copies | The original PNG remains untouched; no vector artwork was invented |
| Visual system | Shared tokens, Tailwind mappings, theme switch, contrast parser and tests | Functional status hues and node-category colors where they convey meaning |
| Contracts and operations | None | `@wakeel/*`, CLI, bot export format, auth cookies, webhook headers and User-Agent, crawler token, database names, migrations, service names and Railway settings |
| URLs | `BRAND.domain` is `wakeelk.org` for public identity | The pre-existing problem-document `docsUrl` remains unchanged because it appears in API responses; no callback or production URL was changed |

Legacy `Botbress` remains only in historical ADR-017 and this migration record. The `{{PLATFORM_NAME}}` placeholder remains in historical open question #1, which records the earlier branding decision. `Bookpress` did not occur in active application source. The remaining `wakeel` strings in application code are technical compatibility identifiers or test data for those identifiers.

## Verification record

- The approved PNG was inspected in the header and sign-in screen in both themes. Its cropped mark and favicon are derived from that file, without redrawing it.
- Contrast: `pnpm ui:contrast` passed all 58 light/dark pairs.
- Browser content checks: 5 passed, including theme persistence, system preference, image loading, Arabic direction and 375 px sign-in layout.
- Screenshot review: the final clean `pnpm studio:shots` run passed 625 of 625 route/state/theme/desktop-size cases. Four publish-blocked cases initially exposed a stale fixture mapping, which was corrected. These baselines cover the routes declared in `apps/studio/tests/screens.ts` at 1280 and 1440 px. Mobile verification is limited to sign-in; the desktop-first canvas and other workspace routes were not accepted at phone width.
- End-to-end journeys: the final full `pnpm e2e` run passed 23 of 23. The palette coverage test initially had an outdated command list; it now exercises Export bot and Publish.
- Parser: 12 passed using a writable temporary cache. The standard `pnpm check` command cannot pass this machine's root-owned `~/.cache` through Turbo's strict environment; the equivalent package matrix was rerun with `--env-mode=loose` and explicit cache and Colima socket variables.
- Lint and license checks passed. The full Turbo matrix passed 45 of 45 typecheck/test tasks with the local environment overrides. A first concurrent run had two worker timeouts; an isolated rerun passed 90 of 90 worker tests, and the cached matrix rerun passed 45 of 45 tasks.
