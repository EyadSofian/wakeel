/**
 * The only place the product's user-facing name is defined (architecture, opening section). Eyad
 * chose "Botbress" on 2026-11-13 (ADR-017). It is one letter from a competitor's trademark, so it may
 * still change before launch; keep every use reading from here. Headers and key prefixes still use
 * the code name until docs/00-open-questions.md #1 is closed.
 *
 * Browser-safe: no Node imports.
 */
export const BRAND = {
  /** Shown to users: sign-in page, page titles, emails. */
  name: "Botbress",
  /** Package scope, CLI name and the prefix of public contract names (headers, key prefixes). */
  codeName: "wakeel",
  /** Public documentation; problem documents link to `${docsUrl}/errors/<code>` (ADR-012). */
  docsUrl: "https://docs.{{PLATFORM_DOMAIN}}",
} as const;
