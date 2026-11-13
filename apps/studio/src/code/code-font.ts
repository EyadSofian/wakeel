/**
 * The font stack for code that may hold Arabic (design system §2.2: Plex Mono for code, Plex Sans
 * Arabic for Arabic content). `--font-mono` names no Arabic face, so Arabic inside code fell to a
 * monospace fallback that drew each letter on its own, unjoined. The stack below keeps Plex Mono
 * for everything it covers and gives Arabic letters Plex Sans Arabic, both read from the tokens.
 * ADR-021 (proposed) puts the Arabic face in `--font-mono` itself; then this becomes the token.
 */
export function codeFontFamily(root: HTMLElement = document.documentElement): string {
  const css = getComputedStyle(root);
  const split = (value: string) =>
    value
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  const mono = split(css.getPropertyValue("--font-mono"));
  const arabic = split(css.getPropertyValue("--font-sans")).filter((f) => /arabic/i.test(f));
  const generic: string[] = mono.filter((f) => f === "monospace" || f === "ui-monospace");
  const named = mono.filter((f) => !generic.includes(f));
  return [...named, ...arabic, ...generic].join(", ");
}
