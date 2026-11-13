import { mintCapabilityToken } from "@wakeel/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { CAPABILITY_KEY, callEgress, decode, type Harness, OTHER_WORKSPACE, startHarness, WORKSPACE } from "./harness";

/**
 * Exec capability tokens (ADR-020 identity option b, ADR-023 §4): the sandbox sends the token the
 * worker minted for the exec; egress takes the workspace from it. The sandbox never holds a key.
 */

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

const seconds = () => Math.floor(h.clock.now() / 1000);
const token = (overrides: { ws?: string; exp?: number; key?: string } = {}) =>
  mintCapabilityToken(overrides.key ?? CAPABILITY_KEY, {
    ws: overrides.ws ?? WORKSPACE,
    exec: "exec_cap_1",
    exp: overrides.exp ?? seconds() + 60,
  });

describe("capability tokens", () => {
  test("a valid token is accepted without a workspace id in the body", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok" }, { capability: await token() });
    expect(reply.status).toBe(200);
    expect(decode(reply)).toBe("public ok");
  });

  test("a token signed with another key is refused", async () => {
    const other = await token({ key: "some-other-capability-key-0123456789" });
    const reply = await callEgress(h, { url: "http://public.test/ok" }, { capability: other });
    expect(reply.status).toBe(401);
    expect(reply.json.code).toBe("unauthenticated");
  });

  test("an expired token is refused", async () => {
    const reply = await callEgress(
      h,
      { url: "http://public.test/ok" },
      { capability: await token({ exp: seconds() }) },
    );
    expect(reply.status).toBe(401);
  });

  test("a garbled token is refused", async () => {
    const reply = await callEgress(h, { url: "http://public.test/ok" }, { capability: "wkc1.e30.AAAA" });
    expect(reply.status).toBe(401);
  });

  test("the body cannot name a different workspace than the token", async () => {
    const reply = await callEgress(
      h,
      { url: "http://public.test/ok", workspaceId: OTHER_WORKSPACE },
      { capability: await token() },
    );
    expect(reply.status).toBe(400);
    expect(reply.json.code).toBe("validation_failed");
    expect(reply.json.errors[0].path).toBe("workspaceId");
  });

  test("the body may repeat the token's workspace", async () => {
    const reply = await callEgress(
      h,
      { url: "http://public.test/ok", workspaceId: WORKSPACE },
      { capability: await token() },
    );
    expect(reply.status).toBe(200);
  });

  test("the address policy applies to capability callers too", async () => {
    const reply = await callEgress(h, { url: "http://127.0.0.1/" }, { capability: await token() });
    expect(reply.status).toBe(403);
    expect(reply.json.code).toBe("fetch_blocked");
  });

  test("a bearer caller still needs a workspace id", async () => {
    const res = await fetch(`${h.egressUrl}/v1/fetch`, {
      method: "POST",
      headers: { authorization: "Bearer test-egress-token-0123456789abcdef", "content-type": "application/json" },
      body: JSON.stringify({ url: "http://public.test/ok" }),
    });
    expect(res.status).toBe(400);
  });
});
