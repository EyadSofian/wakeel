import { createHash } from "node:crypto";
import { KB_LIMITS } from "@wakeel/config";
import { AppError } from "@wakeel/contracts";
import {
  countChunks,
  type Database,
  failStage,
  finishStage,
  getDocument,
  getFile,
  getKnowledgeBase,
  getSource,
  getStages,
  type IngestionStage,
  type KbDocument,
  type KbSettings,
  type ObjectStore,
  replaceChunks,
  setFileSha256,
  startStage,
  updateDocument,
} from "@wakeel/db";
import {
  type Chunk,
  chunkMarkdown,
  type EmbedBatch,
  embedAll,
  embeddingInput,
  type OcrPort,
  type ParsedDocument,
  type ParserPort,
  parseHtml,
  parseText,
  parseWithParser,
  toIndexRows,
} from "@wakeel/retrieval";
import type { Logger } from "@wakeel/telemetry";

/**
 * The ingestion pipeline (task 8.4, architecture §8.1, ADR-041): fetch → parse → normalise → chunk →
 * embed → index, one `kb-ingest` job per stage per document. Each stage records itself in
 * kb_ingestion_jobs and writes its output to the object store under the document's content hash, so:
 *
 * - a stage that already finished for this hash is skipped (re-ingesting unchanged content is free);
 * - a failed stage is retried by BullMQ on its own, reading the previous stage's stored output.
 */

export interface IngestJob {
  workspaceId: string;
  documentId: string;
  stage: IngestionStage;
}

/** What a source gives the pipeline: bytes and a type. Remote kinds are wired by task 8.5. */
export interface FetchedContent {
  body: Uint8Array;
  mime: string;
  name: string;
}

export interface IngestDeps {
  db: Database;
  objectStore: ObjectStore;
  parser: ParserPort;
  /** The vision OCR tier for this workspace, or undefined when no vision model is set (ADR-040). */
  ocr(ctx: { workspaceId: string; botId: string; settings: KbSettings }): Promise<OcrPort | undefined>;
  /** Embeds with the KB's model under the workspace's key; usage is recorded by the model layer. */
  embed(ctx: { workspaceId: string; botId: string; model: string }): EmbedBatch;
  /** Remote sources (url, sitemap, crawl); fetched through egress. */
  fetchRemote?(ctx: { workspaceId: string; url: string }): Promise<FetchedContent>;
  enqueue(job: IngestJob): Promise<void>;
  logger: Logger;
}

const NEXT: Record<IngestionStage, IngestionStage | undefined> = {
  fetch: "parse",
  parse: "normalise",
  normalise: "chunk",
  chunk: "embed",
  embed: "index",
  index: undefined,
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Where a stage's output lives: per workspace, per document, per content version. */
const artifactKey = (ws: string, doc: KbDocument, hash: string, name: string) =>
  `ws/${ws}/kb/${doc.kbId}/${doc.id}/${hash}.${name}`;

async function putJson(store: ObjectStore, key: string, value: unknown) {
  await store.put(key, enc.encode(JSON.stringify(value)), "application/json");
}
async function getJson<T>(store: ObjectStore, key: string): Promise<T> {
  return JSON.parse(dec.decode(await store.get(key))) as T;
}

/** Starts (or restarts) ingestion of one document at the fetch stage. */
export function ingestDocument(deps: Pick<IngestDeps, "enqueue">, workspaceId: string, documentId: string) {
  return deps.enqueue({ workspaceId, documentId, stage: "fetch" });
}

/** Runs one stage of one document. Throws on failure so BullMQ retries that stage (5, exponential). */
export async function runStage(deps: IngestDeps, job: IngestJob): Promise<"done" | "skipped" | "unchanged"> {
  const { workspaceId: ws, documentId, stage } = job;
  const ctx = await deps.db.withWorkspace(ws, async (tx) => {
    const doc = await getDocument(tx, documentId);
    const kb = await getKnowledgeBase(tx, doc.kbId);
    const source = await getSource(tx, doc.sourceId);
    const stages = await getStages(tx, documentId);
    return { doc, kb, source, stages };
  });
  const { doc, kb, source } = ctx;
  const hash = doc.contentHash;

  // Idempotent by content_hash: a stage that finished for this content is not run again.
  if (stage !== "fetch" && hash) {
    const record = ctx.stages.find((s) => s.stage === stage);
    if (record?.status === "done" && record.contentHash === hash) {
      await enqueueNext(deps, job);
      return "skipped";
    }
  }
  if (stage !== "fetch" && !hash) throw new Error(`stage ${stage} before fetch for ${documentId}`);

  await deps.db.withWorkspace(ws, (tx) =>
    startStage(tx, { kbId: doc.kbId, sourceId: doc.sourceId, documentId, stage }),
  );
  try {
    const outcome = await work();
    if (outcome === "unchanged") return outcome;
    await enqueueNext(deps, job);
    return "done";
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    const record = { code: appError?.code ?? "internal_error", title: appError?.message ?? "Ingestion failed" };
    await deps.db.withWorkspace(ws, async (tx) => {
      await failStage(tx, documentId, stage, record);
      await updateDocument(tx, documentId, { status: "failed", meta: { ...(doc.meta as object), error: record } });
    });
    throw error;
  }

  async function work(): Promise<"done" | "unchanged"> {
    switch (stage) {
      case "fetch": {
        const content = await fetchContent();
        const newHash = sha256(content.body);
        const unchanged =
          doc.contentHash === newHash &&
          doc.status === "ready" &&
          (await deps.db.withWorkspace(ws, (tx) => countChunks(tx, documentId, kb.indexVersion))) > 0;
        if (unchanged) {
          await deps.db.withWorkspace(ws, (tx) => finishStage(tx, documentId, "fetch", newHash));
          return "unchanged";
        }
        // File uploads are already stored; other sources keep their raw bytes for the parse stage.
        if (source.kind !== "file") {
          await deps.objectStore.put(artifactKey(ws, doc, newHash, "raw"), content.body, content.mime);
        }
        await deps.db.withWorkspace(ws, async (tx) => {
          await updateDocument(tx, documentId, { contentHash: newHash, mime: content.mime, status: "parsing" });
          if (source.kind === "file")
            await setFileSha256(tx, String((source.config as Record<string, unknown>)["fileId"]), newHash);
          await finishStage(tx, documentId, "fetch", newHash);
        });
        return "done";
      }
      case "parse": {
        const h = hash as string;
        const content = await fetchStored(h);
        const parsed = await parse(content);
        await putJson(deps.objectStore, artifactKey(ws, doc, h, "parsed.json"), parsed);
        await deps.db.withWorkspace(ws, async (tx) => {
          await updateDocument(tx, documentId, {
            title: doc.title || parsed.title || content.name,
            meta: {
              ...(doc.meta as object),
              quality: parsed.quality,
              pages: parsed.pages.length,
              via: parsed.via,
              error: null,
            },
          });
          await finishStage(tx, documentId, "parse", h);
        });
        return "done";
      }
      case "normalise": {
        const h = hash as string;
        const parsed = await getJson<ParsedDocument>(deps.objectStore, artifactKey(ws, doc, h, "parsed.json"));
        const key = artifactKey(ws, doc, h, "md");
        await deps.objectStore.put(key, enc.encode(cleanMarkdown(parsed.markdown)), "text/markdown");
        await deps.db.withWorkspace(ws, async (tx) => {
          await updateDocument(tx, documentId, { parsedKey: key, status: "indexing" });
          await finishStage(tx, documentId, "normalise", h);
        });
        return "done";
      }
      case "chunk": {
        const h = hash as string;
        const markdown = dec.decode(await deps.objectStore.get(artifactKey(ws, doc, h, "md")));
        const chunks = chunkMarkdown(markdown);
        await putJson(deps.objectStore, artifactKey(ws, doc, h, "chunks.json"), chunks);
        await deps.db.withWorkspace(ws, (tx) => finishStage(tx, documentId, "chunk", h));
        return "done";
      }
      case "embed": {
        const h = hash as string;
        const chunks = await getJson<Chunk[]>(deps.objectStore, artifactKey(ws, doc, h, "chunks.json"));
        const embed = deps.embed({ workspaceId: ws, botId: kb.botId, model: kb.embeddingModel });
        const vectors = await embedAll(embed, chunks.map(embeddingInput));
        await putJson(deps.objectStore, artifactKey(ws, doc, h, `v${kb.indexVersion}.vectors.json`), vectors);
        await deps.db.withWorkspace(ws, (tx) => finishStage(tx, documentId, "embed", h));
        return "done";
      }
      case "index": {
        const h = hash as string;
        const chunks = await getJson<Chunk[]>(deps.objectStore, artifactKey(ws, doc, h, "chunks.json"));
        const vectors = await getJson<number[][]>(
          deps.objectStore,
          artifactKey(ws, doc, h, `v${kb.indexVersion}.vectors.json`),
        );
        const rows = toIndexRows(chunks, vectors);
        // One transaction: the chunks, the stage record and the ready status change together.
        await deps.db.withWorkspace(ws, async (tx) => {
          await replaceChunks(tx, { kbId: doc.kbId, documentId, indexVersion: kb.indexVersion, rows });
          await updateDocument(tx, documentId, {
            status: "ready",
            tokenCount: chunks.reduce((n, c) => n + c.tokenCount, 0),
          });
          await finishStage(tx, documentId, "index", h);
        });
        return "done";
      }
    }
  }

  async function fetchContent(): Promise<FetchedContent> {
    const config = source.config as Record<string, unknown>;
    switch (source.kind) {
      case "file": {
        const file = await deps.db.withWorkspace(ws, (tx) => getFile(tx, String(config["fileId"])));
        if (file.status !== "ready") throw new AppError("upload_incomplete");
        return { body: await deps.objectStore.get(file.key), mime: file.mime, name: file.name };
      }
      case "text":
        return { body: enc.encode(String(config["text"] ?? "")), mime: "text/markdown", name: doc.uri };
      default: {
        if (!deps.fetchRemote) throw new Error(`no fetcher for ${source.kind} sources`);
        return deps.fetchRemote({ workspaceId: ws, url: doc.uri });
      }
    }
  }

  async function fetchStored(h: string): Promise<FetchedContent> {
    if (source.kind === "file") {
      const file = await deps.db.withWorkspace(ws, (tx) =>
        getFile(tx, String((source.config as Record<string, unknown>)["fileId"])),
      );
      return { body: await deps.objectStore.get(file.key), mime: file.mime, name: file.name };
    }
    const body = await deps.objectStore.get(artifactKey(ws, doc, h, "raw"));
    return { body, mime: doc.mime ?? "text/plain", name: doc.uri };
  }

  async function parse(content: FetchedContent): Promise<ParsedDocument> {
    const mime = content.mime;
    if (mime === "text/html") return parseHtml(dec.decode(content.body), { url: doc.uri });
    if (mime === "text/plain" || mime === "text/markdown" || mime === "text/csv")
      return parseText(dec.decode(content.body), mime, content.name);
    const ocr = await deps.ocr({ workspaceId: ws, botId: kb.botId, settings: kb.settings as KbSettings });
    const maxOcrPages = (kb.settings as KbSettings).maxOcrPages ?? KB_LIMITS.maxOcrPagesPerDocument;
    return parseWithParser(
      { body: content.body, mime, name: content.name },
      { parser: deps.parser, maxOcrPages, ...(ocr ? { ocr } : {}) },
    );
  }
}

async function enqueueNext(deps: IngestDeps, job: IngestJob) {
  const next = NEXT[job.stage];
  if (next) await deps.enqueue({ ...job, stage: next });
}

/**
 * The normalise stage (ADR-041 §2): display-safe cleanup of the whole document. Search normalisation
 * (alef forms, ta marbuta, stemming) happens per chunk at index time with the same function as
 * queries; this stage only removes what no reader wants: control and invisible formatting characters
 * other than ZWJ and ZWNJ (which change Arabic and Persian letter joining), and runs of blank lines.
 */
export function cleanMarkdown(markdown: string): string {
  let kept = "";
  for (const ch of markdown.normalize("NFC")) if (!isInvisible(ch.codePointAt(0) ?? 0)) kept += ch;
  return kept
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Control characters (but tab, newline, carriage return), soft hyphen, zero-width space, bidi marks and
 * embeddings, invisible operators and the byte order mark. ZWNJ (0x200c) and ZWJ (0x200d) stay. */
function isInvisible(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return (
    cp < 0x20 ||
    cp === 0x7f ||
    cp === 0xad ||
    cp === 0x200b ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff
  );
}
