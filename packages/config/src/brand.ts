/**
 * Public identity is centralized here. The technical code name and its public API contracts remain
 * `wakeel` for compatibility; see ADR-054.
 *
 * Browser-safe: no Node imports.
 */
export const BRAND = {
  /** Shown to users: sign-in page, page titles, emails. */
  name: "Wakeelk",
  nameAr: "وكيلك",
  domain: "wakeelk.org",
  category: "AI Agent Platform",
  /** The approved artwork is PNG; mark and favicon are cropped display variants. */
  logo: {
    primary: "/brand/wakeelk-logo.png",
    mark: "/brand/wakeelk-mark.png",
    favicon: "/brand/wakeelk-favicon.png",
  },
  /** Package scope, CLI name and the prefix of public contract names (headers, key prefixes). */
  codeName: "wakeel",
  /** Public documentation; problem documents link to `${docsUrl}/errors/<code>` (ADR-012). */
  docsUrl: "https://docs.{{PLATFORM_DOMAIN}}",
} as const;
