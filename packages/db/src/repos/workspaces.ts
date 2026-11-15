import {
  AppError,
  newId,
  WorkspaceName,
  type WorkspaceRole,
  WorkspaceSettings,
  WorkspaceSlug,
} from "@wakeel/contracts";
import { eq } from "drizzle-orm";
import type { Database, Tx } from "../client";
import { memberships, workspaces } from "../schema/platform";
import { rethrowUnique } from "./errors";
import { currentWorkspace } from "./scope";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  region: string;
  settings: WorkspaceSettings;
  createdAt: Date;
  updatedAt: Date;
}

const toWorkspace = (row: typeof workspaces.$inferSelect): Workspace => ({
  ...row,
  settings: WorkspaceSettings.parse(row.settings),
});

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  ownerUserId: string;
}

/**
 * Creates a workspace and makes `ownerUserId` its owner, in one transaction scoped to the new
 * workspace. A taken slug is `unique_violation`.
 */
export async function createWorkspace(
  db: Database,
  input: CreateWorkspaceInput,
  /** Runs in the same transaction after the rows exist, for example to write the audit entry. */
  alsoInTransaction?: (tx: Tx, created: { workspace: Workspace; membershipId: string }) => Promise<void>,
): Promise<{ workspace: Workspace; membershipId: string }> {
  const name = WorkspaceName.parse(input.name);
  const slug = WorkspaceSlug.parse(input.slug);
  const id = newId("ws");
  const membershipId = newId("mem");
  const role: WorkspaceRole = "owner";
  return db.withWorkspace(id, async (tx) => {
    const [row] = await tx
      .insert(workspaces)
      .values({ id, name, slug, settings: WorkspaceSettings.parse({}) })
      .returning()
      .catch(rethrowUnique({ workspaces_slug_key: "slug" }));
    await tx.insert(memberships).values({ id: membershipId, workspaceId: id, userId: input.ownerUserId, role });
    const created = { workspace: toWorkspace(must(row)), membershipId };
    await alsoInTransaction?.(tx, created);
    return created;
  });
}

/**
 * The workspace the transaction is scoped to. `workspaces` has no RLS (it is a platform table), so
 * the id comes from the transaction's setting, never from the caller.
 */
export async function getWorkspace(tx: Tx): Promise<Workspace> {
  const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, currentWorkspace));
  if (!row) throw new AppError("not_found");
  return toWorkspace(row);
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  settings?: WorkspaceSettings;
}

/** Updates the workspace the transaction is scoped to. */
export async function updateWorkspace(tx: Tx, input: UpdateWorkspaceInput): Promise<Workspace> {
  const values = {
    ...(input.name === undefined ? {} : { name: WorkspaceName.parse(input.name) }),
    ...(input.slug === undefined ? {} : { slug: WorkspaceSlug.parse(input.slug) }),
    ...(input.settings === undefined ? {} : { settings: WorkspaceSettings.parse(input.settings) }),
    updatedAt: new Date(),
  };
  const [row] = await tx
    .update(workspaces)
    .set(values)
    .where(eq(workspaces.id, currentWorkspace))
    .returning()
    .catch(rethrowUnique({ workspaces_slug_key: "slug" }));
  if (!row) throw new AppError("not_found");
  return toWorkspace(row);
}

function must<T>(row: T | undefined): T {
  // insert … returning always yields the row; anything else is a driver bug, reported as internal.
  if (row === undefined) throw new Error("insert returned no row");
  return row;
}
