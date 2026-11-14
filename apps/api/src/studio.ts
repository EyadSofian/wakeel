import { type AuthService, can, type Permission, parseKey, type SessionView, secretMatches } from "@wakeel/auth";
import { AppError, WorkspaceId } from "@wakeel/contracts";
import type { Keyring } from "@wakeel/db";
import {
  type ApiKeyRecord,
  type Database,
  findMembershipByUser,
  getApiKeyForVerification,
  type Membership,
  touchApiKey,
} from "@wakeel/db";
import type { AuditActor } from "@wakeel/telemetry";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireSession } from "./session";

/** What Studio API routes need. Built once in main.ts and passed to every route group. */
export interface StudioDeps {
  auth: AuthService;
  studioOrigin: string;
  db: Database;
  /** Defaults to the system clock; tests pass a fake one. */
  now: () => Date;
  /** Seals workspace secrets such as model provider keys (tasks 1.5, 6.2). */
  keyring: Keyring;
}

export interface MemberContext {
  session: SessionView;
  workspaceId: string;
  membership: Membership;
}

export interface KeyContext {
  workspaceId: string;
  key: ApiKeyRecord;
}

/** Who is acting: a signed-in member or a workspace API key. */
export type ActorContext = ({ type: "user" } & MemberContext) | ({ type: "api_key" } & KeyContext);

/** last_used_at is written at most this often per key, so a busy key does not write on every call. */
const TOUCH_INTERVAL_MS = 60_000;

const workspaceParam = (request: FastifyRequest): string => {
  const workspaceId = (request.params as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string" || !WorkspaceId.safeParse(workspaceId).success) {
    throw new AppError("not_found");
  }
  return workspaceId;
};

/**
 * The guard for routes only people may call (members, invitations, keys, secrets): a signed-in
 * session (with CSRF on mutations), membership in the workspace, and the permission. A workspace
 * the caller does not belong to is `not_found`, not `forbidden`, so ids cannot be probed. An API
 * key is refused with `forbidden`.
 */
export async function requireMember(
  deps: StudioDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<MemberContext> {
  if (request.headers.authorization !== undefined) throw new AppError("forbidden");
  const session = await requireSession(deps.auth, deps.studioOrigin, request, reply);
  const workspaceId = workspaceParam(request);
  const membership = await deps.db.withWorkspace(workspaceId, (tx) => findMembershipByUser(tx, session.user.id));
  if (!membership) throw new AppError("not_found");
  if (!can(membership.role, permission)) throw new AppError("forbidden");
  return { session, workspaceId, membership };
}

/**
 * The guard for routes people and automation both call. With `Authorization: Bearer wk_live_…`
 * the key must be valid, unrevoked, unexpired, belong to this workspace and carry the permission
 * as a scope; no cookie and no CSRF token are involved. Otherwise it is `requireMember`.
 */
export async function requirePermission(
  deps: StudioDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
): Promise<ActorContext> {
  const header = request.headers.authorization;
  if (header === undefined) return { type: "user", ...(await requireMember(deps, request, reply, permission)) };

  const presented = /^Bearer (\S+)$/.exec(header)?.[1];
  const parsed = presented === undefined ? undefined : parseKey(presented);
  if (!parsed || parsed.kind !== "workspace") throw new AppError("unauthenticated");
  const found = await deps.db.lookup.apiKeyByPrefix(parsed.prefix);
  if (!found) throw new AppError("unauthenticated");

  const now = deps.now();
  const key = await deps.db.withWorkspace(found.workspaceId, async (tx) => {
    const row = await getApiKeyForVerification(tx, found.keyId);
    if (!row || !secretMatches(parsed.secret, row.secretHash)) return undefined;
    const k = row.key;
    if (k.kind !== "workspace" || k.revokedAt !== null || (k.expiresAt !== null && k.expiresAt <= now)) {
      return undefined;
    }
    if (k.lastUsedAt === null || now.getTime() - k.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      await touchApiKey(tx, k.id, now);
    }
    return k;
  });
  if (!key) throw new AppError("unauthenticated");

  // A key from workspace A answers as if B did not exist.
  const workspaceId = workspaceParam(request);
  if (workspaceId !== key.workspaceId) throw new AppError("not_found");
  if (!key.scopes.includes(permission)) throw new AppError("forbidden");
  return { type: "api_key", workspaceId, key };
}

/** The audit actor for a request: the signed-in user or the API key, with the client address. */
export function auditActor(ctx: MemberContext | ActorContext, request: FastifyRequest): AuditActor {
  if ("type" in ctx && ctx.type === "api_key") return { type: "api_key", id: ctx.key.id, ip: request.ip };
  return { type: "user", id: ctx.session.user.id, ip: request.ip };
}
