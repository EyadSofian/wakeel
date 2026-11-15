import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { newId } from "@wakeel/contracts";
import {
  createBot,
  createDatabase,
  createKnowledgeBase,
  createSource,
  createWorkspace,
  type Database,
  getSource,
  listDocuments,
  memoryObjectStore,
  sql,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import type { CrawlClock, HttpGet } from "@wakeel/retrieval";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { enqueueDueSyncs, type IngestDeps, type IngestJob, runStage, syncSource } from "../src/kb/index";

/**
 * Task 8.5 acceptance against a local test site and real Postgres: the crawl respects robots.txt and
 * its limits; on re-sync changed pages re-index, unchanged pages stop at fetch, removed pages are
 * deleted. In production `get` goes through egress (which refuses loopback addresses by design);
 * here it calls the local site directly.
 */
let database: StartedTestDatabase;
let db: Database;
let server: Server;
let origin = "";
const logger = createLogger({
  service: "worker",
  level: "silent",
  destination: new Writable({ write: (_c, _e, d) => d() }),
});

/** The site's pages; tests change them between syncs. */
const pages = new Map<string, { type: string; body: string }>();
const hits: string[] = [];
const page = (title: string, body: string, links: string[] = []) => ({
  type: "text/html; charset=utf-8",
  body: `<!doctype html><html lang="ar"><head><title>${title}</title></head><body><main><article><h1>${title}</h1><p>${body}</p>${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join(" ")}</article></main></body></html>`,
});

function resetSite() {
  pages.clear();
  pages.set("/robots.txt", { type: "text/plain", body: "User-agent: *\nDisallow: /private\n" });
  pages.set(
    "/",
    page("الرئيسية", "مرحبا بكم في متجرنا. نبيع الشاي والقهوة.", ["/shipping", "/returns", "/private/admin", "/faq"]),
  );
  pages.set("/shipping", page("الشحن", "يصل الطلب داخل القاهرة خلال يومين.", ["/shipping/rates"]));
  pages.set("/shipping/rates", page("أسعار الشحن", "تكلفة الشحن ٥٠ جنيها.", ["/shipping/rates/deep"]));
  pages.set("/shipping/rates/deep", page("عميق", "هذه الصفحة أعمق من الحد."));
  pages.set("/returns", page("الاسترجاع", "يمكن الاسترجاع خلال ١٤ يوما."));
  pages.set("/faq", page("الأسئلة", "أسئلة شائعة عن الطلبات."));
  pages.set("/private/admin", page("لوحة", "سري"));
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = createDatabase({ url: database.urls.rw, maxConnections: 6 });
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.push(path);
    const p = pages.get(path);
    if (!p) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": p.type }).end(p.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await db?.close();
  await database?.stop();
});

const direct: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: new Uint8Array(await res.arrayBuffer()),
    url: res.url,
  };
};

function harness() {
  let now = Date.parse("2026-11-15T10:00:00Z");
  const clock: CrawlClock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  const queue: IngestJob[] = [];
  const outcomes: string[] = [];
  const ingest: IngestDeps = {
    db,
    objectStore: memoryObjectStore(),
    parser: { parse: async () => Promise.reject(new Error("no PDFs on this site")) },
    ocr: async () => undefined,
    embed: () => async (values) => values.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
    fetchRemote: async ({ url }) => {
      const r = await direct(url, {});
      return { body: r.body, mime: (r.headers["content-type"] ?? "").split(";")[0] as string, name: url };
    },
    enqueue: async (job) => void queue.push(job),
    logger,
  };
  const sync = {
    db,
    get: () => direct,
    clock,
    minIntervalMs: 1000,
    enqueueIngest: async (job: IngestJob) => void queue.push(job),
    logger,
  };
  async function drain() {
    while (queue.length) {
      const job = queue.shift() as IngestJob;
      outcomes.push(`${job.stage}:${await runStage(ingest, job)}`);
    }
  }
  return { sync, drain, outcomes, clock: () => now };
}

async function tenant() {
  const userId = newId("usr");
  await superuserQuery(database.urls, "insert into users (id, email, name) values ($1, $2, 'KB')", [
    userId,
    `${userId}@example.test`,
  ]);
  const { workspace } = await createWorkspace(db, { name: "KB", slug: `src-${userId.slice(-8)}`, ownerUserId: userId });
  const bot = await db.withWorkspace(workspace.id, (tx) =>
    createBot(tx, { name: "متجر", slug: "shop", createdBy: userId }),
  );
  const kb = await db.withWorkspace(workspace.id, (tx) =>
    createKnowledgeBase(tx, { botId: bot.id, name: "الموقع", embeddingModel: "openai:text-embedding-3-large" }),
  );
  return { ws: workspace.id, kb };
}

const uris = async (ws: string, sourceId: string) =>
  (await db.withWorkspace(ws, (tx) => listDocuments(tx, { sourceId }))).map((d) => new URL(d.uri).pathname).sort();

const chunkTexts = async (ws: string) =>
  db.withWorkspace(ws, async (tx) =>
    (await tx.execute(sql`select text from kb_chunks order by text`)).rows.map((r) => String(r["text"])),
  );

describe("crawl source against a local site", () => {
  test("first sync respects robots and depth, then re-sync re-indexes changes and deletes removed pages", async () => {
    resetSite();
    const t = await tenant();
    const h = harness();
    const source = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, { kbId: t.kb.id, kind: "crawl", config: { url: `${origin}/`, maxDepth: 2, maxPages: 10 } }),
    );

    const first = await syncSource(h.sync, t.ws, source.id);
    expect(await uris(t.ws, source.id)).toEqual(["/", "/faq", "/returns", "/shipping", "/shipping/rates"]);
    expect(first.skipped).toEqual(expect.arrayContaining([{ url: `${origin}/private/admin`, reason: "robots" }]));
    expect(hits).not.toContain("/private/admin");
    expect(hits).not.toContain("/shipping/rates/deep");
    await h.drain();
    expect((await chunkTexts(t.ws)).join("\n")).toContain("يمكن الاسترجاع خلال ١٤ يوما.");
    const after = await db.withWorkspace(t.ws, (tx) => getSource(tx, source.id));
    expect(after.status).toBe("ready");
    expect(after.lastSyncedAt).not.toBeNull();

    // The site changes: returns policy updated, FAQ removed.
    pages.set("/returns", page("الاسترجاع", "يمكن الاسترجاع خلال ٣٠ يوما."));
    pages.delete("/faq");
    h.outcomes.length = 0;
    const second = await syncSource(h.sync, t.ws, source.id);
    expect(second.removed).toBe(1);
    expect(await uris(t.ws, source.id)).toEqual(["/", "/returns", "/shipping", "/shipping/rates"]);
    await h.drain();
    const texts = (await chunkTexts(t.ws)).join("\n");
    expect(texts).toContain("يمكن الاسترجاع خلال ٣٠ يوما.");
    expect(texts).not.toContain("١٤ يوما");
    expect(texts).not.toContain("أسئلة شائعة");
    // Three pages did not change: each stopped at fetch. One changed and ran every stage.
    expect(h.outcomes.filter((o) => o.endsWith("fetch:unchanged"))).toHaveLength(3);
    expect(h.outcomes.filter((o) => o.endsWith("index:done"))).toHaveLength(1);
  });

  test("the crawler never sends two requests to the site within a second", async () => {
    resetSite();
    const t = await tenant();
    const h = harness();
    const times: number[] = [];
    const timed = {
      ...h.sync,
      get: () =>
        (async (url, headers) => {
          times.push(h.clock());
          return direct(url, headers);
        }) as HttpGet,
    };
    const source = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, { kbId: t.kb.id, kind: "crawl", config: { url: `${origin}/`, maxDepth: 1, maxPages: 3 } }),
    );
    await syncSource(timed, t.ws, source.id);
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(1000);
    expect(await uris(t.ws, source.id)).toHaveLength(3);
  });

  test("a site that is down fails the sync and deletes nothing", async () => {
    resetSite();
    const t = await tenant();
    const h = harness();
    const source = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, { kbId: t.kb.id, kind: "crawl", config: { url: `${origin}/`, maxDepth: 1, maxPages: 5 } }),
    );
    await syncSource(h.sync, t.ws, source.id);
    const before = await uris(t.ws, source.id);
    pages.delete("/");
    await expect(syncSource(h.sync, t.ws, source.id)).rejects.toMatchObject({ code: "source_fetch_failed" });
    expect(await uris(t.ws, source.id)).toEqual(before);
    expect((await db.withWorkspace(t.ws, (tx) => getSource(tx, source.id))).status).toBe("failed");
  });

  test("a sitemap source lists its pages; a URL source refused by robots fails", async () => {
    resetSite();
    pages.set("/sitemap.xml", {
      type: "application/xml",
      body: `<urlset><url><loc>${origin}/returns</loc></url><url><loc>${origin}/private/admin</loc></url></urlset>`,
    });
    const t = await tenant();
    const h = harness();
    const sm = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, { kbId: t.kb.id, kind: "sitemap", config: { url: `${origin}/sitemap.xml` } }),
    );
    await syncSource(h.sync, t.ws, sm.id);
    expect(await uris(t.ws, sm.id)).toEqual(["/returns"]);
    const blocked = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, { kbId: t.kb.id, kind: "url", config: { url: `${origin}/private/admin` } }),
    );
    await expect(syncSource(h.sync, t.ws, blocked.id)).rejects.toMatchObject({ code: "source_fetch_failed" });
  });

  test("text and URL sources become one document each", async () => {
    resetSite();
    const t = await tenant();
    const h = harness();
    const text = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, {
        kbId: t.kb.id,
        kind: "text",
        config: { title: "ساعات العمل", text: "من ٩ صباحا إلى ٥ مساء" },
      }),
    );
    const url = await db.withWorkspace(t.ws, (tx) =>
      createSource(tx, { kbId: t.kb.id, kind: "url", config: { url: `${origin}/shipping` } }),
    );
    expect((await syncSource(h.sync, t.ws, text.id)).documents).toBe(1);
    expect((await syncSource(h.sync, t.ws, url.id)).documents).toBe(1);
    await h.drain();
    const texts = (await chunkTexts(t.ws)).join("\n");
    expect(texts).toContain("من ٩ صباحا إلى ٥ مساء");
    expect(texts).toContain("يصل الطلب داخل القاهرة خلال يومين.");
  });
});

describe("scheduled re-sync", () => {
  test("due sources across workspaces are enqueued; not-due and unscheduled ones are not", async () => {
    resetSite();
    const a = await tenant();
    const b = await tenant();
    const mk = (t: { ws: string; kb: { id: string } }, schedule: string | null) =>
      db.withWorkspace(t.ws, (tx) =>
        createSource(tx, { kbId: t.kb.id, kind: "url", config: { url: `${origin}/` }, schedule }),
      );
    const due = await mk(a, "1 day");
    const dueB = await mk(b, "1 hour");
    const fresh = await mk(a, "7 days");
    const never = await mk(b, null);
    await superuserQuery(
      database.urls,
      "update kb_sources set last_synced_at = now() - interval '2 days', status = 'ready' where id = $1",
      [due.id],
    );
    await superuserQuery(
      database.urls,
      "update kb_sources set last_synced_at = now() - interval '2 days', status = 'ready' where id = $1",
      [fresh.id],
    );
    const queued: string[] = [];
    await enqueueDueSyncs({ db, enqueueSync: async (j) => void queued.push(j.sourceId) }, new Date(), 1000);
    expect(queued).toEqual(expect.arrayContaining([due.id, dueB.id]));
    expect(queued).not.toContain(fresh.id);
    expect(queued).not.toContain(never.id);
  });
});
