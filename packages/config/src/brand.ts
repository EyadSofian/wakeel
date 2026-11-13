/**
 * The only place the product's user-facing name is defined (architecture, opening section). The name
 * is undecided (docs/00-open-questions.md #1), so it stays a placeholder that is easy to search for.
 *
 * Browser-safe: no Node imports.
 */
export const BRAND = {
  /** Shown to users: sign-in page, page titles, emails. */
  name: "{{PLATFORM_NAME}}",
  /** Package scope, CLI name and the prefix of public contract names (headers, key prefixes). */
  codeName: "wakeel",
} as const;
