/**
 * robots.txt (RFC 9309) for the crawler (architecture §8.1 "Fetch"): the group for our product token,
 * else `*`; the longest matching rule wins and Allow wins a tie; `*` and `$` patterns. A missing or
 * unreadable robots.txt (4xx) allows everything; a 5xx disallows everything, as the RFC says.
 */
export const CRAWLER_TOKEN = "WakeelBot";
export const CRAWLER_USER_AGENT = `${CRAWLER_TOKEN}/1.0 (+https://wakeel.dev/bot)`;

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  isAllowed(url: string): boolean;
  /** Crawl-delay for our group in seconds, when given. */
  crawlDelay?: number;
  sitemaps: string[];
}

export function parseRobots(text: string, token = CRAWLER_TOKEN): Robots {
  const groups: { agents: string[]; rules: Rule[]; delay?: number }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[]; delay?: number } | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const key = m[1].toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const mine = token.toLowerCase();
  const group =
    groups.find((g) => g.agents.some((a) => a !== "*" && mine.startsWith(a))) ??
    groups.find((g) => g.agents.includes("*"));
  const rules = group?.rules ?? [];
  return {
    sitemaps,
    ...(group?.delay !== undefined ? { crawlDelay: group.delay } : {}),
    isAllowed(url: string) {
      const u = new URL(url);
      const path = `${u.pathname}${u.search}`;
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!matches(rule.pattern, path)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
        )
          best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: Robots = { isAllowed: () => true, sitemaps: [] };
export const DISALLOW_ALL: Robots = { isAllowed: () => false, sitemaps: [] };

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${source}${anchored ? "$" : ""}`);
  // Rules may be written percent-encoded or not; try the path both ways.
  return re.test(path) || re.test(safeDecode(path));
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}
