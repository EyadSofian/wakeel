import { AuditAction, AuditActorType, AuditMeta, newId } from "@wakeel/contracts";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { Tx } from "../client";
import { auditLog } from "../schema/platform";
import { currentWorkspace } from "./scope";

/** Storage for `audit_log`. The writer API with its rules lives in `packages/telemetry` (task 1.6). */

export interface AuditEntry {
  id: string;
  workspaceId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: AuditMeta;
  ip: string | null;
  at: Date;
}

export interface AppendAuditInput {
  actorType: AuditActorType;
  /** Required unless `actorType` is `system`. */
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: AuditMeta;
  ip?: string;
  at?: Date;
}

const toEntry = (row: typeof auditLog.$inferSelect): AuditEntry => ({
  ...row,
  actorType: AuditActorType.parse(row.actorType),
  meta: AuditMeta.parse(row.meta),
});

export async function appendAudit(tx: Tx, input: AppendAuditInput): Promise<AuditEntry> {
  const [row] = await tx
    .insert(auditLog)
    .values({
      id: newId("aud", input.at === undefined ? {} : { now: input.at.getTime() }),
      workspaceId: currentWorkspace,
      actorType: AuditActorType.parse(input.actorType),
      actorId: input.actorId ?? null,
      action: AuditAction.parse(input.action),
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      meta: AuditMeta.parse(input.meta ?? {}),
      ip: input.ip ?? null,
      ...(input.at === undefined ? {} : { at: input.at }),
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return toEntry(row);
}

export interface AuditCursor {
  at: Date;
  id: string;
}

/** Newest first. Pass the last entry of a page as `before` to get the next page. */
export async function listAudit(tx: Tx, options: { limit: number; before?: AuditCursor }): Promise<AuditEntry[]> {
  const { before } = options;
  const rows = await tx
    .select()
    .from(auditLog)
    .where(
      before === undefined
        ? undefined
        : or(lt(auditLog.at, before.at), and(eq(auditLog.at, before.at), lt(auditLog.id, before.id))),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(options.limit);
  return rows.map(toEntry);
}
