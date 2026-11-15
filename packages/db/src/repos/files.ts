import { AppError, newId } from "@wakeel/contracts";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { files } from "../schema/kb";
import { currentWorkspace } from "./scope";

/**
 * Uploaded files (task 8.1, ADR-039). The row is the platform's record of an object; the object key
 * is derived from the workspace and file id here, never from the client, and the migration checks it.
 */

export type FileRecord = typeof files.$inferSelect;

/** The object key for a file: `ws/<workspaceId>/files/<fileId>` (ADR-039 §4). */
export const fileKey = (workspaceId: string, fileId: string) => `ws/${workspaceId}/files/${fileId}`;

export async function createFile(
  tx: Tx,
  input: {
    workspaceId: string;
    botId: string | null;
    purpose: "kb_source";
    name: string;
    mime: string;
    size: number;
    createdBy: string | null;
  },
): Promise<FileRecord> {
  const id = newId("file");
  const [row] = await tx
    .insert(files)
    .values({
      id,
      // The scoped workspace, not the caller's word for it; RLS refuses any other.
      workspaceId: currentWorkspace,
      botId: input.botId,
      purpose: input.purpose,
      name: input.name,
      key: fileKey(input.workspaceId, id),
      mime: input.mime,
      size: input.size,
      createdBy: input.createdBy,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function getFile(tx: Tx, fileId: string): Promise<FileRecord> {
  const [row] = await tx.select().from(files).where(eq(files.id, fileId));
  if (!row) throw new AppError("not_found");
  return row;
}

export async function markFileReady(tx: Tx, fileId: string): Promise<FileRecord> {
  const [row] = await tx
    .update(files)
    .set({ status: "ready", updatedAt: sql`now()` })
    .where(eq(files.id, fileId))
    .returning();
  if (!row) throw new AppError("not_found");
  return row;
}

/** Recorded by the ingestion worker when it first reads the file (ADR-039 §2). */
export async function setFileSha256(tx: Tx, fileId: string, sha256: string): Promise<void> {
  await tx.update(files).set({ sha256, updatedAt: sql`now()` }).where(eq(files.id, fileId));
}
