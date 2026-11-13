import { EGRESS_LIMITS } from "@wakeel/config";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { callEgress, decode, type Harness, OTHER_WORKSPACE, startHarness, TOKEN } from "./harness";

/** Everything about the egress service except the address policy: auth, limits, redirects, headers. */

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

afterEach(() => {
  expect(h.canaryHits, "a blocked address was dialled").toEqual([]);
});

const MB = 1024 * 1024;

describe("health", () => {
  test("GET /health answers without a token", async () => {
    const res = await fetch(`${h.egressUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("callers", () => {
  test("a request without the token is refused", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok" }, { token: null });
    expect(reply.status).toBe(401);
    expect(reply.json.code).toBe("unauthenticated");
  });

  test("a wrong token is refused", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok" }, { token: `${TOKEN}x` });
    expect(reply.status).toBe(401);
  });

  test("a request without a valid workspace id is refused", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok", workspaceId: "acme" });
    expect(reply.status).toBe(400);
    expect(reply.json.code).toBe("validation_failed");
    expect(reply.json.errors[0].path).toBe("workspaceId");
  });

  test("a body that is not JSON is refused", async () => {
    const res = await fetch(`${h.egressUrl}/v1/fetch`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_failed");
  });

  test("other paths are not found", async () => {
    const res = await fetch(`${h.egressUrl}/v1/other`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  test("a caller cannot raise the limits", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok", timeoutMs: EGRESS_LIMITS.timeoutMs + 1 });
    expect(reply.status).toBe(400);
    expect(reply.json.errors[0].path).toBe("timeoutMs");
  });
});

describe("requests go out as asked", () => {
  test("method, headers and a text body reach the server", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/echo",
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "tenant-key" },
      body: '{"a":1}',
    });
    const echoed = JSON.parse(decode(reply));
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe('{"a":1}');
    expect(echoed.headers["x-api-key"]).toBe("tenant-key");
    expect(echoed.headers.host).toBe("public.test");
  });

  test("a base64 body is decoded before it is sent", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/echo",
      method: "PUT",
      body: Buffer.from("bytes ✓").toString("base64"),
      bodyEncoding: "base64",
    });
    expect(JSON.parse(decode(reply)).body).toBe("bytes ✓");
  });

  test("hop-by-hop and proxy headers from the caller are dropped; Host is the URL's", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/echo",
      headers: {
        host: "127.0.0.1",
        connection: "keep-alive, x-secret",
        "x-secret": "drop me",
        "proxy-authorization": "Basic abc",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        te: "trailers",
      },
    });
    const headers = JSON.parse(decode(reply)).headers;
    expect(headers.host).toBe("public.test");
    expect(headers["proxy-authorization"]).toBeUndefined();
    expect(headers["x-secret"]).toBeUndefined();
    expect(headers.upgrade).toBeUndefined();
    expect(headers.te).toBeUndefined();
  });

  test("the Host header keeps a non-default port", async () => {
    const reply = await callEgress(h, { url: "http://public.test:8080/echo" });
    expect(JSON.parse(decode(reply)).headers.host).toBe("public.test:8080");
  });

  test("a request body over the limit is refused before anything is sent", async () => {
    const hitsBefore = h.publicHits.length;
    const reply = await callEgress(h, {
      url: "http://public.test/echo",
      method: "POST",
      body: Buffer.alloc(EGRESS_LIMITS.requestBodyBytes + 1, 0x61).toString("base64"),
      bodyEncoding: "base64",
    });
    expect(reply.status).toBe(413);
    expect(reply.json.code).toBe("payload_too_large");
    expect(h.publicHits.length).toBe(hitsBefore);
  });
});

describe("responses come back whole", () => {
  test("status, headers (repeated ones kept) and body; hop-by-hop headers removed", async () => {
    const reply = await callEgress(h, { url: "http://public.test/cookie" });
    expect(reply.json.status).toBe(200);
    expect(decode(reply)).toBe("cookies");
    const cookies = (reply.json.headers as [string, string][]).filter(([k]) => k === "set-cookie").map(([, v]) => v);
    expect(cookies).toEqual(["a=1", "b=2"]);
    expect((reply.json.headers as [string, string][]).some(([k]) => k === "connection")).toBe(false);
  });

  test("a non-2xx answer is a result, not an egress error", async () => {
    const reply = await callEgress(h, { url: "http://public.test/missing" });
    expect(reply.status).toBe(200);
    expect(reply.json.status).toBe(404);
  });

  test("gzip is decoded and the encoding headers are removed", async () => {
    const reply = await callEgress(h, { url: "http://public.test/gzip?n=1000" });
    expect(decode(reply)).toBe("a".repeat(1000));
    const names = (reply.json.headers as [string, string][]).map(([k]) => k);
    expect(names).not.toContain("content-encoding");
    expect(names).not.toContain("content-length");
  });
});

describe("size limit", () => {
  test("a response of exactly the limit is returned", async () => {
    const reply = await callEgress(h, { url: `http://public.test/bytes?n=${EGRESS_LIMITS.responseBytes}` });
    expect(reply.json.status).toBe(200);
    expect(Buffer.from(reply.json.body, "base64").length).toBe(EGRESS_LIMITS.responseBytes);
  });

  test("one byte over the limit fails", async () => {
    const reply = await callEgress(h, { url: `http://public.test/bytes?n=${EGRESS_LIMITS.responseBytes + 1}` });
    expect(reply.status).toBe(502);
    expect(reply.json.code).toBe("fetch_failed");
    expect(reply.json.title).toContain("larger than 5 MB");
  });

  test("the limit applies after decompression (a gzip bomb fails)", async () => {
    const reply = await callEgress(h, { url: `http://public.test/gzip?n=${20 * MB}` });
    expect(reply.json.code).toBe("fetch_failed");
    expect(reply.json.title).toContain("larger than 5 MB");
  });

  test("a caller may ask for a lower limit", async () => {
    const reply = await callEgress(h, { url: "http://public.test/bytes?n=2000", maxResponseBytes: 1000 });
    expect(reply.json.code).toBe("fetch_failed");
  });
});

describe("time limit (fake clock)", () => {
  test("a server that stops sending is cut off at 10 s", async () => {
    const pending = callEgress(h, { url: "http://public.test/slow" });
    await h.slowArrived();
    await h.clock.advance(EGRESS_LIMITS.timeoutMs - 1);
    await h.clock.advance(1);
    const reply = await pending;
    expect(reply.status).toBe(502);
    expect(reply.json.code).toBe("fetch_failed");
    expect(reply.json.title).toContain("did not answer within 10 s");
  });

  test("a caller may ask for a shorter deadline", async () => {
    const pending = callEgress(h, { url: "http://public.test/slow", timeoutMs: 2000 });
    await h.slowArrived();
    await h.clock.advance(2000);
    const reply = await pending;
    expect(reply.json.code).toBe("fetch_failed");
    expect(reply.json.title).toContain("within 2 s");
  });
});

describe("redirects", () => {
  test("five hops are followed", async () => {
    const reply = await callEgress(h, { url: "http://public.test/hops?n=4" });
    expect(reply.json).toMatchObject({ status: 200, redirected: true, url: "http://public.test/ok" });
  });

  test("a sixth hop fails", async () => {
    const reply = await callEgress(h, { url: "http://public.test/hops?n=5" });
    expect(reply.status).toBe(502);
    expect(reply.json.code).toBe("fetch_failed");
    expect(reply.json.title).toContain("more than 5 redirects");
  });

  test("manual mode returns the redirect itself", async () => {
    const reply = await callEgress(h, { url: "http://public.test/hops?n=1", redirect: "manual" });
    expect(reply.json.status).toBe(302);
    expect(reply.json.headers).toContainEqual(["location", "/hops?n=0"]);
  });

  test("manual mode does not dial the target even when it is private", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/redirect?to=http://127.0.0.1/",
      redirect: "manual",
    });
    expect(reply.json.status).toBe(302);
  });

  test("303 turns a POST into a GET without a body", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/redirect?status=303&to=/echo",
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain" },
    });
    const echoed = JSON.parse(decode(reply));
    expect(echoed.method).toBe("GET");
    expect(echoed.body).toBe("");
    expect(echoed.headers["content-type"]).toBeUndefined();
  });

  test("307 keeps the method and body", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/redirect?status=307&to=/echo",
      method: "POST",
      body: "payload",
    });
    const echoed = JSON.parse(decode(reply));
    expect(echoed).toMatchObject({ method: "POST", body: "payload" });
  });

  test("credentials are not carried to another origin", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/redirect?to=http://public6.test/echo",
      headers: { authorization: "Bearer tenant", cookie: "s=1", "x-api-key": "kept" },
    });
    const headers = JSON.parse(decode(reply)).headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.host).toBe("public6.test");
  });

  test("credentials stay on a same-origin redirect", async () => {
    const reply = await callEgress(h, {
      url: "http://public.test/redirect?to=/echo",
      headers: { authorization: "Bearer tenant" },
    });
    expect(JSON.parse(decode(reply)).headers.authorization).toBe("Bearer tenant");
  });
});

describe("per-workspace rate limit (fake clock)", () => {
  let limited: Harness;

  beforeAll(async () => {
    limited = await startHarness({ rate: { perMinute: 60, burst: 3 } });
  });

  afterAll(async () => {
    expect(limited.canaryHits).toEqual([]);
    await limited.close();
  });

  test("a burst is allowed, then rate_limited with Retry-After, then allowed again as time passes", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await callEgress(limited, { url: "http://public.test/ok" })).json.status).toBe(200);
    }
    const refused = await callEgress(limited, { url: "http://public.test/ok" });
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe("rate_limited");
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(refused.json.fix).toBe("Wait 1 seconds and try again.");

    await limited.clock.advance(1000);
    expect((await callEgress(limited, { url: "http://public.test/ok" })).json.status).toBe(200);
  });

  test("another workspace has its own bucket", async () => {
    const reply = await callEgress(limited, { url: "http://public.test/ok", workspaceId: OTHER_WORKSPACE });
    expect(reply.json.status).toBe(200);
  });

  test("every redirect hop takes a token", async () => {
    await limited.clock.advance(60_000);
    // Three tokens: the first request and two hops.
    expect((await callEgress(limited, { url: "http://public.test/hops?n=1" })).json.status).toBe(200);
    const refused = await callEgress(limited, { url: "http://public.test/ok" });
    expect(refused.json.code).toBe("rate_limited");
  });

  test("blocked requests count too, so probing the policy is rate limited", async () => {
    await limited.clock.advance(60_000);
    for (let i = 0; i < 3; i++) {
      expect((await callEgress(limited, { url: "http://127.0.0.1/" })).json.code).toBe("fetch_blocked");
    }
    expect((await callEgress(limited, { url: "http://127.0.0.1/" })).json.code).toBe("rate_limited");
  });
});
