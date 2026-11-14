import { parseKey, secretMatches } from "@wakeel/auth";
import { AppError } from "@wakeel/contracts";
import {
  type ConnectionRecord,
  type Database,
  getApiKeyForVerification,
  getBridgeConnection,
  touchApiKey,
} from "@wakeel/db";
import type { FastifyRequest } from "fastify";

export interface BridgeContext {
  workspaceId: string;
  keyId: string;
  connection: ConnectionRecord;
}

const TOUCH_INTERVAL_MS = 60_000;

/**
 * Authenticates `Authorization: Bearer wk_bridge_…` (§9.1): the key → its connection → bot →
 * workspace. A workspace key, a revoked or expired key, or a wrong secret is `unauthenticated`; a
 * disabled connection is `connection_disabled`. Every later query is scoped to this connection.
 */
export async function requireBridgeKey(db: Database, request: FastifyRequest, now: Date): Promise<BridgeContext> {
  const presented = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
  const parsed = presented === undefined ? undefined : parseKey(presented);
  if (!parsed || parsed.kind !== "bridge") throw new AppError("unauthenticated");
  const found = await db.lookup.apiKeyByPrefix(parsed.prefix);
  if (!found) throw new AppError("unauthenticated");
  const ctx = await db.withWorkspace(found.workspaceId, async (tx) => {
    const row = await getApiKeyForVerification(tx, found.keyId);
    if (!row || !secretMatches(parsed.secret, row.secretHash)) return undefined;
    const k = row.key;
    if (k.kind !== "bridge" || k.connectionId === null) return undefined;
    if (k.revokedAt !== null || (k.expiresAt !== null && k.expiresAt <= now)) return undefined;
    const connection = await getBridgeConnection(tx, k.connectionId);
    if (!connection) return undefined;
    if (k.lastUsedAt === null || now.getTime() - k.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      await touchApiKey(tx, k.id, now);
    }
    return { workspaceId: found.workspaceId, keyId: k.id, connection };
  });
  if (!ctx) throw new AppError("unauthenticated");
  if (ctx.connection.status === "disabled") throw new AppError("connection_disabled");
  return ctx;
}
