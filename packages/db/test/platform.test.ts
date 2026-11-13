import { createHash, randomBytes } from "node:crypto";
import { AppError, newId } from "@wakeel/contracts";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  addMember,
  appendAudit,
  changeRole,
  countOwners,
  createDatabase,
  createInvitation,
  createWorkspace,
  type Database,
  deleteSecret,
  findMembershipByUser,
  getApiKey,
  getApiKeyForVerification,
  getInvitation,
  getSecret,
  getWorkspace,
  insertApiKey,
  listApiKeys,
  listAudit,
  listMembers,
  listOpenInvitations,
  listSecrets,
  markInvitationAccepted,
  platformTables,
  putSecret,
  removeMember,
  revokeApiKey,
  revokeInvitation,
  touchApiKey,
  updateWorkspace,
} from "../src/index";

/**
 * Task 1.1 acceptance: two-tenant tests for every tenant table in migration 0003, lookups that
 * return ids only, and the roles around them (architecture §2.1, ADR-004, ADR-015).
 */
const urls = inject("db");

let db: Database;
/** app_rw with no workspace set: what a forgotten withWorkspace would see. */
let bare: pg.Client;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomPrefix = () => randomBytes(8).toString("hex").slice(0, 8);
const randomSlug = () => `ws-${randomBytes(4).toString("hex")}`;

const query = async (url: string, text: string, values: unknown[] = []) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
};

/** Users are platform rows (no RLS); better-auth creates them in production (task 1.2). */
const createUser = async (name = "مستخدم Test") => {
  const id = newId("usr");
  await bare.query("insert into users (id, email, name) values ($1, $2, $3)", [id, `${id}@example.test`, name]);
  return id;
};

interface Tenant {
  workspaceId: string;
  ownerId: string;
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
  const make = async (): Promise<Tenant> => {
    const ownerId = await createUser();
    const { workspace } = await createWorkspace(db, { name: "مساحة عمل", slug: randomSlug(), ownerUserId: ownerId });
    return { workspaceId: workspace.id, ownerId };
  };
  a = await make();
  b = await make();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

/** Drizzle reports "Failed query: …" and keeps the Postgres error as `cause`. */
const expectDbError = async (promise: Promise<unknown>, pattern: RegExp) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(" | ")).toMatch(pattern);
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
};

/**
 * One row per tenant table, written through its repository. `count` reads the table as the
 * given workspace; `bareCount` with no workspace at all.
 */
const TENANT_TABLES = ["memberships", "invitations", "api_keys", "workspace_secrets", "audit_log"] as const;

const seedEveryTable = async (t: Tenant) =>
  db.withWorkspace(t.workspaceId, async (tx) => {
    const invitation = await createInvitation(tx, {
      email: `${newId("inv")}@example.test`,
      role: "builder",
      tokenHash: sha256(randomBytes(32).toString("hex")),
      invitedBy: t.ownerId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const key = await insertApiKey(tx, {
      kind: "workspace",
      name: "CI",
      prefix: randomPrefix(),
      secretHash: sha256("secret"),
      scopes: ["bots:read"],
      createdBy: t.ownerId,
    });
    await putSecret(tx, { name: "anthropic.api_key", ciphertext: Buffer.from("not-plaintext"), keyVersion: 1 });
    const audit = await appendAudit(tx, {
      actorType: "user",
      actorId: t.ownerId,
      action: "api_key.created",
      targetType: "api_key",
      targetId: key.id,
      meta: { name: "CI" },
    });
    return { invitationId: invitation.id, keyId: key.id, auditId: audit.id };
  });

describe("two tenants", () => {
  let seeded: Map<string, Awaited<ReturnType<typeof seedEveryTable>>>;

  beforeAll(async () => {
    seeded = new Map([
      [a.workspaceId, await seedEveryTable(a)],
      [b.workspaceId, await seedEveryTable(b)],
    ]);
  });

  const pairs = () => [
    { name: "A → B", owner: () => a, other: () => b },
    { name: "B → A", owner: () => b, other: () => a },
  ];

  describe.each(pairs())("$name", ({ owner, other }) => {
    test.each(TENANT_TABLES)("%s: the other tenant sees none of the owner's rows", async (table) => {
      const rows = await db.withWorkspace(other().workspaceId, async (tx) => {
        const r = await tx.execute(sql.raw(`select workspace_id from ${table}`));
        return r.rows as { workspace_id: string }[];
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.workspace_id === owner().workspaceId)).toEqual([]);
    });

    test.each(TENANT_TABLES)("%s: a connection with no workspace sees nothing", async (table) => {
      expect((await bare.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    });

    test.each(TENANT_TABLES)("%s: the other tenant cannot write a row into the owner's workspace", async (table) => {
      // Every table rejects the forged workspace_id on its own; the column values are otherwise valid.
      const forged: Record<(typeof TENANT_TABLES)[number], string> = {
        memberships: `insert into memberships (id, workspace_id, user_id, role) values ('${newId("mem")}', $1, '${other().ownerId}', 'owner')`,
        invitations: `insert into invitations (id, workspace_id, email, role, token_hash, expires_at) values ('${newId("inv")}', $1, 'x@example.test', 'admin', '${sha256("forged")}', now() + interval '1 day')`,
        api_keys: `insert into api_keys (id, workspace_id, kind, name, prefix, secret_hash) values ('${newId("key")}', $1, 'workspace', 'x', '${randomPrefix()}', '${sha256("x")}')`,
        workspace_secrets: `insert into workspace_secrets (id, workspace_id, name, ciphertext, key_version) values ('${newId("sec")}', $1, 'forged', '\\x00', 1)`,
        audit_log: `insert into audit_log (id, workspace_id, actor_type, action) values ('${newId("aud")}', $1, 'system', 'workspace.forged')`,
      };
      // Ids are generated by newId, so inlining them is safe; $1 is the owner's workspace.
      const statement = forged[table].replace("$1", `'${owner().workspaceId}'`);
      const error = await db
        .withWorkspace(other().workspaceId, (tx) => tx.execute(sql.raw(statement)))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(String((error as Error | undefined)?.cause ?? error)).toMatch(/row-level security/);
    });

    test("repositories in the other workspace cannot reach the owner's rows by id", async () => {
      const ids = seeded.get(owner().workspaceId);
      if (!ids) throw new Error("not seeded");
      await db.withWorkspace(other().workspaceId, async (tx) => {
        await expectCode(getInvitation(tx, ids.invitationId), "not_found");
        await expectCode(getApiKey(tx, ids.keyId), "not_found");
        await expectCode(revokeApiKey(tx, ids.keyId, new Date()), "not_found");
        await expectCode(revokeInvitation(tx, ids.invitationId, new Date()), "not_found");
        expect(await getApiKeyForVerification(tx, ids.keyId)).toBeUndefined();
        expect(await findMembershipByUser(tx, owner().ownerId)).toBeUndefined();
        expect((await listMembers(tx)).map((m) => m.userId)).toEqual([other().ownerId]);
        expect((await listAudit(tx, { limit: 50 })).map((e) => e.id)).not.toContain(ids.auditId);
        expect((await getSecret(tx, "anthropic.api_key"))?.ciphertext).toEqual(Buffer.from("not-plaintext"));
      });
      // The owner's own rows are still intact after the attempts above.
      await db.withWorkspace(owner().workspaceId, async (tx) => {
        expect((await getApiKey(tx, ids.keyId)).revokedAt).toBeNull();
        expect((await getInvitation(tx, ids.invitationId)).revokedAt).toBeNull();
      });
    });

    test("getWorkspace returns the scoped workspace, whatever the caller wants", async () => {
      const ws = await db.withWorkspace(other().workspaceId, getWorkspace);
      expect(ws.id).toBe(other().workspaceId);
    });
  });
});

describe("lookups (ADR-015)", () => {
  test("user_workspace_ids finds every workspace of a user, under forced RLS", async () => {
    const userId = await createUser();
    await db.withWorkspace(a.workspaceId, (tx) => addMember(tx, { userId, role: "viewer" }));
    await db.withWorkspace(b.workspaceId, (tx) => addMember(tx, { userId, role: "builder" }));
    expect((await db.lookup.userWorkspaceIds(userId)).sort()).toEqual([a.workspaceId, b.workspaceId].sort());
    expect(await db.lookup.userWorkspaceIds(newId("usr"))).toEqual([]);
  });

  test("api_key_by_prefix returns the key and workspace ids, and nothing else", async () => {
    const prefix = randomPrefix();
    const key = await db.withWorkspace(b.workspaceId, (tx) =>
      insertApiKey(tx, { kind: "workspace", name: "lookup", prefix, secretHash: sha256("s"), scopes: [] }),
    );
    expect(await db.lookup.apiKeyByPrefix(prefix)).toEqual({ keyId: key.id, workspaceId: b.workspaceId });
    expect(await db.lookup.apiKeyByPrefix("zzzzzzzz")).toBeUndefined();
  });

  test("invitation_by_token_hash returns the invitation and workspace ids", async () => {
    const tokenHash = sha256(randomBytes(32).toString("hex"));
    const invitation = await db.withWorkspace(a.workspaceId, (tx) =>
      createInvitation(tx, {
        email: `${newId("inv")}@example.test`,
        role: "viewer",
        tokenHash,
        invitedBy: a.ownerId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(await db.lookup.invitationByTokenHash(tokenHash)).toEqual({
      invitationId: invitation.id,
      workspaceId: a.workspaceId,
    });
  });

  test("every lookup function returns only id columns", async () => {
    const { rows } = await query(
      urls.superuser,
      `select p.proname, coalesce(p.proargnames[2:], array[]::text[]) as outs, format_type(p.prorettype, null) as ret,
              p.proretset
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'lookup' order by 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual(["api_key_by_prefix", "invitation_by_token_hash", "user_workspace_ids"]);
    for (const r of rows) {
      const outs = r.outs as string[];
      if (outs.length === 0) expect(r.ret).toBe("text");
      for (const name of outs) expect(name).toMatch(/_id$/);
    }
  });

  test("every security definer function is owned by app_lookup, pins search_path and is not public", async () => {
    const { rows } = await query(
      urls.superuser,
      `select p.oid::regprocedure::text as fn, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
              has_function_privilege('public', p.oid, 'execute') as public_exec,
              has_function_privilege('app_rw', p.oid, 'execute') as rw_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r, r.fn).toMatchObject({ owner: "app_lookup", public_exec: false, rw_exec: true });
      expect(r.config).toEqual(["search_path=pg_catalog, public"]);
    }
  });

  test("app_rw cannot read the lookup columns directly without a workspace", async () => {
    expect((await bare.query("select count(*)::int as n from api_keys")).rows[0].n).toBe(0);
  });
});

describe("roles around the platform tables", () => {
  test("app_lookup cannot log in", async () => {
    const { rows } = await query(
      urls.superuser,
      "select rolcanlogin, rolbypassrls from pg_roles where rolname = 'app_lookup'",
    );
    expect(rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: true });
  });

  test("app_rw cannot assume app_lookup", async () => {
    await expect(query(urls.rw, "set role app_lookup")).rejects.toThrow(/permission denied/);
  });

  test("app_admin_ro cannot assume app_lookup", async () => {
    await expect(query(urls.adminRo, "set role app_lookup")).rejects.toThrow(/permission denied/);
  });

  test("app_rw cannot change or delete audit entries", async () => {
    await db.withWorkspace(a.workspaceId, (tx) =>
      appendAudit(tx, { actorType: "system", action: "workspace.checked" }),
    );
    for (const statement of ["update audit_log set action = 'x.y'", "delete from audit_log", "truncate audit_log"]) {
      await expectDbError(
        db.withWorkspace(a.workspaceId, (tx) => tx.execute(sql.raw(statement))),
        /permission denied/,
      );
    }
  });

  test.each(["sessions", "accounts", "verifications"])("app_admin_ro cannot read %s", async (table) => {
    await expect(query(urls.adminRo, `select * from ${table} limit 1`)).rejects.toThrow(/permission denied/);
  });
});

describe("repositories", () => {
  test("a taken workspace slug is unique_violation", async () => {
    const slug = randomSlug();
    const owner = await createUser();
    await createWorkspace(db, { name: "One", slug, ownerUserId: owner });
    await expectCode(createWorkspace(db, { name: "Two", slug, ownerUserId: owner }), "unique_violation");
  });

  test("updateWorkspace renames the scoped workspace and validates settings", async () => {
    const ws = await db.withWorkspace(a.workspaceId, (tx) => updateWorkspace(tx, { name: "شركة الوكيل" }));
    expect(ws.name).toBe("شركة الوكيل");
    await expect(
      db.withWorkspace(a.workspaceId, (tx) => updateWorkspace(tx, { settings: { unknown: true } as never })),
    ).rejects.toThrow();
  });

  test("members: add, change role, count owners, remove", async () => {
    // A failed statement aborts its transaction, as it does for a request, so each error case gets its own.
    const userId = await createUser("Builder");
    const inA = <T>(fn: (tx: Parameters<Parameters<Database["withWorkspace"]>[1]>[0]) => Promise<T>) =>
      db.withWorkspace(a.workspaceId, fn);
    const m = await inA((tx) => addMember(tx, { userId, role: "builder" }));
    await expectCode(
      inA((tx) => addMember(tx, { userId, role: "viewer" })),
      "unique_violation",
    );
    expect((await inA((tx) => changeRole(tx, m.id, "owner"))).role).toBe("owner");
    expect(await inA(countOwners)).toBe(2);
    await inA((tx) => removeMember(tx, m.id));
    await expectCode(
      inA((tx) => removeMember(tx, m.id)),
      "not_found",
    );
    expect(await inA(countOwners)).toBe(1);
  });

  test("an invitation is accepted once, and never after it expires or is revoked", async () => {
    const now = new Date();
    const inA = <T>(fn: (tx: Parameters<Parameters<Database["withWorkspace"]>[1]>[0]) => Promise<T>) =>
      db.withWorkspace(a.workspaceId, fn);
    const make = (email: string, expiresAt: Date) =>
      inA((tx) =>
        createInvitation(tx, { email, role: "viewer", tokenHash: sha256(email), invitedBy: a.ownerId, expiresAt }),
      );
    const later = new Date(now.getTime() + 60_000);
    const open = await make(`open-${newId("inv")}@example.test`, later);
    // citext: the same address in another case is the same invitation.
    await expectCode(make(open.email.toUpperCase(), later), "unique_violation");
    expect((await inA((tx) => listOpenInvitations(tx, now))).map((i) => i.id)).toContain(open.id);
    const accepted = await inA((tx) => markInvitationAccepted(tx, open.id, a.ownerId, now));
    expect(accepted.acceptedBy).toBe(a.ownerId);
    expect("tokenHash" in accepted).toBe(false);
    await expectCode(
      inA((tx) => markInvitationAccepted(tx, open.id, a.ownerId, now)),
      "not_found",
    );

    const expired = await make(`expired-${newId("inv")}@example.test`, new Date(now.getTime() - 1));
    await expectCode(
      inA((tx) => markInvitationAccepted(tx, expired.id, a.ownerId, now)),
      "not_found",
    );
    const revoked = await make(`revoked-${newId("inv")}@example.test`, later);
    await inA((tx) => revokeInvitation(tx, revoked.id, now));
    await expectCode(
      inA((tx) => markInvitationAccepted(tx, revoked.id, a.ownerId, now)),
      "not_found",
    );
  });

  test("api keys: the hash never appears in records; revoke once; touch records use", async () => {
    await db.withWorkspace(b.workspaceId, async (tx) => {
      const key = await insertApiKey(tx, {
        kind: "workspace",
        name: "deploy",
        prefix: randomPrefix(),
        secretHash: sha256("deploy-secret"),
        scopes: [],
      });
      expect(Object.keys(key)).not.toContain("secretHash");
      expect((await getApiKeyForVerification(tx, key.id))?.secretHash).toBe(sha256("deploy-secret"));
      const used = new Date("2026-11-13T10:00:00.000Z");
      await touchApiKey(tx, key.id, used);
      expect((await getApiKey(tx, key.id)).lastUsedAt).toEqual(used);
      await revokeApiKey(tx, key.id, new Date());
      await expectCode(revokeApiKey(tx, key.id, new Date()), "not_found");
      expect((await listApiKeys(tx, "workspace")).find((k) => k.id === key.id)?.revokedAt).not.toBeNull();
    });
  });

  test("a bridge key needs a connection and a workspace key must not have one", async () => {
    await expectDbError(
      db.withWorkspace(b.workspaceId, (tx) =>
        insertApiKey(tx, { kind: "bridge", name: "x", prefix: randomPrefix(), secretHash: sha256("x"), scopes: [] }),
      ),
      /check constraint/,
    );
    await expectDbError(
      db.withWorkspace(b.workspaceId, (tx) =>
        insertApiKey(tx, {
          kind: "workspace",
          name: "x",
          prefix: randomPrefix(),
          secretHash: sha256("x"),
          scopes: [],
          connectionId: newId("conn"),
        }),
      ),
      /check constraint/,
    );
  });

  test("secrets: put replaces, list hides ciphertext, delete removes", async () => {
    await db.withWorkspace(b.workspaceId, async (tx) => {
      await putSecret(tx, { name: "openai.api_key", ciphertext: Buffer.from([1]), keyVersion: 1 });
      await putSecret(tx, { name: "openai.api_key", ciphertext: Buffer.from([2]), keyVersion: 2 });
      expect(await getSecret(tx, "openai.api_key")).toMatchObject({ ciphertext: Buffer.from([2]), keyVersion: 2 });
      const listed = await listSecrets(tx);
      expect(listed.map((s) => s.name)).toContain("openai.api_key");
      expect(Object.keys(listed[0] ?? {})).not.toContain("ciphertext");
      await deleteSecret(tx, "openai.api_key");
      expect(await getSecret(tx, "openai.api_key")).toBeUndefined();
      await expectCode(deleteSecret(tx, "openai.api_key"), "not_found");
    });
  });

  test("audit entries page newest first without gaps or repeats", async () => {
    const { workspace } = await createWorkspace(db, {
      name: "Audit",
      slug: randomSlug(),
      ownerUserId: await createUser(),
    });
    const base = Date.parse("2026-11-13T09:00:00.000Z");
    await db.withWorkspace(workspace.id, async (tx) => {
      // Two entries share a timestamp so the id tiebreak is exercised.
      for (const offset of [0, 1000, 1000, 2000, 3000]) {
        await appendAudit(tx, { actorType: "system", action: "workspace.ticked", at: new Date(base + offset) });
      }
    });
    const seen: string[] = [];
    let before: { at: Date; id: string } | undefined;
    for (;;) {
      const page = await db.withWorkspace(workspace.id, (tx) =>
        listAudit(tx, before === undefined ? { limit: 2 } : { limit: 2, before }),
      );
      if (page.length === 0) break;
      seen.push(...page.map((e) => e.id));
      const last = page[page.length - 1];
      if (!last) break;
      before = { at: last.at, id: last.id };
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort().reverse()).toEqual(seen);
  });

  test("audit meta must be JSON and the action must be area.verb", async () => {
    await expect(
      db.withWorkspace(a.workspaceId, (tx) => appendAudit(tx, { actorType: "system", action: "Created" })),
    ).rejects.toThrow();
    await expect(
      db.withWorkspace(a.workspaceId, (tx) =>
        appendAudit(tx, { actorType: "system", action: "a.b", meta: { when: new Date() as never } }),
      ),
    ).rejects.toThrow();
  });
});

describe("Drizzle schema agrees with migration 0003", () => {
  test.each(Object.values(platformTables).map((t) => [getTableName(t), t] as const))("%s", async (name, table) => {
    const { rows } = await query(
      urls.superuser,
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name",
      [name],
    );
    const inDb = rows.map((r) => r.column_name as string);
    const inDrizzle = Object.values(getTableColumns(table))
      .map((c) => c.name)
      .sort();
    expect(inDrizzle).toEqual(inDb);
  });
});
