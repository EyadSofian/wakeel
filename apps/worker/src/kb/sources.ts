import { AppError, KbSourceConfig } from "@wakeel/contracts";
import { type Database, deleteDocument, getFile, listDocuments, updateSource, upsertDocument } from "@wakeel/db";
import { type CrawlClock, crawl, type DiscoveryResult, fromSitemap, type HttpGet, Politeness } from "@wakeel/retrieval";
import type { Logger } from "@wakeel/telemetry";
import type { IngestJob } from "./ingest";

/**
 * Syncing a source (task 8.5, ADR-042): turns a source into documents and starts their ingestion.
 * For sitemap and crawl sources, pages no longer discovered are deleted with their chunks; pages
 * that did not change cost one fetch and stop at the fetch stage (content hash).
 */
export interface SyncDeps {
  db: Database;
  /** HTTP through egress, bound to the workspace. */
  get(workspaceId: string): HttpGet;
  clock: CrawlClock;
  /** At least this long between two requests to one host (architecture §8.1: 1 request/second). */
  minIntervalMs: number;
  enqueueIngest(job: IngestJob): Promise<void>;
  logger: Logger;
}

export interface SyncResult {
  documents: number;
  removed: number;
  skipped: DiscoveryResult["skipped"];
}

export async function syncSource(deps: SyncDeps, workspaceId: string, sourceId: string): Promise<SyncResult> {
  const source = await deps.db.withWorkspace(workspaceId, (tx) => updateSource(tx, sourceId, { status: "syncing" }));
  try {
    const config = KbSourceConfig.parse({ kind: source.kind, ...(source.config as object) });
    const result = await discoverAndStore(config);
    await deps.db.withWorkspace(workspaceId, (tx) =>
      updateSource(tx, sourceId, { status: "ready", lastSyncedAt: new Date(deps.clock.now()), error: null }),
    );
    return result;
  } catch (error) {
    const e = error instanceof AppError ? error : undefined;
    await deps.db.withWorkspace(workspaceId, (tx) =>
      updateSource(tx, sourceId, {
        status: "failed",
        error: { code: e?.code ?? "internal_error", title: e?.message ?? "The source could not be synced" },
      }),
    );
    throw error;
  }

  async function discoverAndStore(config: KbSourceConfig): Promise<SyncResult> {
    const kbId = source.kbId;
    const store = async (uris: string[]) => {
      const docs = await deps.db.withWorkspace(workspaceId, async (tx) => {
        const out = [];
        for (const uri of uris) out.push(await upsertDocument(tx, { kbId, sourceId, uri }));
        return out;
      });
      for (const d of docs) await deps.enqueueIngest({ workspaceId, documentId: d.id, stage: "fetch" });
      return docs.length;
    };

    switch (config.kind) {
      case "file": {
        const file = await deps.db.withWorkspace(workspaceId, (tx) => getFile(tx, config.fileId));
        return { documents: await store([file.name]), removed: 0, skipped: [] };
      }
      case "text":
        return { documents: await store([config.title]), removed: 0, skipped: [] };
      case "url": {
        const p = new Politeness(deps.get(workspaceId), deps.clock, deps.minIntervalMs);
        if (!(await p.robotsFor(config.url)).isAllowed(config.url)) {
          throw new AppError("source_fetch_failed", {
            url: config.url,
            message: "the site's robots.txt does not allow it",
          });
        }
        return { documents: await store([config.url]), removed: 0, skipped: [] };
      }
      case "sitemap":
      case "crawl": {
        const p = new Politeness(deps.get(workspaceId), deps.clock, deps.minIntervalMs);
        const found =
          config.kind === "sitemap"
            ? await fromSitemap(p, {
                sitemapUrl: config.url,
                maxPages: config.maxPages,
                maxSitemaps: 50,
                sameOriginOnly: true,
              })
            : await crawl(p, {
                start: config.url,
                maxDepth: config.maxDepth,
                maxPages: config.maxPages,
                sameOriginOnly: config.sameOriginOnly,
              });
        // Nothing found because the site is down or blocks us is a failure, not "every page was
        // removed": deleting the whole knowledge base on an outage would be the worst outcome.
        if (found.pages.length === 0) {
          const reason = found.skipped[0]?.reason ?? "empty";
          throw new AppError("source_fetch_failed", { url: config.url, message: `no pages found (${reason})` });
        }
        const urls = found.pages.map((x) => x.url);
        const documents = await store(urls);
        const keep = new Set(urls);
        const removed = await deps.db.withWorkspace(workspaceId, async (tx) => {
          let n = 0;
          for (const d of await listDocuments(tx, { sourceId })) {
            if (keep.has(d.uri)) continue;
            await deleteDocument(tx, d.id);
            n++;
          }
          return n;
        });
        if (removed > 0) deps.logger.info({ sourceId, removed }, "removed pages no longer on the site");
        return { documents, removed, skipped: found.skipped };
      }
    }
  }
}

/** The scheduled re-sync (architecture §11 `kb-sync`): run by the maintenance job's lookup. */
export async function enqueueDueSyncs(
  deps: { db: Database; enqueueSync(job: { workspaceId: string; sourceId: string }): Promise<void> },
  now: Date,
  limit = 200,
): Promise<number> {
  const due = await deps.db.lookup.kbSourcesDue(now, limit);
  for (const row of due) await deps.enqueueSync({ workspaceId: row.workspaceId, sourceId: row.sourceId });
  return due.length;
}
