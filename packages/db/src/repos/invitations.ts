import { AppError, newId, WorkspaceRole } from "@wakeel/contracts";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Tx } from "../client";
import { invitations } from "../schema/platform";
import { rethrowUnique } from "./errors";
import { currentWorkspace } from "./scope";

export interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// token_hash stays inside this module: callers look invitations up by hash, never read it back.
const toInvitation = ({ tokenHash: _hash, ...row }: typeof invitations.$inferSelect): Invitation => ({
  ...row,
  role: WorkspaceRole.parse(row.role),
});

export interface CreateInvitationInput {
  email: string;
  role: WorkspaceRole;
  /** SHA-256 hex of the token sent in the link. */
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
}

/** An open invitation for the same address is `unique_violation` (revoke it first). */
export async function createInvitation(tx: Tx, input: CreateInvitationInput): Promise<Invitation> {
  const [row] = await tx
    .insert(invitations)
    .values({
      id: newId("inv"),
      workspaceId: currentWorkspace,
      email: input.email,
      role: WorkspaceRole.parse(input.role),
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
    })
    .returning()
    .catch(rethrowUnique({ invitations_open_email_idx: "email" }));
  if (!row) throw new Error("insert returned no row");
  return toInvitation(row);
}

export async function getInvitation(tx: Tx, invitationId: string): Promise<Invitation> {
  const [row] = await tx.select().from(invitations).where(eq(invitations.id, invitationId));
  if (!row) throw new AppError("not_found");
  return toInvitation(row);
}

/** Invitations that can still be accepted at `now`, oldest first. */
export async function listOpenInvitations(tx: Tx, now: Date): Promise<Invitation[]> {
  const rows = await tx
    .select()
    .from(invitations)
    .where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)))
    .orderBy(asc(invitations.createdAt), asc(invitations.id));
  return rows.map(toInvitation);
}

/**
 * Marks an open invitation accepted. Accepted, revoked, expired or unknown invitations are
 * `not_found`, so a link cannot be used twice.
 */
export async function markInvitationAccepted(
  tx: Tx,
  invitationId: string,
  userId: string,
  now: Date,
): Promise<Invitation> {
  const [row] = await tx
    .update(invitations)
    .set({ acceptedAt: now, acceptedBy: userId, updatedAt: now })
    .where(
      and(
        eq(invitations.id, invitationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw new AppError("not_found");
  return toInvitation(row);
}

export async function revokeInvitation(tx: Tx, invitationId: string, now: Date): Promise<Invitation> {
  const [row] = await tx
    .update(invitations)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning();
  if (!row) throw new AppError("not_found");
  return toInvitation(row);
}
