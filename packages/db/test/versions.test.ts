import { randomBytes } from "node:crypto";
import { AppError, BotManifest, EvalCase, newId, seedSubWorkflow, type Workflow } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  assembleDraft,
  canonicalJson,
  createBot,
  createDatabase,
  createEvalRun,
  createEvalSuite,
  createWorkflowDoc,
  createWorkspace,
  type Database,
  deleteBot,
  getBot,
  getDraftDoc,
  listDraftDocs,
  listVersions,
  loadVersionDefinition,
  publishDraft,
  restoreVersion,
  rollbackTo,
  saveDraftDoc,
  saveEvalCase,
  saveEvalRunStatus,
  sql,
  startEvalRun,
} from "../src/index";

/** Task 7.1 (ADR-036): publish, hash, rollback, restore; immutability; two tenants. */
const urls = inject("db");
let db: Database;
let bare: pg.Client;

const tenant = async () => {
  const userId = newId("usr");
  await bare.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [
    userId,
    `${userId}@example.test`,
  ]);
  const { workspace } = await createWorkspace(db, {
    name: "Versions",
    slug: `v-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  return { ws: workspace.id, userId };
};

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

/** A bot whose draft validates: the seeded Autonomous node gets instructions. */
async function publishableBot(t: { ws: string; userId: string }, name = "مساعد المتجر") {
  return db.withWorkspace(t.ws, async (tx) => {
    const bot = await createBot(tx, { name, slug: `b-${randomBytes(3).toString("hex")}`, createdBy: t.userId });
    const docs = await listDraftDocs(tx, bot.id);
    const main = docs.find((d) => d.kind === "workflow");
    if (!main) throw new Error("no main workflow");
    const wf = main.doc as Workflow;
    await saveDraftDoc(tx, {
      botId: bot.id,
      kind: "workflow",
      docId: wf.id,
      expectedRev: main.rev,
      doc: {
        ...wf,
        nodes: wf.nodes.map((n) => (n.type === "autonomous" ? { ...n, instructions: "ساعد العميل في طلبه." } : n)),
      },
      userId: t.userId,
    });
    return { bot, mainId: wf.id };
  });
}

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

describe("canonicalJson", () => {
  test("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("publish", () => {
  test("the optional eval gate checks the latest completed results for this exact draft", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    const publish = () =>
      db.withWorkspace(t.ws, (tx) =>
        publishDraft(tx, {
          botId: bot.id,
          label: "بوابة التقييم",
          userId: t.userId,
        }),
      );
    await db.withWorkspace(t.ws, async (tx) => {
      const suite = await createEvalSuite(tx, bot.id, "الطلبات");
      await saveEvalCase(tx, bot.id, suite.id, EvalCase.parse({ name: "فاتورة", turns: [{ user: "فاتورة ORD-12" }] }));
      const run = await createEvalRun(tx, bot.id, suite.id, { kind: "draft" });
      await startEvalRun(tx, run.id);
      await saveEvalRunStatus(tx, run.id, "failed");
      const stored = (await listDraftDocs(tx, bot.id)).find((item) => item.kind === "manifest");
      if (!stored) throw new Error("missing manifest");
      const manifest = BotManifest.parse(stored.doc);
      await saveDraftDoc(tx, {
        botId: bot.id,
        kind: "manifest",
        docId: "manifest",
        expectedRev: stored.rev,
        userId: t.userId,
        doc: { ...manifest, settings: { ...manifest.settings, blockPublishOnFailingEvals: true } },
      });
    });
    await expect(publish()).rejects.toMatchObject({ code: "eval_publish_blocked" });
    await db.withWorkspace(t.ws, async (tx) => {
      const stored = (await listDraftDocs(tx, bot.id)).find((item) => item.kind === "manifest");
      if (!stored) throw new Error("missing manifest");
      await saveDraftDoc(tx, {
        botId: bot.id,
        kind: "manifest",
        docId: "manifest",
        expectedRev: stored.rev,
        userId: t.userId,
        doc: { ...BotManifest.parse(stored.doc), description: "تحديث المحتوى" },
      });
    });
    await expect(publish()).resolves.toMatchObject({ version: { number: 1 } });
  });

  test("is refused with the issue list while the draft has errors, and nothing is stored", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) =>
      createBot(tx, { name: "Draft", slug: "draft", createdBy: t.userId }),
    );
    const e = await failure(
      db.withWorkspace(t.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v1", userId: t.userId })),
    );
    expect(e.code).toBe("definition_invalid");
    expect(e.params).toEqual({ count: 1 });
    expect(e.errors?.map((i) => i.code)).toEqual(["autonomous_instructions_empty"]);
    const after = await db.withWorkspace(t.ws, async (tx) => ({
      bot: await getBot(tx, bot.id),
      versions: await listVersions(tx, bot.id, { limit: 10 }),
    }));
    expect(after.bot.publishedVersionId).toBeNull();
    expect(after.versions.data).toEqual([]);
  });

  test("stores numbered versions, makes the newest live, and identical drafts hash the same", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    const v1 = await db.withWorkspace(t.ws, (tx) =>
      publishDraft(tx, { botId: bot.id, label: "First", userId: t.userId }),
    );
    const v2 = await db.withWorkspace(t.ws, (tx) =>
      publishDraft(tx, { botId: bot.id, label: "Same again", notes: "No change", userId: t.userId }),
    );
    expect([v1.version.number, v2.version.number]).toEqual([1, 2]);
    expect(v2.version.definitionHash).toBe(v1.version.definitionHash);
    expect(v1.version.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    const live = await db.withWorkspace(t.ws, (tx) => getBot(tx, bot.id));
    expect(live.publishedVersionId).toBe(v2.version.id);
    // The stored definition is the draft as it was, Arabic text byte for byte.
    const def = await db.withWorkspace(t.ws, (tx) => loadVersionDefinition(tx, v1.version.id));
    const draft = await db.withWorkspace(t.ws, (tx) => assembleDraft(tx, bot.id));
    expect(def).toEqual(draft);
    expect(def.manifest.name).toBe("مساعد المتجر");
  });

  test("a changed draft hashes differently; the list pages newest first", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const v = await db.withWorkspace(t.ws, async (tx) => {
        const m = await getDraftDoc(tx, bot.id, "manifest", "manifest");
        await saveDraftDoc(tx, {
          botId: bot.id,
          kind: "manifest",
          docId: "manifest",
          expectedRev: m.rev,
          doc: { ...(m.doc as object), name: `Store ${i}` },
          userId: t.userId,
        });
        return publishDraft(tx, { botId: bot.id, label: `v${i + 1}`, userId: t.userId });
      });
      hashes.push(v.version.definitionHash);
    }
    expect(new Set(hashes).size).toBe(3);
    const page1 = await db.withWorkspace(t.ws, (tx) => listVersions(tx, bot.id, { limit: 2 }));
    expect(page1.data.map((v) => v.number)).toEqual([3, 2]);
    expect(page1.next).toBe(2);
    const page2 = await db.withWorkspace(t.ws, (tx) => listVersions(tx, bot.id, { limit: 2, before: 2 }));
    expect(page2.data.map((v) => v.number)).toEqual([1]);
    expect(page2.next).toBeNull();
  });
});

describe("rollback and restore", () => {
  test("rollback changes only the live pointer", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    const v1 = await db.withWorkspace(t.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v1", userId: t.userId }));
    await db.withWorkspace(t.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v2", userId: t.userId }));
    const before = await db.withWorkspace(t.ws, async (tx) => ({
      draft: await listDraftDocs(tx, bot.id),
      versions: await listVersions(tx, bot.id, { limit: 10 }),
    }));
    const r = await db.withWorkspace(t.ws, (tx) => rollbackTo(tx, bot.id, v1.version.id));
    expect(r.to.id).toBe(v1.version.id);
    const after = await db.withWorkspace(t.ws, async (tx) => ({
      bot: await getBot(tx, bot.id),
      draft: await listDraftDocs(tx, bot.id),
      versions: await listVersions(tx, bot.id, { limit: 10 }),
    }));
    expect(after.bot.publishedVersionId).toBe(v1.version.id);
    expect(after.draft.map((d) => [d.docId, d.rev])).toEqual(before.draft.map((d) => [d.docId, d.rev]));
    expect(after.versions).toEqual(before.versions);
  });

  test("restore makes the draft equal to the version, removing workflows the version lacks", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    const v1 = await db.withWorkspace(t.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v1", userId: t.userId }));
    const sub = seedSubWorkflow("Track order");
    await db.withWorkspace(t.ws, async (tx) => {
      await createWorkflowDoc(tx, { botId: bot.id, doc: sub, userId: t.userId });
      const m = await getDraftDoc(tx, bot.id, "manifest", "manifest");
      await saveDraftDoc(tx, {
        botId: bot.id,
        kind: "manifest",
        docId: "manifest",
        expectedRev: m.rev,
        doc: { ...(m.doc as object), name: "Renamed" },
        userId: t.userId,
      });
    });
    const r = await db.withWorkspace(t.ws, (tx) =>
      restoreVersion(tx, { botId: bot.id, versionId: v1.version.id, userId: t.userId }),
    );
    expect(r.removedWorkflows).toEqual([sub.id]);
    const after = await db.withWorkspace(t.ws, async (tx) => ({
      draft: await assembleDraft(tx, bot.id),
      bot: await getBot(tx, bot.id),
      manifest: await getDraftDoc(tx, bot.id, "manifest", "manifest"),
    }));
    const restored = await db.withWorkspace(t.ws, (tx) => loadVersionDefinition(tx, v1.version.id));
    expect(after.draft).toEqual(restored);
    expect(after.bot.name).toBe("مساعد المتجر");
    // A new revision, so an open Studio sees a conflict rather than overwriting the restore.
    expect(after.manifest.rev).toBe(2);
  });

  test("a version of another bot is not_found for rollback and restore", async () => {
    const t = await tenant();
    const a = await publishableBot(t, "A");
    const b = await publishableBot(t, "B");
    const va = await db.withWorkspace(t.ws, (tx) =>
      publishDraft(tx, { botId: a.bot.id, label: "a1", userId: t.userId }),
    );
    expect((await failure(db.withWorkspace(t.ws, (tx) => rollbackTo(tx, b.bot.id, va.version.id)))).code).toBe(
      "not_found",
    );
    expect(
      (
        await failure(
          db.withWorkspace(t.ws, (tx) =>
            restoreVersion(tx, { botId: b.bot.id, versionId: va.version.id, userId: null }),
          ),
        )
      ).code,
    ).toBe("not_found");
  });
});

describe("storage rules", () => {
  test("app_rw cannot change or delete a version", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    const v = await db.withWorkspace(t.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v1", userId: t.userId }));
    await expect(bare.query("update bot_versions set label = 'x' where id = $1", [v.version.id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(bare.query("delete from bot_versions where id = $1", [v.version.id])).rejects.toThrow(
      /permission denied/,
    );
  });

  test("deleting a bot removes its versions", async () => {
    const t = await tenant();
    const { bot } = await publishableBot(t);
    await db.withWorkspace(t.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v1", userId: t.userId }));
    await db.withWorkspace(t.ws, (tx) => deleteBot(tx, bot.id));
    const left = await db.withWorkspace(t.ws, (tx) =>
      tx.execute(sql`select count(*)::int as n from bot_versions where bot_id = ${bot.id}`),
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  test("two tenants: another workspace sees no versions and cannot load one", async () => {
    const a = await tenant();
    const b = await tenant();
    const { bot } = await publishableBot(a);
    const v = await db.withWorkspace(a.ws, (tx) => publishDraft(tx, { botId: bot.id, label: "v1", userId: a.userId }));
    expect((await failure(db.withWorkspace(b.ws, (tx) => listVersions(tx, bot.id, { limit: 10 })))).code).toBe(
      "not_found",
    );
    expect((await failure(db.withWorkspace(b.ws, (tx) => loadVersionDefinition(tx, v.version.id)))).code).toBe(
      "not_found",
    );
    // A bot in B cannot be pointed at A's version.
    const other = await publishableBot(b);
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    try {
      await expect(
        su.query("update bots set published_version_id = $1 where id = $2", [v.version.id, other.bot.id]),
      ).rejects.toThrow(/foreign key/);
    } finally {
      await su.end();
    }
  });
});
