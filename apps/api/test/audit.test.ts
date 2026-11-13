import { randomBytes } from "node:crypto";
import { AUDIT_ACTIONS } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, type Stack, signUp, startStack } from "./stack";

/**
 * Task 1.6 acceptance: every mutation route in Phase 1 writes exactly one audit entry, in the same
 * transaction as the change. Sign-up, sign-in and sign-out change no workspace and are logged by
 * the request logger instead (see the PR).
 */
let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

interface Entry {
  id: string;
  action: string;
  actor: { type: string; id: string | null };
  target: { type: string; id: string } | null;
  meta: Record<string, unknown>;
  ip: string | null;
}

const entries = async (owner: Browser, ws: string): Promise<Entry[]> => {
  const res = await owner.get(`/v1/workspaces/${ws}/audit-log?limit=200`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
};

describe("every Phase 1 mutation route writes one entry", () => {
  test("each route, one after another, adds exactly its own action", async () => {
    const owner = await signUp(stack.app);
    const created = await owner.send("POST", "/v1/workspaces", {
      name: "Audit",
      slug: `a-${randomBytes(4).toString("hex")}`,
    });
    const ws = created.json().id as string;
    const seen = new Set<string>();

    /** Runs one mutation and checks that exactly one new entry, with `action`, appeared. */
    const expectOne = async (action: string, run: () => Promise<{ statusCode: number; body: string }>) => {
      const before = await entries(owner, ws);
      const res = await run();
      expect(res.statusCode, `${action}: ${res.body}`).toBeLessThan(300);
      const after = await entries(owner, ws);
      expect(after.length, action).toBe(before.length + 1);
      expect(after[0]?.action).toBe(action);
      seen.add(action);
      return after[0] as Entry;
    };

    // workspace.created was written with the workspace itself.
    const first = await entries(owner, ws);
    expect(first.map((e) => e.action)).toEqual(["workspace.created"]);
    expect(first[0]).toMatchObject({
      actor: { type: "user", id: owner.userId },
      target: { type: "workspace", id: ws },
    });
    seen.add("workspace.created");

    const renamed = await expectOne("workspace.updated", () =>
      owner.send("PATCH", `/v1/workspaces/${ws}`, { name: "Renamed" }),
    );
    expect(renamed.meta).toEqual({ name: { from: "Audit", to: "Renamed" } });

    const invitee = await signUp(stack.app);
    let token = "";
    let invitationId = "";
    const invited = await expectOne("invitation.created", async () => {
      const res = await owner.send("POST", `/v1/workspaces/${ws}/invitations`, {
        email: invitee.email,
        role: "builder",
      });
      token = new URL(res.json().acceptUrl).pathname.split("/").pop() ?? "";
      invitationId = res.json().id;
      return res;
    });
    expect(JSON.stringify(invited)).not.toContain(token);

    const joined = await expectOne("member.joined", () => invitee.send("POST", "/v1/invitations/accept", { token }));
    expect(joined.actor.id).toBe(invitee.userId);
    expect(joined.meta).toMatchObject({ invitationId, role: "builder" });

    const members = (await owner.get(`/v1/workspaces/${ws}/members`)).json().data as { id: string; userId: string }[];
    const inviteeMember = members.find((m) => m.userId === invitee.userId)?.id ?? "";
    const changed = await expectOne("member.role_changed", () =>
      owner.send("PATCH", `/v1/workspaces/${ws}/members/${inviteeMember}`, { role: "viewer" }),
    );
    expect(changed.meta).toMatchObject({ from: "builder", to: "viewer" });

    await expectOne("member.removed", () => owner.send("DELETE", `/v1/workspaces/${ws}/members/${inviteeMember}`));

    const second = await owner.send("POST", `/v1/workspaces/${ws}/invitations`, {
      email: "later@example.test",
      role: "viewer",
    });
    seen.add("invitation.created");
    const revokedInvitation = second.json().id;
    await expectOne("invitation.revoked", () =>
      owner.send("DELETE", `/v1/workspaces/${ws}/invitations/${revokedInvitation}`),
    );

    let key = "";
    let keyId = "";
    const keyCreated = await expectOne("api_key.created", async () => {
      const res = await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, { name: "CI", scopes: ["audit.read"] });
      key = res.json().key;
      keyId = res.json().id;
      return res;
    });
    expect(keyCreated.meta).toMatchObject({ name: "CI", scopes: ["audit.read"] });
    expect(JSON.stringify(keyCreated)).not.toContain(key.slice(-43));

    await expectOne("api_key.revoked", () => owner.send("DELETE", `/v1/workspaces/${ws}/api-keys/${keyId}`));

    // Every action routes can produce in this phase was seen; secrets get routes in 6.2.
    expect([...seen].sort()).toEqual(AUDIT_ACTIONS.filter((a) => !a.startsWith("secret.")).sort());
  });

  test("a mutation that fails writes nothing", async () => {
    const owner = await signUp(stack.app);
    const ws = (
      await owner.send("POST", "/v1/workspaces", { name: "Fail", slug: `f-${randomBytes(4).toString("hex")}` })
    ).json().id;
    const members = (await owner.get(`/v1/workspaces/${ws}/members`)).json().data;
    const before = await entries(owner, ws);
    // The last owner cannot step down: the transaction rolls back, entry included.
    const res = await owner.send("PATCH", `/v1/workspaces/${ws}/members/${members[0].id}`, { role: "admin" });
    expect(res.json().code).toBe("last_owner");
    expect(await entries(owner, ws)).toEqual(before);
  });
});

describe("reading the audit log", () => {
  test("pages newest first with a cursor, without gaps or repeats", async () => {
    const owner = await signUp(stack.app);
    const ws = (
      await owner.send("POST", "/v1/workspaces", { name: "P0", slug: `p-${randomBytes(4).toString("hex")}` })
    ).json().id;
    for (let i = 1; i <= 6; i++) await owner.send("PATCH", `/v1/workspaces/${ws}`, { name: `P${i}` });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const url = `/v1/workspaces/${ws}/audit-log?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await owner.get(url);
      const body = res.json() as { data: Entry[]; nextCursor: string | null };
      ids.push(...body.data.map((e) => e.id));
      cursor = body.nextCursor;
    } while (cursor !== null);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  test("a bad cursor is validation_failed", async () => {
    const owner = await signUp(stack.app);
    const ws = (
      await owner.send("POST", "/v1/workspaces", { name: "C", slug: `c-${randomBytes(4).toString("hex")}` })
    ).json().id;
    const res = await owner.get(`/v1/workspaces/${ws}/audit-log?cursor=not-a-cursor`);
    expect(res.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "cursor" }] });
  });

  test("builders and viewers cannot read it; a key with audit.read can", async () => {
    const owner = await signUp(stack.app);
    const ws = (
      await owner.send("POST", "/v1/workspaces", { name: "R", slug: `r-${randomBytes(4).toString("hex")}` })
    ).json().id;
    const builder = await signUp(stack.app);
    const inv = await owner.send("POST", `/v1/workspaces/${ws}/invitations`, { email: builder.email, role: "builder" });
    await builder.send("POST", "/v1/invitations/accept", {
      token: new URL(inv.json().acceptUrl).pathname.split("/").pop(),
    });
    expect((await builder.get(`/v1/workspaces/${ws}/audit-log`)).json().code).toBe("forbidden");
    const { key } = (
      await owner.send("POST", `/v1/workspaces/${ws}/api-keys`, { name: "SIEM", scopes: ["audit.read"] })
    ).json();
    const viaKey = await stack.app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws}/audit-log`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(viaKey.statusCode).toBe(200);
    expect(viaKey.json().data.length).toBeGreaterThan(0);
  });

  test("one workspace's entries never appear in another's", async () => {
    const a = await signUp(stack.app);
    const b = await signUp(stack.app);
    const wa = (
      await a.send("POST", "/v1/workspaces", { name: "A", slug: `a-${randomBytes(4).toString("hex")}` })
    ).json().id;
    const wb = (
      await b.send("POST", "/v1/workspaces", { name: "B", slug: `b-${randomBytes(4).toString("hex")}` })
    ).json().id;
    await a.send("PATCH", `/v1/workspaces/${wa}`, { name: "A2" });
    const inB = await entries(b, wb);
    expect(inB.every((e) => e.target?.id !== wa)).toBe(true);
    expect((await b.get(`/v1/workspaces/${wa}/audit-log`)).json().code).toBe("not_found");
  });
});
