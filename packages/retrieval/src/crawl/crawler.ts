import { canonical, extractLinks, sameOrigin } from "./links";
import { ALLOW_ALL, CRAWLER_USER_AGENT, DISALLOW_ALL, parseRobots, type Robots } from "./robots";
import { parseSitemap } from "./sitemap";

/**
 * Discovery for URL, sitemap and crawl sources (task 8.5, architecture §8.1 "Fetch"): robots.txt is
 * respected, crawls stay on the start origin by default, depth and page limits apply, and each host
 * gets at most one request per `minIntervalMs` (1 s), longer if robots.txt asks for a Crawl-delay.
 * All network access goes through `get`, which the worker binds to the egress service.
 */

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** The final URL after redirects. */
  url: string;
}
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export interface CrawlClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Discovered {
  url: string;
  depth: number;
  /** The fetched page, when discovery had to fetch it (crawls); the pipeline reuses it. */
  response?: HttpResponse;
}

export interface Skipped {
  url: string;
  reason: "robots" | "off_origin" | "limit" | "http_error" | "fetch_failed";
}

export interface DiscoveryResult {
  pages: Discovered[];
  skipped: Skipped[];
}

const dec = new TextDecoder();
const isHtml = (r: HttpResponse) => (r.headers["content-type"] ?? "").toLowerCase().includes("text/html");

/** Per-host politeness and robots.txt cache, shared by one discovery run. */
export class Politeness {
  private readonly last = new Map<string, number>();
  private readonly robots = new Map<string, Robots>();
  constructor(
    private readonly get: HttpGet,
    private readonly clock: CrawlClock,
    private readonly minIntervalMs: number,
  ) {}

  async fetch(url: string): Promise<HttpResponse> {
    const host = new URL(url).host;
    const robots = this.robots.get(new URL(url).origin);
    const interval = Math.max(this.minIntervalMs, (robots?.crawlDelay ?? 0) * 1000);
    const last = this.last.get(host);
    if (last !== undefined) {
      const wait = last + interval - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
    }
    this.last.set(host, this.clock.now());
    return this.get(url, { "user-agent": CRAWLER_USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
  }

  async robotsFor(url: string): Promise<Robots> {
    const origin = new URL(url).origin;
    const cached = this.robots.get(origin);
    if (cached) return cached;
    let robots: Robots;
    try {
      const res = await this.fetch(`${origin}/robots.txt`);
      robots = res.status >= 500 ? DISALLOW_ALL : res.status >= 400 ? ALLOW_ALL : parseRobots(dec.decode(res.body));
    } catch {
      // Unreachable is treated like a server error: do not crawl what we could not check.
      robots = DISALLOW_ALL;
    }
    this.robots.set(origin, robots);
    return robots;
  }
}

export interface CrawlOptions {
  start: string;
  maxDepth: number;
  maxPages: number;
  sameOriginOnly: boolean;
}

/** Breadth-first crawl from `start`. Returns the pages that answered 200, with their responses. */
export async function crawl(p: Politeness, o: CrawlOptions): Promise<DiscoveryResult> {
  const pages: Discovered[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: canonical(o.start), depth: 0 }];
  seen.add(canonical(o.start));
  while (queue.length > 0) {
    const { url, depth } = queue.shift() as { url: string; depth: number };
    if (pages.length >= o.maxPages) {
      skipped.push({ url, reason: "limit" });
      continue;
    }
    if (!(await p.robotsFor(url)).isAllowed(url)) {
      skipped.push({ url, reason: "robots" });
      continue;
    }
    let res: HttpResponse;
    try {
      res = await p.fetch(url);
    } catch {
      skipped.push({ url, reason: "fetch_failed" });
      continue;
    }
    if (o.sameOriginOnly && !sameOrigin(o.start, res.url)) {
      skipped.push({ url, reason: "off_origin" });
      continue;
    }
    if (res.status !== 200) {
      skipped.push({ url, reason: "http_error" });
      continue;
    }
    pages.push({ url: canonical(res.url), depth, response: res });
    if (depth >= o.maxDepth || !isHtml(res)) continue;
    for (const link of extractLinks(dec.decode(res.body), res.url)) {
      if (seen.has(link)) continue;
      seen.add(link);
      if (o.sameOriginOnly && !sameOrigin(o.start, link)) {
        skipped.push({ url: link, reason: "off_origin" });
        continue;
      }
      queue.push({ url: link, depth: depth + 1 });
    }
  }
  return { pages, skipped };
}

/** The pages a sitemap (or sitemap index, up to `maxSitemaps`) lists, filtered by robots.txt. */
export async function fromSitemap(
  p: Politeness,
  o: { sitemapUrl: string; maxPages: number; maxSitemaps: number; sameOriginOnly: boolean },
): Promise<DiscoveryResult> {
  const pages: Discovered[] = [];
  const skipped: Skipped[] = [];
  const pending = [o.sitemapUrl];
  const seen = new Set<string>();
  let sitemaps = 0;
  while (pending.length > 0 && sitemaps < o.maxSitemaps) {
    const sm = pending.shift() as string;
    sitemaps++;
    const res = await p.fetch(sm);
    if (res.status !== 200) {
      skipped.push({ url: sm, reason: "http_error" });
      continue;
    }
    const parsed = parseSitemap(dec.decode(res.body));
    for (const e of parsed.entries) {
      const url = canonical(e.url);
      if (seen.has(url)) continue;
      seen.add(url);
      if (o.sameOriginOnly && !sameOrigin(o.sitemapUrl, url)) {
        skipped.push({ url, reason: "off_origin" });
        continue;
      }
      if (parsed.kind === "index") {
        pending.push(url);
        continue;
      }
      if (pages.length >= o.maxPages) {
        skipped.push({ url, reason: "limit" });
        continue;
      }
      if (!(await p.robotsFor(url)).isAllowed(url)) {
        skipped.push({ url, reason: "robots" });
        continue;
      }
      pages.push({ url, depth: 0 });
    }
  }
  return { pages, skipped };
}
