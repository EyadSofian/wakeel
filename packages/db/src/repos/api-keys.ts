import { ApiKeyKind, AppError, newId } from "@wakeel/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client";
import { apiKeys } from "../schema/platform";
import { currentWorkspace } from "./scope";

/** An API key row without its secret hash, which never leaves this module except for comparison. */
export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  scopes: string[];
  botId: string | null;
  connectionId: string | null;
  createdBy: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const toRecord = ({ secretHash: _hash, ...row }: typeof apiKeys.$inferSelect): ApiKeyRecord => ({
  ...row,
  kind: ApiKeyKind.parse(row.kind),
});

export interface InsertApiKeyInput {
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  /** SHA-256 hex of the secret part of the key. */
  secretHash: string;
  scopes: string[];
  botId?: string;
  connectionId?: string;
  createdBy?: string;
  expiresAt?: Date;
}

export async function insertApiKey(tx: Tx, input: InsertApiKeyInput): Promise<ApiKeyRecord> {
  const [row] = await tx
    .insert(apiKeys)
    .values({
      id: newId("key"),
      workspaceId: currentWorkspace,
      kind: ApiKeyKind.parse(input.kind),
      name: input.name,
      prefix: input.prefix,
      secretHash: input.secretHash,
      scopes: input.scopes,
      botId: input.botId ?? null,
      connectionId: input.connectionId ?? null,
      createdBy: input.createdBy ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return toRecord(row);
}

/** The key and its stored hash, for verifying a presented secret. */
export async function getApiKeyForVerification(
  tx: Tx,
  keyId: string,
): Promise<{ key: ApiKeyRecord; secretHash: string } | undefined> {
  const [row] = await tx.select().from(apiKeys).where(eq(apiKeys.id, keyId));
  return row ? { key: toRecord(row), secretHash: row.secretHash } : undefined;
}

export async function getApiKey(tx: Tx, keyId: string): Promise<ApiKeyRecord> {
  const found = await getApiKeyForVerification(tx, keyId);
  if (!found) throw new AppError("not_found");
  return found.key;
}

/** Keys of one kind in the scoped workspace, newest first, revoked ones included. */
export async function listApiKeys(tx: Tx, kind: ApiKeyKind): Promise<ApiKeyRecord[]> {
  const rows = await tx
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.kind, kind))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(toRecord);
}

/** Revokes a key. Revoking twice or an unknown key is `not_found`. */
export async function revokeApiKey(tx: Tx, keyId: string, now: Date): Promise<ApiKeyRecord> {
  const [row] = await tx
    .update(apiKeys)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning();
  if (!row) throw new AppError("not_found");
  return toRecord(row);
}

/** Records use of a key. Does not touch `updated_at`, which tracks changes made by people. */
export async function touchApiKey(tx: Tx, keyId: string, now: Date): Promise<void> {
  await tx.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, keyId));
}
