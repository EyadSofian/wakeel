import { AppError, newId, SecretName } from "@wakeel/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { workspaceSecrets } from "../schema/platform";
import { currentWorkspace } from "./scope";

/**
 * Stores and reads encrypted workspace secrets. This module never sees plaintext: callers encrypt
 * with `packages/db/src/crypto.ts` (task 1.5) before `putSecret` and decrypt after `getSecret`.
 */

export interface StoredSecret {
  name: string;
  ciphertext: Buffer;
  keyVersion: number;
  updatedAt: Date;
}

export interface SecretSummary {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Creates or replaces the secret called `name` in the scoped workspace. */
export async function putSecret(
  tx: Tx,
  input: { name: string; ciphertext: Buffer; keyVersion: number },
): Promise<SecretSummary> {
  const now = new Date();
  const [row] = await tx
    .insert(workspaceSecrets)
    .values({
      id: newId("sec"),
      workspaceId: currentWorkspace,
      name: SecretName.parse(input.name),
      ciphertext: input.ciphertext,
      keyVersion: input.keyVersion,
    })
    .onConflictDoUpdate({
      target: [workspaceSecrets.workspaceId, workspaceSecrets.name],
      set: { ciphertext: sql`excluded.ciphertext`, keyVersion: sql`excluded.key_version`, updatedAt: now },
    })
    .returning({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      createdAt: workspaceSecrets.createdAt,
      updatedAt: workspaceSecrets.updatedAt,
    });
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function getSecret(tx: Tx, name: string): Promise<StoredSecret | undefined> {
  const [row] = await tx
    .select({
      name: workspaceSecrets.name,
      ciphertext: workspaceSecrets.ciphertext,
      keyVersion: workspaceSecrets.keyVersion,
      updatedAt: workspaceSecrets.updatedAt,
    })
    .from(workspaceSecrets)
    .where(eq(workspaceSecrets.name, SecretName.parse(name)));
  return row;
}

/** Names and dates only; ciphertext is not listed. */
export async function listSecrets(tx: Tx): Promise<SecretSummary[]> {
  return tx
    .select({
      id: workspaceSecrets.id,
      name: workspaceSecrets.name,
      createdAt: workspaceSecrets.createdAt,
      updatedAt: workspaceSecrets.updatedAt,
    })
    .from(workspaceSecrets)
    .orderBy(asc(workspaceSecrets.name));
}

export async function deleteSecret(tx: Tx, name: string): Promise<void> {
  const deleted = await tx
    .delete(workspaceSecrets)
    .where(eq(workspaceSecrets.name, SecretName.parse(name)))
    .returning({ id: workspaceSecrets.id });
  if (deleted.length === 0) throw new AppError("not_found");
}
