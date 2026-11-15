import { describe, expect, test } from "vitest";
import {
  type CrawlClock,
  canonical,
  crawl,
  extractLinks,
  fromSitemap,
  type HttpResponse,
  Politeness,
  parseRobots,
  parseSitemap,
} from "../src/index";

/** Task 8.5: robots.txt, sitemaps, link extraction, and the crawler's limits and politeness. */

describe("parseRobots", () => {
  const robots = parseRobots(`
# comment
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.pdf$
Crawl-delay: 2

User-agent: OtherBot
Disallow: /

Sitemap: https://shop.example/sitemap.xml
`);

  test.each([
    ["https://shop.example/", true],
    ["https://shop.example/private/x", false],
    ["https://shop.example/private/public-page", true],
    ["https://shop.example/files/a.pdf", false],
    ["https://shop.example/files/a.pdf?x=1", true],
    ["https://shop.example/%D8%AF%D9%84%D9%8A%D9%84", true],
  ])("%s → %s", (url, allowed) => {
    expect(robots.isAllowed(url)).toBe(allowed);
  });

  test("reads the crawl delay and sitemaps of the * group", () => {
    expect(robots.crawlDelay).toBe(2);
    expect(robots.sitemaps).toEqual(["https://shop.example/sitemap.xml"]);
  });

  test("a group naming our bot wins over *, and an empty Disallow allows all", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: wakeelbot\nDisallow:\n");
    expect(r.isAllowed("https://x.example/anything")).toBe(true);
  });

  test("several user-agent lines share one group; Arabic paths match decoded rules", () => {
    const r = parseRobots("User-agent: a\nUser-agent: WakeelBot\nDisallow: /دليل\n");
    expect(r.isAllowed("https://x.example/%D8%AF%D9%84%D9%8A%D9%84/1")).toBe(false);
    expect(parseRobots("").isAllowed("https://x.example/")).toBe(true);
  });
});

describe("parseSitemap", () => {
  test("a urlset with lastmod, CDATA and entities; non-http locations are dropped", () => {
    const s = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://shop.example/a?x=1&amp;y=2</loc><lastmod>2026-11-01</lastmod></url>
      <url><loc><![CDATA[https://shop.example/دليل]]></loc></url>
      <url><loc>ftp://shop.example/no</loc></url>
      <url><lastmod>2026</lastmod></url>
    </urlset>`);
    expect(s).toEqual({
      kind: "urlset",
      entries: [{ url: "https://shop.example/a?x=1&y=2", lastmod: "2026-11-01" }, { url: "https://shop.example/دليل" }],
    });
  });

  test("a sitemap index lists sitemaps", () => {
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://s.example/s1.xml</loc></sitemap></sitemapindex>")).toEqual(
      { kind: "index", entries: [{ url: "https://s.example/s1.xml" }] },
    );
  });
});

describe("extractLinks", () => {
  test("resolves against <base>, drops fragments, mailto, javascript and nofollow, dedupes", () => {
    const html = `<base href="https://shop.example/docs/"><a href="a">a</a><a href="a#top">a</a>
      <a href="/b">b</a><a href="mailto:x@y.z">m</a><a href="javascript:void(0)">j</a>
      <a rel="nofollow" href="/hidden">h</a><a href="http://[bad">bad</a><a href="https://other.example/">o</a>`;
    expect(extractLinks(html, "https://shop.example/")).toEqual([
      "https://shop.example/docs/a",
      "https://shop.example/b",
      "https://other.example/",
    ]);
  });

  test("an unparseable <base> falls back to the page URL", () => {
    expect(extractLinks('<base href="http://[x"><a href="c">c</a>', "https://s.example/p/")).toEqual([
      "https://s.example/p/c",
    ]);
    expect(canonical("https://s.example/a#b")).toBe("https://s.example/a");
  });
});

/** A fake site: paths → [status, content-type, body]. Records request times on a fake clock. */
function site(pages: Record<string, [number, string, string]>, origin = "https://shop.example") {
  const log: { url: string; at: number; ua: string }[] = [];
  let now = 0;
  const clock: CrawlClock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  const get = async (url: string, headers: Record<string, string>): Promise<HttpResponse> => {
    log.push({ url, at: now, ua: headers["user-agent"] ?? "" });
    const u = new URL(url);
    if (u.pathname === "/boom") throw new Error("connection reset");
    const page = u.origin === origin ? pages[u.pathname] : undefined;
    const [status, type, body] = page ?? [404, "text/plain", "not found"];
    if (status === 301)
      return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array(), url: body };
    return { status, headers: { "content-type": type }, body: new TextEncoder().encode(body), url };
  };
  return { log, clock, politeness: (ms = 1000) => new Politeness(get, clock, ms) };
}

const html = (...links: string[]) => `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

describe("crawl", () => {
  const pages: Record<string, [number, string, string]> = {
    "/robots.txt": [200, "text/plain", "User-agent: *\nDisallow: /admin"],
    "/": [200, "text/html", html("/a", "/b", "/admin/x", "https://other.example/", "/boom", "/missing")],
    "/a": [200, "text/html", html("/a/deep")],
    "/b": [200, "application/pdf", "%PDF"],
    "/a/deep": [200, "text/html", html("/a/deeper")],
    "/a/deeper": [200, "text/html", html()],
    "/moved": [301, "", "https://other.example/landing"],
  };

  test("respects robots, depth and origin; skips failures; sends our user agent", async () => {
    const s = site(pages);
    const r = await crawl(s.politeness(), {
      start: "https://shop.example/",
      maxDepth: 2,
      maxPages: 50,
      sameOriginOnly: true,
    });
    expect(r.pages.map((p) => [p.url, p.depth])).toEqual([
      ["https://shop.example/", 0],
      ["https://shop.example/a", 1],
      ["https://shop.example/b", 1],
      ["https://shop.example/a/deep", 2],
    ]);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { url: "https://shop.example/admin/x", reason: "robots" },
        { url: "https://other.example/", reason: "off_origin" },
        { url: "https://shop.example/boom", reason: "fetch_failed" },
        { url: "https://shop.example/missing", reason: "http_error" },
      ]),
    );
    expect(s.log.every((l) => l.ua.startsWith("WakeelBot/"))).toBe(true);
  });

  test("stops at the page limit", async () => {
    const r = await crawl(site(pages).politeness(), {
      start: "https://shop.example/",
      maxDepth: 5,
      maxPages: 2,
      sameOriginOnly: true,
    });
    expect(r.pages).toHaveLength(2);
    expect(r.skipped.some((x) => x.reason === "limit")).toBe(true);
  });

  test("never sends two requests to a host within a second", async () => {
    const s = site(pages);
    await crawl(s.politeness(), { start: "https://shop.example/", maxDepth: 3, maxPages: 50, sameOriginOnly: true });
    const times = s.log.map((l) => l.at);
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(1000);
  });

  test("a Crawl-delay longer than a second is honoured", async () => {
    const s = site({ ...pages, "/robots.txt": [200, "text/plain", "User-agent: *\nCrawl-delay: 3"] });
    await crawl(s.politeness(), { start: "https://shop.example/", maxDepth: 1, maxPages: 3, sameOriginOnly: true });
    const times = s.log.map((l) => l.at);
    expect((times[2] as number) - (times[1] as number)).toBeGreaterThanOrEqual(3000);
  });

  test("a redirect off the origin is skipped; robots.txt with a server error blocks the crawl", async () => {
    const off = await crawl(site(pages).politeness(), {
      start: "https://shop.example/moved",
      maxDepth: 1,
      maxPages: 5,
      sameOriginOnly: true,
    });
    expect(off.skipped).toEqual([{ url: "https://shop.example/moved", reason: "off_origin" }]);
    const down = await crawl(site({ ...pages, "/robots.txt": [503, "text/plain", ""] }).politeness(), {
      start: "https://shop.example/",
      maxDepth: 1,
      maxPages: 5,
      sameOriginOnly: true,
    });
    expect(down.pages).toEqual([]);
    expect(down.skipped[0]?.reason).toBe("robots");
  });

  test("a missing robots.txt allows all; off-origin links may be followed when allowed", async () => {
    const r = await crawl(
      site({ "/": [200, "text/html", html("/a")], "/a": [200, "text/html", html()] }).politeness(),
      {
        start: "https://shop.example/",
        maxDepth: 1,
        maxPages: 5,
        sameOriginOnly: false,
      },
    );
    expect(r.pages.map((p) => p.url)).toEqual(["https://shop.example/", "https://shop.example/a"]);
  });
});

describe("fromSitemap", () => {
  const urlset = (...paths: string[]) =>
    `<urlset>${paths.map((p) => `<url><loc>https://shop.example${p}</loc></url>`).join("")}</urlset>`;

  test("follows an index, filters robots and other origins, applies the page limit", async () => {
    const s = site({
      "/robots.txt": [200, "text/plain", "User-agent: *\nDisallow: /secret"],
      "/sitemap.xml": [
        200,
        "application/xml",
        "<sitemapindex><sitemap><loc>https://shop.example/s1.xml</loc></sitemap><sitemap><loc>https://shop.example/s2.xml</loc></sitemap></sitemapindex>",
      ],
      "/s1.xml": [200, "application/xml", urlset("/a", "/secret/x", "/a")],
      "/s2.xml": [
        200,
        "application/xml",
        `${urlset("/b", "/c")}<urlset><url><loc>https://evil.example/x</loc></url></urlset>`,
      ],
    });
    const r = await fromSitemap(s.politeness(), {
      sitemapUrl: "https://shop.example/sitemap.xml",
      maxPages: 2,
      maxSitemaps: 10,
      sameOriginOnly: true,
    });
    expect(r.pages.map((p) => p.url)).toEqual(["https://shop.example/a", "https://shop.example/b"]);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { url: "https://shop.example/secret/x", reason: "robots" },
        { url: "https://shop.example/c", reason: "limit" },
        { url: "https://evil.example/x", reason: "off_origin" },
      ]),
    );
  });

  test("a missing sitemap is reported, not thrown", async () => {
    const r = await fromSitemap(site({}).politeness(), {
      sitemapUrl: "https://shop.example/sitemap.xml",
      maxPages: 5,
      maxSitemaps: 5,
      sameOriginOnly: true,
    });
    expect(r).toEqual({ pages: [], skipped: [{ url: "https://shop.example/sitemap.xml", reason: "http_error" }] });
  });
});
