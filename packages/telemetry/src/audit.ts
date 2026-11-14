import type { AuditActorType, AuditMeta } from "@wakeel/contracts";
import { type AuditEntry, appendAudit, type Tx } from "@wakeel/db";

/**
 * The audit log writer (task 1.6, threat T12). Every mutation of a workspace writes one entry in
 * the same transaction as the change, so there is never a change without its entry or an entry for
 * a change that rolled back. Actions are a closed list: a new mutation needs a new action here.
 *
 * `meta` says what changed in small JSON values. Never put secrets, keys, tokens or message
 * content in it.
 */
export const AUDIT_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "invitation.created",
  "invitation.revoked",
  "api_key.created",
  "api_key.revoked",
  "secret.written",
  "secret.deleted",
  "bot.created",
  "bot.updated",
  "bot.deleted",
  "workflow.created",
  "workflow.deleted",
  // Task 5.2 (ADR-028 §8): written by the delivery worker as the system actor.
  "connection.disabled",
  // Task 5.5 (ADR-030): the Studio's Connections screens.
  "connection.created",
  "connection.updated",
  "connection.secret_rotated",
] as const;
export type AuditActionName = (typeof AUDIT_ACTIONS)[number];

export interface AuditActor {
  type: AuditActorType;
  /** User or API key id; absent for `system`. */
  id?: string;
  ip?: string;
}

export interface AuditEvent {
  action: AuditActionName;
  target?: { type: string; id: string };
  meta?: AuditMeta;
}

/** Writes one entry for `event` by `actor` in the transaction's workspace. */
export async function audit(tx: Tx, actor: AuditActor, event: AuditEvent): Promise<AuditEntry> {
  return appendAudit(tx, {
    actorType: actor.type,
    ...(actor.id === undefined ? {} : { actorId: actor.id }),
    ...(actor.ip === undefined ? {} : { ip: actor.ip }),
    action: event.action,
    ...(event.target === undefined ? {} : { targetType: event.target.type, targetId: event.target.id }),
    ...(event.meta === undefined ? {} : { meta: event.meta }),
  });
}
