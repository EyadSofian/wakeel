import { createHash, randomBytes } from "node:crypto";
import { checkInvite } from "@wakeel/auth";
import {
  AcceptInvitationRequest,
  AppError,
  CreateInvitationRequest,
  type InvitationResponse,
  type WorkspaceSummary,
} from "@wakeel/contracts";
import {
  addMember,
  createInvitation,
  getInvitation,
  getWorkspace,
  type Invitation,
  listMembers,
  listOpenInvitations,
  markInvitationAccepted,
  revokeInvitation,
} from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../session";
import { auditActor, requireMember, type StudioDeps } from "../studio";
import { denialError } from "./members";

const INVITATION_DAYS = 7;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const toResponse = (i: Invitation): InvitationResponse => ({
  id: i.id,
  email: i.email,
  role: i.role,
  invitedBy: i.invitedBy,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

/**
 * Invitations (task 1.3). There is no mail provider yet, so the link is returned once to the inviter
 * to share; only its SHA-256 is stored. Accepting needs a session whose email matches the invitation.
 */
export async function invitationRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  app.get("/v1/workspaces/:workspaceId/invitations", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "member.invite");
    const open = await deps.db.withWorkspace(ctx.workspaceId, (tx) => listOpenInvitations(tx, deps.now()));
    return { data: open.map(toResponse), nextCursor: null };
  });

  app.post("/v1/workspaces/:workspaceId/invitations", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "member.invite");
    const body = CreateInvitationRequest.parse(request.body);
    const denial = checkInvite(ctx.membership.role, body.role);
    if (denial) throw denialError(denial);

    const token = randomBytes(32).toString("base64url");
    const now = deps.now();
    const invitation = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const members = await listMembers(tx);
      if (members.some((m) => m.email.toLowerCase() === body.email.toLowerCase())) {
        throw new AppError("unique_violation", { column: "email" });
      }
      const created = await createInvitation(tx, {
        email: body.email,
        role: body.role,
        tokenHash: sha256(token),
        invitedBy: ctx.session.user.id,
        expiresAt: new Date(now.getTime() + INVITATION_DAYS * 86_400_000),
      });
      await audit(tx, auditActor(ctx, request), {
        action: "invitation.created",
        target: { type: "invitation", id: created.id },
        meta: { email: created.email, role: created.role },
      });
      return created;
    });
    const acceptUrl = `${deps.studioOrigin}/invite/${token}`;
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({ ...toResponse(invitation), acceptUrl });
  });

  app.delete("/v1/workspaces/:workspaceId/invitations/:invitationId", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "member.invite");
    const { invitationId } = request.params as { invitationId: string };
    await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const revoked = await revokeInvitation(tx, invitationId, deps.now());
      await audit(tx, auditActor(ctx, request), {
        action: "invitation.revoked",
        target: { type: "invitation", id: revoked.id },
        meta: { email: revoked.email },
      });
    });
    return reply.code(204).send();
  });

  app.post("/v1/invitations/accept", async (request, reply) => {
    const session = await requireSession(deps.auth, deps.studioOrigin, request, reply);
    const { token } = AcceptInvitationRequest.parse(request.body);
    const found = await deps.db.lookup.invitationByTokenHash(sha256(token));
    // One answer for unknown, used, expired, revoked and someone else's link: nothing to probe.
    if (!found) throw new AppError("not_found");
    const summary = await deps.db.withWorkspace(found.workspaceId, async (tx): Promise<WorkspaceSummary> => {
      const invitation = await getInvitation(tx, found.invitationId);
      if (invitation.email.toLowerCase() !== session.user.email.toLowerCase()) throw new AppError("not_found");
      await markInvitationAccepted(tx, invitation.id, session.user.id, deps.now());
      const membership = await addMember(tx, { userId: session.user.id, role: invitation.role });
      await audit(
        tx,
        { type: "user", id: session.user.id, ip: request.ip },
        {
          action: "member.joined",
          target: { type: "membership", id: membership.id },
          meta: { invitationId: invitation.id, role: invitation.role },
        },
      );
      const w = await getWorkspace(tx);
      return { id: w.id, name: w.name, slug: w.slug, role: invitation.role };
    });
    return reply.code(200).send(summary);
  });
}
