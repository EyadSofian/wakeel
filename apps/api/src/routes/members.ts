import { checkRemoval, checkRoleChange, type RoleChangeDenial } from "@wakeel/auth";
import { AppError, type MemberResponse, UpdateMemberRequest } from "@wakeel/contracts";
import {
  changeRole,
  countOwners,
  findMembershipByUser,
  getMembership,
  listMembers,
  type Member,
  removeMember,
  type Tx,
} from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance } from "fastify";
import { auditActor, requireMember, type StudioDeps } from "../studio";

export const toMemberResponse = (m: Member | (Omit<Member, "email" | "name"> & { email: string; name: string })) =>
  ({
    id: m.id,
    userId: m.userId,
    email: m.email,
    name: m.name,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
  }) satisfies MemberResponse;

/**
 * The actor's role read again inside the transaction, after the owner rows are locked: the role the
 * guard saw may be stale if someone changed it a moment ago.
 */
async function currentActorRole(tx: Tx, userId: string) {
  const actor = await findMembershipByUser(tx, userId);
  if (!actor) throw new AppError("not_found");
  return actor.role;
}

export function denialError(denial: RoleChangeDenial): AppError {
  return denial === "last_owner" ? new AppError("last_owner") : new AppError("forbidden");
}

/** Members of a workspace: list, change role, remove (task 1.3). */
export async function memberRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  app.get("/v1/workspaces/:workspaceId/members", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "member.read");
    const members = await deps.db.withWorkspace(ctx.workspaceId, listMembers);
    // Workspaces have tens of members; one page, as the switcher.
    return { data: members.map(toMemberResponse), nextCursor: null };
  });

  app.patch("/v1/workspaces/:workspaceId/members/:memberId", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "member.update_role");
    const { memberId } = request.params as { memberId: string };
    const { role } = UpdateMemberRequest.parse(request.body);
    const updated = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const ownerCount = await countOwners(tx);
      const actorRole = await currentActorRole(tx, ctx.session.user.id);
      const target = await getMembership(tx, memberId);
      const denial = checkRoleChange({ actorRole, from: target.role, to: role, ownerCount });
      if (denial) throw denialError(denial);
      await changeRole(tx, memberId, role);
      await audit(tx, auditActor(ctx, request), {
        action: "member.role_changed",
        target: { type: "membership", id: memberId },
        meta: { userId: target.userId, from: target.role, to: role },
      });
      return (await listMembers(tx)).find((m) => m.id === memberId);
    });
    if (!updated) throw new AppError("not_found");
    return toMemberResponse(updated);
  });

  app.delete("/v1/workspaces/:workspaceId/members/:memberId", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "member.remove");
    const { memberId } = request.params as { memberId: string };
    await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const ownerCount = await countOwners(tx);
      const actorRole = await currentActorRole(tx, ctx.session.user.id);
      const target = await getMembership(tx, memberId);
      const denial = checkRemoval({ actorRole, targetRole: target.role, ownerCount });
      if (denial) throw denialError(denial);
      await removeMember(tx, memberId);
      await audit(tx, auditActor(ctx, request), {
        action: "member.removed",
        target: { type: "membership", id: memberId },
        meta: { userId: target.userId, role: target.role },
      });
    });
    return reply.code(204).send();
  });
}
