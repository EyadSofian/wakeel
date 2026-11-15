/**
 * Sitemaps (sitemaps.org protocol): a `<urlset>` lists pages, a `<sitemapindex>` lists more sitemaps.
 * Parsed with a small tolerant reader rather than a full XML parser: we need `<loc>` and `<lastmod>`.
 */
export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

export interface ParsedSitemap {
  kind: "urlset" | "index";
  entries: SitemapEntry[];
}

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

export function parseSitemap(xml: string): ParsedSitemap {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : "urlset";
  const tag = kind === "index" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  const blockRe = new RegExp(`<${tag}[\\s>]([\\s\\S]*?)</${tag}>`, "gi");
  for (const block of xml.matchAll(blockRe)) {
    const inner = block[1] ?? "";
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(inner)?.[1];
    if (!loc) continue;
    const url = decodeXml(loc);
    if (!/^https?:\/\//i.test(url)) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(inner)?.[1];
    entries.push({ url, ...(lastmod ? { lastmod: decodeXml(lastmod) } : {}) });
  }
  return { kind, entries };
}
