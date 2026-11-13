import { permissionsOf } from "@wakeel/auth";
import {
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  type WorkspaceResponse,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@wakeel/contracts";
import { createWorkspace, findMembershipByUser, getWorkspace, updateWorkspace, type Workspace } from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../session";
import { requirePermission, type StudioDeps } from "../studio";

const toResponse = (w: Workspace, role: WorkspaceRole): WorkspaceResponse => ({
  id: w.id,
  name: w.name,
  slug: w.slug,
  plan: w.plan,
  region: w.region,
  settings: w.settings,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
  role,
  permissions: permissionsOf(role),
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
    const { workspace } = await createWorkspace(deps.db, { ...body, ownerUserId: session.user.id });
    return reply.code(201).send(toResponse(workspace, "owner"));
  });

  app.get("/v1/workspaces/:workspaceId", async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "workspace.read");
    const w = await deps.db.withWorkspace(ctx.workspaceId, getWorkspace);
    return toResponse(w, ctx.membership.role);
  });

  app.patch("/v1/workspaces/:workspaceId", async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "workspace.update");
    const body = UpdateWorkspaceRequest.parse(request.body);
    const w = await deps.db.withWorkspace(ctx.workspaceId, (tx) => updateWorkspace(tx, body));
    return toResponse(w, ctx.membership.role);
  });
}
