import { parseHTML } from "linkedom";

/** Same scheme, host and port. Crawls stay on the start origin unless the source allows others. */
export const sameOrigin = (a: string, b: string) => new URL(a).origin === new URL(b).origin;

/** The URL with its fragment removed: `#section` links point at the same document. */
export function canonical(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.toString();
}

/** Links a crawler may follow: http(s) only, resolved against `<base>` or the page URL, no fragments. */
export function extractLinks(html: string, pageUrl: string): string[] {
  const { document } = parseHTML(html);
  const base = document.querySelector("base[href]")?.getAttribute("href");
  let baseUrl = pageUrl;
  try {
    if (base) baseUrl = new URL(base, pageUrl).toString();
  } catch {
    // An unparseable <base> is ignored, as browsers do.
  }
  const out = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const rel = (a.getAttribute("rel") ?? "").toLowerCase();
    if (rel.split(/\s+/).includes("nofollow")) continue;
    const href = a.getAttribute("href") ?? "";
    let u: URL;
    try {
      u = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    out.add(canonical(u.toString()));
  }
  return [...out];
}
