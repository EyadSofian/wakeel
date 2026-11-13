import { type AuthService, can, type Permission, type SessionView } from "@wakeel/auth";
import { AppError, WorkspaceId } from "@wakeel/contracts";
import { type Database, findMembershipByUser, type Membership } from "@wakeel/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireSession } from "./session";

/** What Studio API routes need. Built once in main.ts and passed to every route group. */
export interface StudioDeps {
  auth: AuthService;
  studioOrigin: string;
  db: Database;
  /** Defaults to the system clock; tests pass a fake one. */
  now: () => Date;
}

export interface MemberContext {
  session: SessionView;
  workspaceId: string;
  membership: Membership;
}

/**
 * The guard for every `/v1/workspaces/{workspaceId}/…` route (task 1.3): a signed-in session (with
 * CSRF on mutations), membership in the workspace, and the permission. A workspace the caller does
 * not belong to is `not_found`, not `forbidden`, so ids cannot be probed.
 */
export async function requirePermission(
  deps: StudioDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<MemberContext> {
  const session = await requireSession(deps.auth, deps.studioOrigin, request, reply);
  const workspaceId = (request.params as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string" || !WorkspaceId.safeParse(workspaceId).success) {
    throw new AppError("not_found");
  }
  const membership = await deps.db.withWorkspace(workspaceId, (tx) => findMembershipByUser(tx, session.user.id));
  if (!membership) throw new AppError("not_found");
  if (!can(membership.role, permission)) throw new AppError("forbidden");
  return { session, workspaceId, membership };
}
