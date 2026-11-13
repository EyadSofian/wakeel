import { createHash, randomBytes } from "node:crypto";
import { superuserQuery } from "@wakeel/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { requirePermission } from "../src/studio";
import { type Browser, type Stack, signUp, startStack } from "./stack";

/**
 * Task 1.4 acceptance: a key works; a revoked key is unauthenticated; only the hash is in the
 * database; a key from workspace A cannot read workspace B.
 */
let stack: Stack;
let clock = new Date("2026-11-13T10:00:00.000Z");

beforeAll(async () => {
  stack = await startStack({
    now: () => clock,
    extraRoutes: (app, deps) => {
      // Stand-ins for bot routes (2.1) and conversation routes (10.2), with the real guard.
      app.patch("/v1/workspaces/:workspaceId/__probe/bot-update", async (request, reply) => {
        const ctx = await requirePermission(deps, request, reply, "bot.update");
        return { actor: ctx.type };
      });
      app.get("/v1/workspaces/:workspaceId/__probe/conversations", async (request, reply) => {
        await requirePermission(deps, request, reply, "conversation.read");
        return { ok: true };
      });
    },
  });
});

afterAll(async () => {
  await stack?.stop();
});

const newWorkspace = async (owner: Browser) => {
  const res = await owner.send("POST", "/v1/workspaces", { name: "Keys", slug: `k-${randomBytes(4).toString("hex")}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

const createKey = async (owner: Browser, ws: string, scopes = ["workspace.read", "bot.update"], extra = {}) => {
  const res = await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, { name: "CI", scopes, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; key: string; prefix: string };
};

const withKey = (key: string, method: "GET" | "PATCH", url: string) =>
  stack.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(method === "GET" ? {} : { payload: {} }),
  });

describe("creating a key", () => {
  test("returns the key once, with no-store; listing never shows it", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const res = await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, { name: "CI", scopes: ["workspace.read"] });
    expect(res.headers["cache-control"]).toBe("no-store");
    const created = res.json();
    expect(created.key).toMatch(/^wk_live_[0-9a-z]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.key.startsWith(created.prefix)).toBe(true);
    const list = await owner.get(`/v1/workspaces/${ws}/api-keys`);
    expect(list.json().data.map((k: { id: string }) => k.id)).toEqual([created.id]);
    expect(list.body).not.toContain(created.key.slice(-43));
  });

  test("only the SHA-256 of the secret is in the database", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key, id } = await createKey(owner, ws);
    const secret = key.slice(-43);
    const rows = await superuserQuery(stack.pg.urls, "select * from api_keys where id = $1", [id]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]?.["secret_hash"]).toBe(createHash("sha256").update(secret).digest("hex"));
  });

  test("scopes that manage people, keys or secrets are refused", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    for (const scope of ["member.invite", "api_key.create", "secret.read", "workspace.delete", "made.up"]) {
      const res = await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, { name: "x", scopes: [scope] });
      expect(res.statusCode, scope).toBe(400);
      expect(res.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "scopes" }] });
    }
  });

  test("an expiry in the past is refused", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const res = await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, {
      name: "x",
      scopes: ["workspace.read"],
      expiresAt: new Date(clock.getTime() - 1000).toISOString(),
    });
    expect(res.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "expiresAt" }] });
  });
});

describe("using a key", () => {
  test("works for its scopes, records last use, and never needs CSRF", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key, id } = await createKey(owner, ws);
    const read = await withKey(key, "GET", `/v1/workspaces/${ws}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ id: ws, role: null, permissions: ["workspace.read", "bot.update"] });
    const write = await withKey(key, "PATCH", `/v1/workspaces/${ws}/__probe/bot-update`);
    expect(write.json()).toEqual({ actor: "api_key" });
    const [row] = await superuserQuery(stack.pg.urls, "select last_used_at from api_keys where id = $1", [id]);
    expect(new Date(String(row?.["last_used_at"])).toISOString()).toBe(clock.toISOString());
  });

  test("last use is written at most once a minute", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key, id } = await createKey(owner, ws);
    const lastUsed = async () =>
      String(
        (await superuserQuery(stack.pg.urls, "select last_used_at from api_keys where id = $1", [id]))[0]?.[
          "last_used_at"
        ],
      );
    const saved = clock;
    try {
      await withKey(key, "GET", `/v1/workspaces/${ws}`);
      const first = await lastUsed();
      clock = new Date(saved.getTime() + 30_000);
      await withKey(key, "GET", `/v1/workspaces/${ws}`);
      expect(await lastUsed()).toBe(first);
      clock = new Date(saved.getTime() + 61_000);
      await withKey(key, "GET", `/v1/workspaces/${ws}`);
      expect(await lastUsed()).not.toBe(first);
    } finally {
      clock = saved;
    }
  });

  test("a permission outside its scopes is forbidden", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key } = await createKey(owner, ws, ["workspace.read"]);
    expect((await withKey(key, "GET", `/v1/workspaces/${ws}/__probe/conversations`)).json().code).toBe("forbidden");
    expect((await withKey(key, "PATCH", `/v1/workspaces/${ws}/__probe/bot-update`)).json().code).toBe("forbidden");
  });

  test("people-only routes refuse any key", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key } = await createKey(owner, ws, ["workspace.read", "bot.read"]);
    for (const url of [`/v1/workspaces/${ws}/members`, `/v1/workspaces/${ws}/api-keys`]) {
      expect((await withKey(key, "GET", url)).json().code, url).toBe("forbidden");
    }
  });

  test("a revoked key is unauthenticated", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key, id } = await createKey(owner, ws);
    expect((await owner.send("DELETE", `/v1/workspaces/${ws}/api-keys/${id}`)).statusCode).toBe(204);
    const res = await withKey(key, "GET", `/v1/workspaces/${ws}`);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("unauthenticated");
    expect((await owner.send("DELETE", `/v1/workspaces/${ws}/api-keys/${id}`)).json().code).toBe("not_found");
  });

  test("an expired key is unauthenticated", async () => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key } = await createKey(owner, ws, ["workspace.read"], {
      expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
    });
    expect((await withKey(key, "GET", `/v1/workspaces/${ws}`)).statusCode).toBe(200);
    const saved = clock;
    clock = new Date(saved.getTime() + 3_600_000);
    try {
      expect((await withKey(key, "GET", `/v1/workspaces/${ws}`)).json().code).toBe("unauthenticated");
    } finally {
      clock = saved;
    }
  });

  test.each([
    ["a wrong secret for a real prefix", (k: string) => `${k.slice(0, -43)}${"A".repeat(43)}`],
    ["an unknown prefix", () => `wk_live_zzzzzzzz_${"A".repeat(43)}`],
    ["a bridge key marker", (k: string) => k.replace("wk_live_", "wk_bridge_")],
    ["not our format", () => "sk-something"],
    ["Basic auth", () => "Basic dXNlcjpwYXNz"],
  ])("%s is unauthenticated", async (_name, make) => {
    const owner = await signUp(stack.app);
    const ws = await newWorkspace(owner);
    const { key } = await createKey(owner, ws);
    const value = make(key);
    const res = await stack.app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws}`,
      headers: { authorization: value.startsWith("Basic") ? value : `Bearer ${value}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("unauthenticated");
  });
});

describe("two workspaces", () => {
  test("a key from workspace A cannot read or write workspace B, in both directions", async () => {
    const ownerA = await signUp(stack.app);
    const ownerB = await signUp(stack.app);
    const a = await newWorkspace(ownerA);
    const b = await newWorkspace(ownerB);
    const keyA = (await createKey(ownerA, a)).key;
    const keyB = (await createKey(ownerB, b)).key;
    for (const [key, own, other] of [
      [keyA, a, b],
      [keyB, b, a],
    ] as const) {
      expect((await withKey(key, "GET", `/v1/workspaces/${own}`)).statusCode).toBe(200);
      for (const res of [
        await withKey(key, "GET", `/v1/workspaces/${other}`),
        await withKey(key, "PATCH", `/v1/workspaces/${other}/__probe/bot-update`),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("not_found");
      }
    }
  });

  test("an owner of B cannot list or revoke A's keys", async () => {
    const ownerA = await signUp(stack.app);
    const ownerB = await signUp(stack.app);
    const a = await newWorkspace(ownerA);
    await newWorkspace(ownerB);
    const { id } = await createKey(ownerA, a);
    expect((await ownerB.get(`/v1/workspaces/${a}/api-keys`)).json().code).toBe("not_found");
    expect((await ownerB.send("DELETE", `/v1/workspaces/${a}/api-keys/${id}`)).json().code).toBe("not_found");
  });
});
