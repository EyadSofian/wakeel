import { permissionsOf } from "@wakeel/auth";
import {
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  type WorkspaceResponse,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@wakeel/contracts";
import { createWorkspace, findMembershipByUser, getWorkspace, updateWorkspace, type Workspace } from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../session";
import { type ActorContext, auditActor, requireMember, requirePermission, type StudioDeps } from "../studio";

const roleOf = (ctx: ActorContext): WorkspaceRole | null => (ctx.type === "user" ? ctx.membership.role : null);
const permissionsFor = (ctx: ActorContext) =>
  ctx.type === "user" ? permissionsOf(ctx.membership.role) : ctx.key.scopes;

const toResponse = (w: Workspace, role: WorkspaceRole | null, permissions: string[]): WorkspaceResponse => ({
  id: w.id,
  name: w.name,
  slug: w.slug,
  plan: w.plan,
  region: w.region,
  settings: w.settings,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
  role,
  permissions,
});

/** Workspace switcher, create, read and rename (task 1.3). */
export async function workspaceRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  // The switcher: every workspace the user belongs to, by name.
  app.get("/v1/workspaces", async (request, reply) => {
    const session = await requireSession(deps.auth, deps.studioOrigin, request, reply);
    const ids = await deps.db.lookup.userWorkspaceIds(session.user.id);
    const items: WorkspaceSummary[] = [];
    for (const id of ids) {
      const item = await deps.db.withWorkspace(id, async (tx) => {
        const membership = await findMembershipByUser(tx, session.user.id);
        if (!membership) return undefined;
        const w = await getWorkspace(tx);
        return { id: w.id, name: w.name, slug: w.slug, role: membership.role };
      });
      if (item) items.push(item);
    }
    items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // A user belongs to a handful of workspaces; one page is always enough.
    return { data: items, nextCursor: null };
  });

  app.post("/v1/workspaces", async (request, reply) => {
    const session = await requireSession(deps.auth, deps.studioOrigin, request, reply);
    const body = CreateWorkspaceRequest.parse(request.body);
    const { workspace } = await createWorkspace(deps.db, { ...body, ownerUserId: session.user.id }, (tx, created) =>
      audit(
        tx,
        { type: "user", id: session.user.id, ip: request.ip },
        {
          action: "workspace.created",
          target: { type: "workspace", id: created.workspace.id },
          meta: { name: created.workspace.name, slug: created.workspace.slug },
        },
      ).then(() => undefined),
    );
    return reply.code(201).send(toResponse(workspace, "owner", permissionsOf("owner")));
  });

  app.get("/v1/workspaces/:workspaceId", async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "workspace.read");
    const w = await deps.db.withWorkspace(ctx.workspaceId, getWorkspace);
    return toResponse(w, roleOf(ctx), permissionsFor(ctx));
  });

  app.patch("/v1/workspaces/:workspaceId", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "workspace.update");
    const body = UpdateWorkspaceRequest.parse(request.body);
    const w = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const before = await getWorkspace(tx);
      const after = await updateWorkspace(tx, body);
      const changes: Record<string, { from: string; to: string }> = {};
      if (after.name !== before.name) changes["name"] = { from: before.name, to: after.name };
      if (after.slug !== before.slug) changes["slug"] = { from: before.slug, to: after.slug };
      await audit(tx, auditActor(ctx, request), {
        action: "workspace.updated",
        target: { type: "workspace", id: after.id },
        meta: changes,
      });
      return after;
    });
    return toResponse(w, ctx.membership.role, permissionsOf(ctx.membership.role));
  });
}
