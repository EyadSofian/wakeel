import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import { superuserQuery } from "@wakeel/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { requirePermission } from "../src/studio";
import { type Browser, STUDIO, type Stack, signUp, startStack } from "./stack";

/**
 * Task 1.3 integration: the guard, the workspace switcher, members and invitations. "A viewer
 * cannot mutate a bot" is tested on a probe route guarded by `bot.update`, because bot routes
 * arrive in 2.1; they use the same guard.
 */
let stack: Stack;
let clock = new Date("2026-11-13T10:00:00.000Z");

beforeAll(async () => {
  stack = await startStack({
    now: () => clock,
    // Stands in for PATCH /bots/{botId} until 2.1, with the guard and deps the real routes use.
    extraRoutes: (app, deps) => {
      app.patch("/v1/workspaces/:workspaceId/__probe/bot-update", async (request, reply) => {
        await requirePermission(deps, request, reply, "bot.update");
        return { ok: true };
      });
    },
  });
});

afterAll(async () => {
  await stack?.stop();
});

const slug = () => `ws-${randomBytes(4).toString("hex")}`;

/** A workspace with one member of each role. */
const team = async () => {
  const owner = await signUp(stack.app);
  const created = await owner.send("POST", "/v1/workspaces", { name: "وكيل", slug: slug() });
  expect(created.statusCode, created.body).toBe(201);
  const ws = created.json().id as string;
  const members: Record<"admin" | "builder" | "viewer", Browser> = {
    admin: await signUp(stack.app),
    builder: await signUp(stack.app),
    viewer: await signUp(stack.app),
  };
  for (const [role, member] of Object.entries(members)) {
    const inv = await owner.send("POST", `/v1/workspaces/${ws}/invitations`, { email: member.email, role });
    expect(inv.statusCode, inv.body).toBe(201);
    const token = new URL(inv.json().acceptUrl).pathname.split("/").pop();
    const accepted = await member.send("POST", "/v1/invitations/accept", { token });
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  const list = (await owner.get(`/v1/workspaces/${ws}/members`)).json().data as { id: string; userId: string }[];
  const memberId = (b: Browser) => list.find((m) => m.userId === b.userId)?.id ?? "";
  return { ws, owner, ...members, memberId, ownerMemberId: memberId(owner) };
};

describe("workspaces", () => {
  test("creating one makes the caller its owner, with the owner's permissions", async () => {
    const user = await signUp(stack.app);
    const res = await user.send("POST", "/v1/workspaces", { name: "Engosoft", slug: slug() });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Engosoft", role: "owner", settings: {} });
    expect(res.json().permissions).toContain("workspace.delete");
  });

  test("the switcher lists every workspace of the user with their role, and no others", async () => {
    const t = await team();
    const other = await signUp(stack.app);
    await other.send("POST", "/v1/workspaces", { name: "Other", slug: slug() });
    const own = await t.viewer.send("POST", "/v1/workspaces", { name: "A viewer's own", slug: slug() });
    const list = (await t.viewer.get("/v1/workspaces")).json();
    expect(list.nextCursor).toBeNull();
    expect(list.data.map((w: { id: string; role: string }) => [w.id, w.role]).sort()).toEqual(
      [
        [t.ws, "viewer"],
        [own.json().id, "owner"],
      ].sort(),
    );
  });

  test("a workspace the user does not belong to is not_found, not forbidden", async () => {
    const t = await team();
    const outsider = await signUp(stack.app);
    for (const res of [
      await outsider.get(`/v1/workspaces/${t.ws}`),
      await outsider.get(`/v1/workspaces/${t.ws}/members`),
      await outsider.send("PATCH", `/v1/workspaces/${t.ws}`, { name: "Taken" }),
      await outsider.get(`/v1/workspaces/${newId("ws")}`),
      await outsider.get("/v1/workspaces/not-an-id"),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("not_found");
    }
  });

  test("a slug that is taken is unique_violation", async () => {
    const user = await signUp(stack.app);
    const s = slug();
    await user.send("POST", "/v1/workspaces", { name: "One", slug: s });
    const again = await user.send("POST", "/v1/workspaces", { name: "Two", slug: s });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "unique_violation" });
  });
});

describe("a viewer cannot change anything", () => {
  test("PATCH workspace, invite, change roles and remove members are forbidden", async () => {
    const t = await team();
    for (const res of [
      await t.viewer.send("PATCH", `/v1/workspaces/${t.ws}`, { name: "Viewer was here" }),
      await t.viewer.send("POST", `/v1/workspaces/${t.ws}/invitations`, { email: "x@example.test", role: "viewer" }),
      await t.viewer.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.builder)}`, { role: "viewer" }),
      await t.viewer.send("DELETE", `/v1/workspaces/${t.ws}/members/${t.memberId(t.builder)}`),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe("forbidden");
    }
    // It can still read.
    expect((await t.viewer.get(`/v1/workspaces/${t.ws}`)).json().name).toBe("وكيل");
    expect((await t.viewer.get(`/v1/workspaces/${t.ws}/members`)).json().data).toHaveLength(4);
  });

  test("a probe route guarded by bot.update refuses a viewer and lets a builder through", async () => {
    const t = await team();
    const probe = async (b: Browser) =>
      stack.app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${t.ws}/__probe/bot-update`,
        headers: { cookie: b.cookie, origin: STUDIO, "x-csrf-token": b.csrf },
        payload: {},
      });
    expect((await probe(t.viewer)).json().code).toBe("forbidden");
    expect((await probe(t.builder)).statusCode).toBe(200);
  });
});

describe("members and owners", () => {
  test("an admin changes a builder to viewer but cannot touch an owner or make one", async () => {
    const t = await team();
    const ok = await t.admin.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.builder)}`, {
      role: "viewer",
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().role).toBe("viewer");
    for (const res of [
      await t.admin.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.ownerMemberId}`, { role: "admin" }),
      await t.admin.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.viewer)}`, { role: "owner" }),
      await t.admin.send("DELETE", `/v1/workspaces/${t.ws}/members/${t.ownerMemberId}`),
      await t.admin.send("POST", `/v1/workspaces/${t.ws}/invitations`, { email: "o@example.test", role: "owner" }),
    ]) {
      expect(res.json().code, res.body).toBe("forbidden");
    }
  });

  test("a builder cannot manage members", async () => {
    const t = await team();
    const res = await t.builder.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.viewer)}`, {
      role: "builder",
    });
    expect(res.json().code).toBe("forbidden");
  });

  test("the last owner cannot be demoted or removed; with two owners one can step down", async () => {
    const t = await team();
    const demote = await t.owner.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.ownerMemberId}`, { role: "admin" });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe("last_owner");
    expect((await t.owner.send("DELETE", `/v1/workspaces/${t.ws}/members/${t.ownerMemberId}`)).json().code).toBe(
      "last_owner",
    );

    await t.owner.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.admin)}`, { role: "owner" });
    const stepDown = await t.owner.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.ownerMemberId}`, {
      role: "admin",
    });
    expect(stepDown.statusCode, stepDown.body).toBe(200);
  });

  test("two owners demoting each other at once leave one owner", async () => {
    const t = await team();
    await t.owner.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.admin)}`, { role: "owner" });
    const [a, b] = await Promise.all([
      t.owner.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.memberId(t.admin)}`, { role: "admin" }),
      t.admin.send("PATCH", `/v1/workspaces/${t.ws}/members/${t.ownerMemberId}`, { role: "admin" }),
    ]);
    // Whichever commits first wins. The other sees either one owner left (last_owner) or, if it
    // started after the demotion, an admin trying to change an owner (forbidden).
    const outcomes = [a, b].map((r) => (r.statusCode === 200 ? "ok" : r.json().code));
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(["last_owner", "forbidden"]).toContain(outcomes.find((o) => o !== "ok"));
    const owners = (await t.owner.get(`/v1/workspaces/${t.ws}/members`))
      .json()
      .data.filter((m: { role: string }) => m.role === "owner");
    expect(owners).toHaveLength(1);
  });

  test("removing a member takes away their access", async () => {
    const t = await team();
    expect((await t.owner.send("DELETE", `/v1/workspaces/${t.ws}/members/${t.memberId(t.builder)}`)).statusCode).toBe(
      204,
    );
    expect((await t.builder.get(`/v1/workspaces/${t.ws}`)).statusCode).toBe(404);
    expect((await t.builder.get("/v1/workspaces")).json().data).toEqual([]);
  });
});

describe("invitations", () => {
  test("the link is returned once; only its hash is stored", async () => {
    const t = await team();
    const res = await t.owner.send("POST", `/v1/workspaces/${t.ws}/invitations`, {
      email: "new@example.test",
      role: "builder",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    const token = new URL(res.json().acceptUrl).pathname.split("/").pop() ?? "";
    expect(res.json().acceptUrl.startsWith(`${STUDIO}/invite/`)).toBe(true);
    const listed = (await t.owner.get(`/v1/workspaces/${t.ws}/invitations`)).json().data;
    expect(JSON.stringify(listed)).not.toContain(token);
    const stored = JSON.stringify(await superuserQuery(stack.pg.urls, "select * from invitations"));
    expect(stored).not.toContain(token);
  });

  test("someone else's account cannot use the link, and a link works once", async () => {
    const t = await team();
    const invited = "invited-once@example.test".replace("@", `${Date.now()}@`);
    const res = await t.owner.send("POST", `/v1/workspaces/${t.ws}/invitations`, { email: invited, role: "viewer" });
    const token = new URL(res.json().acceptUrl).pathname.split("/").pop();
    const stranger = await signUp(stack.app);
    expect((await stranger.send("POST", "/v1/invitations/accept", { token })).json().code).toBe("not_found");
    const right = await signUp(stack.app, invited.toUpperCase());
    expect((await right.send("POST", "/v1/invitations/accept", { token })).statusCode).toBe(200);
    expect((await right.send("POST", "/v1/invitations/accept", { token })).json().code).toBe("not_found");
  });

  test("an expired or revoked link is not_found", async () => {
    const t = await team();
    const make = async (email: string) => {
      const res = await t.owner.send("POST", `/v1/workspaces/${t.ws}/invitations`, { email, role: "viewer" });
      return { id: res.json().id as string, token: new URL(res.json().acceptUrl).pathname.split("/").pop() };
    };
    const stamp = Date.now();
    const revoked = await make(`revoked${stamp}@example.test`);
    expect((await t.owner.send("DELETE", `/v1/workspaces/${t.ws}/invitations/${revoked.id}`)).statusCode).toBe(204);
    const r = await signUp(stack.app, `revoked${stamp}@example.test`);
    expect((await r.send("POST", "/v1/invitations/accept", { token: revoked.token })).json().code).toBe("not_found");

    const expiring = await make(`expired${stamp}@example.test`);
    const e = await signUp(stack.app, `expired${stamp}@example.test`);
    const saved = clock;
    clock = new Date(saved.getTime() + 8 * 86_400_000);
    try {
      expect((await e.send("POST", "/v1/invitations/accept", { token: expiring.token })).json().code).toBe("not_found");
    } finally {
      clock = saved;
    }
  });

  test("inviting someone who is already a member is unique_violation", async () => {
    const t = await team();
    const res = await t.owner.send("POST", `/v1/workspaces/${t.ws}/invitations`, {
      email: t.viewer.email,
      role: "admin",
    });
    expect(res.json().code).toBe("unique_violation");
  });

  test("mutations need the CSRF token", async () => {
    const t = await team();
    const res = await stack.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${t.ws}`,
      headers: { cookie: t.owner.cookie, origin: STUDIO },
      payload: { name: "No token" },
    });
    expect(res.json().code).toBe("csrf_failed");
  });
});
