import { AppError, newId, WorkspaceRole } from "@wakeel/contracts";
import { asc, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { memberships, users } from "../schema/platform";
import { rethrowUnique } from "./errors";
import { currentWorkspace } from "./scope";

export interface Membership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface Member extends Membership {
  email: string;
  name: string;
}

const toMembership = (row: typeof memberships.$inferSelect): Membership => ({
  ...row,
  role: WorkspaceRole.parse(row.role),
});

/** Members of the scoped workspace with their name and email, oldest first. */
export async function listMembers(tx: Tx): Promise<Member[]> {
  const rows = await tx
    .select({ m: memberships, email: users.email, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
  return rows.map((r) => ({ ...toMembership(r.m), email: r.email, name: r.name }));
}

/** The user's membership in the scoped workspace, or `undefined` if they are not a member. */
export async function findMembershipByUser(tx: Tx, userId: string): Promise<Membership | undefined> {
  const [row] = await tx.select().from(memberships).where(eq(memberships.userId, userId));
  return row ? toMembership(row) : undefined;
}

export async function getMembership(tx: Tx, membershipId: string): Promise<Membership> {
  const [row] = await tx.select().from(memberships).where(eq(memberships.id, membershipId));
  if (!row) throw new AppError("not_found");
  return toMembership(row);
}

/** Adds a user to the scoped workspace. An existing member is `unique_violation`. */
export async function addMember(tx: Tx, input: { userId: string; role: WorkspaceRole }): Promise<Membership> {
  const [row] = await tx
    .insert(memberships)
    .values({
      id: newId("mem"),
      workspaceId: currentWorkspace,
      userId: input.userId,
      role: WorkspaceRole.parse(input.role),
    })
    .returning()
    .catch(rethrowUnique({ memberships_workspace_id_user_id_key: "user" }));
  if (!row) throw new Error("insert returned no row");
  return toMembership(row);
}

export async function changeRole(tx: Tx, membershipId: string, role: WorkspaceRole): Promise<Membership> {
  const [row] = await tx
    .update(memberships)
    .set({ role: WorkspaceRole.parse(role), updatedAt: new Date() })
    .where(eq(memberships.id, membershipId))
    .returning();
  if (!row) throw new AppError("not_found");
  return toMembership(row);
}

export async function removeMember(tx: Tx, membershipId: string): Promise<void> {
  const deleted = await tx
    .delete(memberships)
    .where(eq(memberships.id, membershipId))
    .returning({ id: memberships.id });
  if (deleted.length === 0) throw new AppError("not_found");
}

/**
 * Number of owners in the scoped workspace, with their rows locked until the transaction ends, so
 * two owners demoting each other at once cannot leave the workspace with none. The RBAC layer
 * keeps the count at one or more.
 */
export async function countOwners(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.role, "owner"))
    .for("update");
  return rows.length;
}
