import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { callEgress, decode, type Harness, PUBLIC_V4, startHarness } from "./harness";

/**
 * The SSRF matrix (build plan 3.1, threat T3). Every row must come back as `fetch_blocked` without
 * any connection reaching a non-public address: the canary server counts those. CLAUDE.md §9:
 * this suite only grows. Never remove or loosen a row to make a build pass.
 */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
  h.resolver.set("metadata.google.internal", ["169.254.169.254"]);
  h.resolver.set("internal.test", ["10.0.0.5"]);
  h.resolver.set("mixed.test", [PUBLIC_V4, "127.0.0.1"]);
  h.resolver.set("loop6.test", ["::1"]);
  h.resolver.set("mapped.test", ["::ffff:127.0.0.1"]);
  h.resolver.set("nat64.test", ["64:ff9b::a9fe:a9fe"]);
  h.resolver.set("localhost.localdomain", ["127.0.0.1"]);
  h.resolver.set("nip.test", ["127.0.0.1"]);
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  expect(h.canaryHits, "a blocked address was dialled").toEqual([]);
});

const expectBlocked = async (url: string, host?: string) => {
  const reply = await callEgress(h, { url });
  expect(reply.status, url).toBe(403);
  expect(reply.headers.get("content-type")).toContain("application/problem+json");
  expect(reply.json.code, url).toBe("fetch_blocked");
  if (host !== undefined) expect(reply.json.title).toBe(`Requests to ${host} are not allowed`);
};

describe("IPv4 literals in every notation", () => {
  test.each([
    ["http://127.0.0.1/", "dotted"],
    ["http://127.1/", "short form"],
    ["http://127.0.1/", "short form"],
    ["http://2130706433/", "decimal"],
    ["http://0x7f000001/", "hex"],
    ["http://0x7F.0x0.0x0.0x1/", "hex per part"],
    ["http://0177.0.0.1/", "octal"],
    ["http://017700000001/", "octal whole"],
    ["http://0177.1/", "octal short"],
    ["http://000000177.0.0.01/", "octal with padding"],
    ["http://0/", "zero"],
    ["http://0.0.0.0/", "unspecified"],
    ["http://3232235777/", "192.168.1.1 as decimal"],
    ["http://10.0.0.1:6379/", "private with a port"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://0xa9fea9fe/", "cloud metadata as hex"],
    ["http://2852039166/", "cloud metadata as decimal"],
    ["http://0251.0376.0251.0376/", "cloud metadata as octal"],
    ["http://168.63.129.16/", "Azure wire server"],
    ["http://100.100.100.200/", "Alibaba metadata"],
    ["http://127.0.0.1./", "trailing dot"],
  ])("%s (%s)", async (url) => {
    await expectBlocked(url);
  });

  test("the title names the address after normalisation", async () => {
    await expectBlocked("http://2130706433/", "127.0.0.1");
  });
});

describe("localhost variants", () => {
  test.each([
    "http://localhost/",
    "http://LOCALHOST/",
    "http://LocalHost:8080/",
    "http://localhost./",
    "http://app.localhost/",
    "http://a.b.localhost/",
    "http://localhost.localdomain/",
    "http://ip6-localhost/",
    "http://nip.test/",
  ])("%s", async (url) => {
    await expectBlocked(url);
  });

  test("localhost is refused before any DNS lookup", async () => {
    const before = h.resolver.calls.length;
    await expectBlocked("http://localhost/");
    expect(h.resolver.calls.length).toBe(before);
  });
});

describe("IPv6 literals: loopback, mapped and embedded IPv4", () => {
  test.each([
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[0000:0000:0000:0000:0000:0000:0000:0001]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:0:127.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::127.0.0.1]/",
    "http://[2002:7f00:1::]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd00:ec2::254]/",
    "http://[ff02::1]/",
  ])("%s", async (url) => {
    await expectBlocked(url);
  });
});

describe("URLs the parser rejects never reach the policy or the network", () => {
  // WHATWG URL refuses IPv6 zone ids, so these fail validation before any lookup or dial.
  test.each(["http://[fe80::1%25eth0]/", "http://[::1/", "http://[::ffff:127.0.0.1:80/", "not a url"])(
    "%s",
    async (url) => {
      const before = h.resolver.calls.length;
      const reply = await callEgress(h, { url });
      expect(reply.status).toBe(400);
      expect(reply.json.code).toBe("validation_failed");
      expect(reply.json.errors[0].path).toBe("url");
      expect(h.resolver.calls.length).toBe(before);
    },
  );
});

describe("names that resolve to blocked addresses", () => {
  test.each([
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://internal.test/",
    "http://loop6.test/",
    "http://mapped.test/",
    "http://nat64.test/",
  ])("%s", async (url) => {
    await expectBlocked(url);
  });

  test("one blocked address in the answer blocks the name, even next to a public one", async () => {
    await expectBlocked("http://mixed.test/ok", "mixed.test");
    expect(h.publicHits.filter((hit) => hit.url === "/ok" && hit.headers.host === "mixed.test")).toEqual([]);
  });
});

describe("URL tricks", () => {
  test.each([
    ["http://public.test@127.0.0.1/", "userinfo that looks like a host"],
    ["http://public.test:80@127.0.0.1/", "userinfo with a port"],
    ["http://127.0.0.1#@public.test/", "fragment that looks like a host"],
    ["http://127.0.0.1?@public.test/", "query that looks like a host"],
    ["http://%31%32%37.0.0.1/", "percent-encoded host"],
    ["http://①②⑦.0.0.1/", "full-width digits"],
  ])("%s (%s)", async (url) => {
    await expectBlocked(url);
  });

  test.each([
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "ftp://public.test/",
    "dict://127.0.0.1:11211/stat",
    "ws://public.test/",
    "data:text/plain,hello",
    "javascript:alert(1)",
  ])("only http and https: %s", async (url) => {
    await expectBlocked(url);
  });
});

describe("redirects are checked again on every hop", () => {
  const via = (to: string, status = 302) => `http://public.test/redirect?status=${status}&to=${encodeURIComponent(to)}`;

  test.each([
    ["http://127.0.0.1/", 302],
    ["http://2130706433/", 301],
    ["http://0x7f000001/", 303],
    ["http://localhost/", 307],
    ["http://[::1]/", 308],
    ["http://[::ffff:127.0.0.1]/", 302],
    ["http://169.254.169.254/latest/meta-data/", 302],
    ["http://metadata.google.internal/", 302],
    ["http://internal.test/", 302],
    ["//127.0.0.1/", 302],
    ["file:///etc/passwd", 302],
    ["gopher://127.0.0.1:6379/_INFO", 302],
  ] as const)("public → %s (%i)", async (to, status) => {
    await expectBlocked(via(to, status));
  });

  test("a blocked hop deep in a chain is still blocked", async () => {
    const inner = via("http://127.0.0.1/");
    const outer = via(via(inner));
    await expectBlocked(outer, "127.0.0.1");
  });

  test("a POST that redirects with 307 to a private address sends nothing there", async () => {
    const reply = await callEgress(h, { url: via("http://10.0.0.1/", 307), method: "POST", body: "secret" });
    expect(reply.json.code).toBe("fetch_blocked");
  });
});

describe("DNS rebinding (test resolver)", () => {
  test("the first answer is pinned: a second, private answer is never used for that connection", async () => {
    h.resolver.set("rebind.test", (call) => (call === 1 ? [PUBLIC_V4] : ["127.0.0.1"]));
    const reply = await callEgress(h, { url: "http://rebind.test/ok" });
    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe(200);
    expect(decode(reply)).toBe("public ok");
    expect(h.resolver.callsFor("rebind.test")).toBe(1);
  });

  test("a name that rebinds to a private address between redirects is blocked on the next hop", async () => {
    h.resolver.set("rebind-hop.test", (call) => (call === 1 ? [PUBLIC_V4] : ["127.0.0.1"]));
    await expectBlocked("http://rebind-hop.test/redirect?to=http://rebind-hop.test/ok", "rebind-hop.test");
    expect(h.resolver.callsFor("rebind-hop.test")).toBe(2);
  });

  test("a name that rebinds to the metadata address on the second request is blocked", async () => {
    h.resolver.set("rebind-again.test", (call) => (call === 1 ? [PUBLIC_V4] : ["169.254.169.254"]));
    const first = await callEgress(h, { url: "http://rebind-again.test/ok" });
    expect(first.json.status).toBe(200);
    await expectBlocked("http://rebind-again.test/ok");
  });

  test("a name with no answer fails with fetch_failed, not a fallback", async () => {
    const reply = await callEgress(h, { url: "http://nowhere.test/" });
    expect(reply.status).toBe(502);
    expect(reply.json.code).toBe("fetch_failed");
  });
});

describe("public servers stay reachable", () => {
  test("by name over IPv4", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok" });
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ status: 200, url: "http://public.test/ok", redirected: false });
    expect(decode(reply)).toBe("public ok");
  });

  test("by name over IPv6", async () => {
    const reply = await callEgress(h, { url: "http://public6.test/ok" });
    expect(reply.json.status).toBe(200);
    expect(decode(reply)).toBe("public ok");
  });

  test("by a public IPv4 literal", async () => {
    const reply = await callEgress(h, { url: `http://${PUBLIC_V4}/ok` });
    expect(reply.json.status).toBe(200);
  });

  test("through a public-to-public redirect", async () => {
    const reply = await callEgress(h, { url: "http://public.test/redirect?to=http://public6.test/ok" });
    expect(reply.json).toMatchObject({ status: 200, url: "http://public6.test/ok", redirected: true });
  });

  test("over https, with the certificate checked against the name, not the pinned address", async () => {
    const reply = await callEgress(h, { url: "https://secure.test/ok" });
    expect(reply.json.status).toBe(200);
    expect(decode(reply)).toBe("public ok");
  });

  test("over https to an address the certificate does not name, the request fails", async () => {
    h.resolver.set("wrong-name.test", ["93.184.215.15"]);
    const reply = await callEgress(h, { url: "https://wrong-name.test/ok" });
    expect(reply.status).toBe(502);
    expect(reply.json.code).toBe("fetch_failed");
  });
});
