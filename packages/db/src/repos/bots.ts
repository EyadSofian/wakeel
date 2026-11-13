import { AppError, BotManifest, BotRecordSettings, newId, seedBot, Workflow } from "@wakeel/contracts";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { botDraftDocs, bots } from "../schema/bots";
import { rethrowUnique } from "./errors";
import { currentWorkspace } from "./scope";

/**
 * Bots and their draft documents (task 2.1, ADR-006). A draft is one manifest document and one
 * document per workflow; each save replaces a whole document when the caller's revision matches.
 * Documents are parsed with their zod schema on write and on read.
 */

export interface Bot {
  id: string;
  name: string;
  slug: string;
  defaultLocale: string;
  publishedVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DraftKind = "manifest" | "workflow";

export interface DraftDoc<T = BotManifest | Workflow> {
  kind: DraftKind;
  docId: string;
  rev: number;
  doc: T;
  updatedAt: Date;
}

const toBot = (row: typeof bots.$inferSelect): Bot => {
  BotRecordSettings.parse(row.settings);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    defaultLocale: row.defaultLocale,
    publishedVersionId: row.publishedVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/** Parses a stored or incoming document with the schema for its kind. */
export function parseDraftDoc(kind: DraftKind, docId: string, doc: unknown): BotManifest | Workflow {
  if (kind === "manifest") return BotManifest.parse(doc);
  const wf = Workflow.parse(doc);
  if (wf.id !== docId) {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "doc.id", code: "id_mismatch", message: "The workflow id must match the address" }] },
    );
  }
  return wf;
}

const toDoc = (row: typeof botDraftDocs.$inferSelect): DraftDoc => ({
  kind: row.kind as DraftKind,
  docId: row.docId,
  rev: row.rev,
  doc: parseDraftDoc(row.kind as DraftKind, row.docId, row.doc),
  updatedAt: row.updatedAt,
});

const slugConstraint = { bots_workspace_id_slug_key: "slug" };

/** Creates a bot with its seeded draft: the manifest and a Main workflow (Start → Autonomous). */
export async function createBot(
  tx: Tx,
  input: { name: string; slug: string; defaultLocale?: string; createdBy: string | null },
): Promise<Bot> {
  const seeded = seedBot({ name: input.name, ...(input.defaultLocale ? { defaultLocale: input.defaultLocale } : {}) });
  const [row] = await tx
    .insert(bots)
    .values({
      id: newId("bot"),
      workspaceId: currentWorkspace,
      name: input.name,
      slug: input.slug,
      defaultLocale: seeded.manifest.defaultLocale,
      settings: BotRecordSettings.parse({}),
    })
    .returning()
    .catch(rethrowUnique(slugConstraint));
  if (!row) throw new Error("insert returned no row");
  await tx.insert(botDraftDocs).values([
    {
      workspaceId: currentWorkspace,
      botId: row.id,
      kind: "manifest",
      docId: "manifest",
      rev: 0,
      doc: BotManifest.parse(seeded.manifest),
      updatedBy: input.createdBy,
    },
    {
      workspaceId: currentWorkspace,
      botId: row.id,
      kind: "workflow",
      docId: seeded.main.id,
      rev: 0,
      doc: Workflow.parse(seeded.main),
      updatedBy: input.createdBy,
    },
  ]);
  return toBot(row);
}

export async function listBots(tx: Tx): Promise<Bot[]> {
  const rows = await tx.select().from(bots).where(isNull(bots.archivedAt)).orderBy(desc(bots.createdAt), desc(bots.id));
  return rows.map(toBot);
}

export async function getBot(tx: Tx, botId: string): Promise<Bot> {
  const [row] = await tx
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
  if (!row) throw new AppError("not_found");
  return toBot(row);
}

/** Renames a bot; the manifest's name follows so the two never disagree. */
export async function updateBot(
  tx: Tx,
  botId: string,
  input: { name?: string; slug?: string; userId: string | null },
): Promise<Bot> {
  const [row] = await tx
    .update(bots)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      updatedAt: new Date(),
    })
    .where(and(eq(bots.id, botId), isNull(bots.archivedAt)))
    .returning()
    .catch(rethrowUnique(slugConstraint));
  if (!row) throw new AppError("not_found");
  if (input.name !== undefined) {
    const manifest = await getDraftDoc(tx, botId, "manifest", "manifest");
    await saveDraftDoc(tx, {
      botId,
      kind: "manifest",
      docId: "manifest",
      expectedRev: manifest.rev,
      doc: { ...(manifest.doc as BotManifest), name: input.name },
      userId: input.userId,
    });
  }
  return toBot(row);
}

/** Deletes a bot and its draft. Versions and conversations join this rule in later phases. */
export async function deleteBot(tx: Tx, botId: string): Promise<void> {
  const deleted = await tx.delete(bots).where(eq(bots.id, botId)).returning({ id: bots.id });
  if (deleted.length === 0) throw new AppError("not_found");
}

export async function listDraftDocs(tx: Tx, botId: string): Promise<DraftDoc[]> {
  await getBot(tx, botId);
  const rows = await tx
    .select()
    .from(botDraftDocs)
    .where(eq(botDraftDocs.botId, botId))
    .orderBy(asc(botDraftDocs.kind), asc(botDraftDocs.createdAt), asc(botDraftDocs.docId));
  return rows.map(toDoc);
}

export async function getDraftDoc(tx: Tx, botId: string, kind: DraftKind, docId: string): Promise<DraftDoc> {
  const [row] = await tx
    .select()
    .from(botDraftDocs)
    .where(and(eq(botDraftDocs.botId, botId), eq(botDraftDocs.kind, kind), eq(botDraftDocs.docId, docId)));
  if (!row) throw new AppError("not_found");
  return toDoc(row);
}

/**
 * Replaces a document if its revision is still `expectedRev`, and returns the new revision. A stale
 * revision is `revision_conflict` carrying the server's copy. A manifest save keeps `bots.name` in
 * step with the manifest's name.
 */
export async function saveDraftDoc(
  tx: Tx,
  input: { botId: string; kind: DraftKind; docId: string; expectedRev: number; doc: unknown; userId: string | null },
): Promise<DraftDoc> {
  const doc = parseDraftDoc(input.kind, input.docId, input.doc);
  const now = new Date();
  const [row] = await tx
    .update(botDraftDocs)
    .set({ doc, rev: sql`${botDraftDocs.rev} + 1`, updatedBy: input.userId, updatedAt: now })
    .where(
      and(
        eq(botDraftDocs.botId, input.botId),
        eq(botDraftDocs.kind, input.kind),
        eq(botDraftDocs.docId, input.docId),
        eq(botDraftDocs.rev, input.expectedRev),
      ),
    )
    .returning();
  if (!row) {
    const current = await getDraftDoc(tx, input.botId, input.kind, input.docId);
    throw new AppError(
      "revision_conflict",
      {},
      {
        detail: `Your copy is based on revision ${input.expectedRev}; the saved revision is ${current.rev}.`,
        current: { rev: current.rev, doc: current.doc },
      },
    );
  }
  if (input.kind === "manifest") {
    await tx
      .update(bots)
      .set({ name: (doc as BotManifest).name, updatedAt: now })
      .where(eq(bots.id, input.botId));
  } else {
    await tx.update(bots).set({ updatedAt: now }).where(eq(bots.id, input.botId));
  }
  return toDoc(row);
}

/** Adds a workflow document at revision 0. An id already in the bot is `unique_violation`. */
export async function createWorkflowDoc(
  tx: Tx,
  input: { botId: string; doc: unknown; userId: string | null },
): Promise<DraftDoc> {
  await getBot(tx, input.botId);
  const wf = Workflow.parse(input.doc);
  if (wf.kind === "main") {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "doc.kind", code: "main_exists", message: "A bot has one main workflow" }] },
    );
  }
  const [row] = await tx
    .insert(botDraftDocs)
    .values({
      workspaceId: currentWorkspace,
      botId: input.botId,
      kind: "workflow",
      docId: wf.id,
      rev: 0,
      doc: wf,
      updatedBy: input.userId,
    })
    .returning()
    .catch(rethrowUnique({ bot_draft_docs_pkey: "id" }));
  if (!row) throw new Error("insert returned no row");
  return toDoc(row);
}

/** Removes a workflow document. The main workflow cannot be removed. */
export async function deleteWorkflowDoc(tx: Tx, botId: string, docId: string): Promise<void> {
  const manifest = await getDraftDoc(tx, botId, "manifest", "manifest");
  if ((manifest.doc as BotManifest).mainWorkflowId === docId) {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "docId", code: "main_workflow", message: "The main workflow cannot be deleted" }] },
    );
  }
  const deleted = await tx
    .delete(botDraftDocs)
    .where(and(eq(botDraftDocs.botId, botId), eq(botDraftDocs.kind, "workflow"), eq(botDraftDocs.docId, docId)))
    .returning({ docId: botDraftDocs.docId });
  if (deleted.length === 0) throw new AppError("not_found");
}
