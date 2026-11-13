import { randomBytes } from "node:crypto";
import { AppError, type BotManifest, newId, seedSubWorkflow, type Workflow } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createBot,
  createDatabase,
  createWorkflowDoc,
  createWorkspace,
  type Database,
  deleteBot,
  deleteWorkflowDoc,
  getBot,
  getDraftDoc,
  listBots,
  listDraftDocs,
  saveDraftDoc,
  sql,
  updateBot,
} from "../src/index";

/** Task 2.1: bots and draft documents; two tenants; revisions. */
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
    name: "Bots",
    slug: `b-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  return { ws: workspace.id, userId };
};

const code = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

describe("a new bot", () => {
  test("is seeded with a manifest and a Main workflow: Start wired to one Autonomous node", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) =>
      createBot(tx, { name: "مساعد المبيعات", slug: "sales", createdBy: t.userId }),
    );
    const docs = await db.withWorkspace(t.ws, (tx) => listDraftDocs(tx, bot.id));
    expect(docs.map((d) => [d.kind, d.rev])).toEqual([
      ["manifest", 0],
      ["workflow", 0],
    ]);
    const manifest = docs[0]?.doc as BotManifest;
    const main = docs[1]?.doc as Workflow;
    expect(manifest.name).toBe("مساعد المبيعات");
    expect(manifest.mainWorkflowId).toBe(main.id);
    expect(main.kind).toBe("main");
    expect(main.nodes.map((n) => n.type)).toEqual(["start", "autonomous"]);
    expect(main.edges).toHaveLength(1);
    expect(main.edges[0]?.from).toEqual({ nodeId: main.nodes[0]?.id, port: "next" });
    expect(main.edges[0]?.to).toEqual({ nodeId: main.nodes[1]?.id });
    expect(Object.keys(main.layout).sort()).toEqual(main.nodes.map((n) => n.id).sort());
  });

  test("a slug taken in the workspace is unique_violation; another workspace may reuse it", async () => {
    const a = await tenant();
    const b = await tenant();
    await db.withWorkspace(a.ws, (tx) => createBot(tx, { name: "One", slug: "support", createdBy: a.userId }));
    expect(
      (await code(db.withWorkspace(a.ws, (tx) => createBot(tx, { name: "Two", slug: "support", createdBy: a.userId }))))
        .code,
    ).toBe("unique_violation");
    await expect(
      db.withWorkspace(b.ws, (tx) => createBot(tx, { name: "Three", slug: "support", createdBy: b.userId })),
    ).resolves.toBeDefined();
  });
});

describe("draft documents", () => {
  test("a save with the current revision bumps it; a stale one is revision_conflict with the server copy", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) => createBot(tx, { name: "Rev", slug: "rev", createdBy: t.userId }));
    const docs = await db.withWorkspace(t.ws, (tx) => listDraftDocs(tx, bot.id));
    const main = docs[1] as { docId: string; doc: Workflow };
    const renamed = { ...main.doc, name: "Main flow" };
    const saved = await db.withWorkspace(t.ws, (tx) =>
      saveDraftDoc(tx, {
        botId: bot.id,
        kind: "workflow",
        docId: main.docId,
        expectedRev: 0,
        doc: renamed,
        userId: t.userId,
      }),
    );
    expect(saved.rev).toBe(1);
    const err = await code(
      db.withWorkspace(t.ws, (tx) =>
        saveDraftDoc(tx, {
          botId: bot.id,
          kind: "workflow",
          docId: main.docId,
          expectedRev: 0,
          doc: main.doc,
          userId: t.userId,
        }),
      ),
    );
    expect(err.code).toBe("revision_conflict");
    expect(err.current?.rev).toBe(1);
    expect((err.current?.doc as Workflow | undefined)?.name).toBe("Main flow");
    expect(err.detail).toContain("revision 0");
  });

  test("two saves racing on the same revision: exactly one wins", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) =>
      createBot(tx, { name: "Race", slug: "race", createdBy: t.userId }),
    );
    const m = await db.withWorkspace(t.ws, (tx) => getDraftDoc(tx, bot.id, "manifest", "manifest"));
    const save = (name: string) =>
      db
        .withWorkspace(t.ws, (tx) =>
          saveDraftDoc(tx, {
            botId: bot.id,
            kind: "manifest",
            docId: "manifest",
            expectedRev: 0,
            doc: { ...(m.doc as BotManifest), name },
            userId: t.userId,
          }),
        )
        .then(
          () => "ok",
          (e: AppError) => e.code,
        );
    const results = await Promise.all([save("A"), save("B"), save("C")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "revision_conflict")).toHaveLength(2);
  });

  test("an invalid document is refused and nothing is saved", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) => createBot(tx, { name: "Bad", slug: "bad", createdBy: t.userId }));
    await expect(
      db.withWorkspace(t.ws, (tx) =>
        saveDraftDoc(tx, {
          botId: bot.id,
          kind: "manifest",
          docId: "manifest",
          expectedRev: 0,
          doc: { name: "" },
          userId: t.userId,
        }),
      ),
    ).rejects.toThrow();
    expect((await db.withWorkspace(t.ws, (tx) => getDraftDoc(tx, bot.id, "manifest", "manifest"))).rev).toBe(0);
  });

  test("a manifest rename renames the bot, and a bot rename renames the manifest", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) =>
      createBot(tx, { name: "Old", slug: "names", createdBy: t.userId }),
    );
    await db.withWorkspace(t.ws, (tx) => updateBot(tx, bot.id, { name: "Newer", userId: t.userId }));
    const m = await db.withWorkspace(t.ws, (tx) => getDraftDoc(tx, bot.id, "manifest", "manifest"));
    expect((m.doc as BotManifest).name).toBe("Newer");
    await db.withWorkspace(t.ws, (tx) =>
      saveDraftDoc(tx, {
        botId: bot.id,
        kind: "manifest",
        docId: "manifest",
        expectedRev: m.rev,
        doc: { ...(m.doc as BotManifest), name: "Newest" },
        userId: t.userId,
      }),
    );
    expect((await db.withWorkspace(t.ws, (tx) => getBot(tx, bot.id))).name).toBe("Newest");
  });

  test("sub-workflows can be added and removed; the main workflow cannot be removed", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) =>
      createBot(tx, { name: "Subs", slug: "subs", createdBy: t.userId }),
    );
    const sub = seedSubWorkflow("استرجاع الطلب");
    await db.withWorkspace(t.ws, (tx) => createWorkflowDoc(tx, { botId: bot.id, doc: sub, userId: t.userId }));
    expect((await db.withWorkspace(t.ws, (tx) => listDraftDocs(tx, bot.id))).length).toBe(3);
    await db.withWorkspace(t.ws, (tx) => deleteWorkflowDoc(tx, bot.id, sub.id));
    const main = (await db.withWorkspace(t.ws, (tx) => getDraftDoc(tx, bot.id, "manifest", "manifest")))
      .doc as BotManifest;
    expect((await code(db.withWorkspace(t.ws, (tx) => deleteWorkflowDoc(tx, bot.id, main.mainWorkflowId)))).code).toBe(
      "validation_failed",
    );
  });

  test("deleting a bot deletes its draft", async () => {
    const t = await tenant();
    const bot = await db.withWorkspace(t.ws, (tx) =>
      createBot(tx, { name: "Gone", slug: "gone", createdBy: t.userId }),
    );
    await db.withWorkspace(t.ws, (tx) => deleteBot(tx, bot.id));
    const left = await db.withWorkspace(t.ws, (tx) =>
      tx.execute(sql`select count(*)::int as n from bot_draft_docs where bot_id = ${bot.id}`),
    );
    expect(left.rows[0]?.["n"]).toBe(0);
  });
});

describe("two tenants", () => {
  const pair = async () => {
    const a = await tenant();
    const b = await tenant();
    const bot = await db.withWorkspace(a.ws, (tx) =>
      createBot(tx, { name: "Private", slug: "private", createdBy: a.userId }),
    );
    return { a, b, bot };
  };

  test.each(["A → B", "B → A"])(
    "%s: the other tenant cannot see, read, save or delete the bot or its documents",
    async (dir) => {
      const p = await pair();
      const [owner, other] = dir === "A → B" ? [p.a, p.b] : [p.b, p.a];
      // For B → A, give B its own bot and probe it from A.
      const bot =
        dir === "A → B"
          ? p.bot
          : await db.withWorkspace(owner.ws, (tx) => createBot(tx, { name: "B", slug: "b", createdBy: owner.userId }));
      const m = await db.withWorkspace(owner.ws, (tx) => getDraftDoc(tx, bot.id, "manifest", "manifest"));
      await db.withWorkspace(other.ws, async (tx) => {
        expect((await listBots(tx)).map((x) => x.id)).not.toContain(bot.id);
        expect((await code(getBot(tx, bot.id))).code).toBe("not_found");
        expect((await code(getDraftDoc(tx, bot.id, "manifest", "manifest"))).code).toBe("not_found");
        expect((await code(deleteBot(tx, bot.id))).code).toBe("not_found");
      });
      const steal = await code(
        db.withWorkspace(other.ws, (tx) =>
          saveDraftDoc(tx, {
            botId: bot.id,
            kind: "manifest",
            docId: "manifest",
            expectedRev: m.rev,
            doc: m.doc,
            userId: other.userId,
          }),
        ),
      );
      expect(steal.code).toBe("not_found");
      expect((await bare.query("select count(*)::int as n from bots")).rows[0].n).toBe(0);
      expect((await bare.query("select count(*)::int as n from bot_draft_docs")).rows[0].n).toBe(0);
    },
  );

  test("a document cannot be attached to another tenant's bot, even with its id", async () => {
    const { b, bot } = await pair();
    const sub = seedSubWorkflow("Injected");
    // Through the repository: the bot is not visible.
    expect(
      (await code(db.withWorkspace(b.ws, (tx) => createWorkflowDoc(tx, { botId: bot.id, doc: sub, userId: b.userId }))))
        .code,
    ).toBe("not_found");
    // Directly: the composite foreign key refuses a document whose workspace is not the bot's.
    await expect(
      db.withWorkspace(b.ws, (tx) =>
        tx.execute(
          sql`insert into bot_draft_docs (workspace_id, bot_id, kind, doc_id, rev, doc) values (${b.ws}, ${bot.id}, 'workflow', ${sub.id}, 0, ${JSON.stringify(sub)}::jsonb)`,
        ),
      ),
    ).rejects.toThrow();
  });
});
