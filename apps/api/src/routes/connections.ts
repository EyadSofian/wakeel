import { generateKey } from "@wakeel/auth";
import { endRotation, rotateSigningSecrets } from "@wakeel/bridge";
import {
  AppError,
  CreateApiKeyRequest,
  CreateConnectionRequest,
  type StudioConnection,
  TestMessageRequest,
  UpdateConnectionRequest,
  webhookUrlProblem,
} from "@wakeel/contracts";
import {
  type ApiKeyRecord,
  createBridgeConnection,
  type Database,
  getBot,
  getConnectionDetail,
  insertApiKey,
  type Keyring,
  listBotConnections,
  listConnectionKeys,
  openSigningSecrets,
  revokeApiKey,
  type StudioConnectionRecord,
  setSigningSecrets,
  type Tx,
  updateBridgeConnection,
} from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { auditActor, type MemberContext, requireMember, type StudioDeps } from "../studio";
import { type BridgeDeps, inbound } from "./bridge/index";
import { deliveriesPage, replay, sendTestEvent } from "./bridge/webhook-tools";

export interface ConnectionDeps {
  studio: StudioDeps;
  bridge: BridgeDeps;
}

const IdParam = z.string().max(40);

/** A refused webhook URL is `webhook_url_blocked` with the reason on the field (ADR-030 §4). */
function checkWebhookUrl(body: unknown): void {
  const url = (body as { webhookUrl?: unknown } | null)?.webhookUrl;
  if (typeof url !== "string") return;
  const problem = webhookUrlProblem(url);
  if (problem)
    throw new AppError(
      "webhook_url_blocked",
      {},
      { errors: [{ path: "webhookUrl", code: "blocked", message: problem }] },
    );
}

/**
 * The Studio's Connections screens (task 5.5, ADR-030, design system §5.11), as the signed-in
 * builder: connections of one bot, their bridge keys and signing secrets, their deliveries, and the
 * Test tab. Reads need `connection.read`, writes `connection.manage`; every write is audited.
 */
export async function connectionRoutes(app: FastifyInstance, deps: ConnectionDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/bots/:botId/connections";
  const db: Database = deps.studio.db;
  const keyring: Keyring = deps.bridge.keyring;

  /** The member and the bot, checked to belong to the member's workspace. */
  async function scope(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: "connection.read" | "connection.manage",
  ) {
    const member = await requireMember(deps.studio, request, reply, permission);
    const botId = IdParam.parse((request.params as { botId: string }).botId);
    await db.withWorkspace(member.workspaceId, (tx) => getBot(tx, botId));
    return { member, botId };
  }

  /** One connection of the bot, or `not_found` (another bot's, or an emulator connection). */
  async function connection(tx: Tx, botId: string, request: FastifyRequest): Promise<StudioConnectionRecord> {
    const connectionId = IdParam.parse((request.params as { connectionId: string }).connectionId);
    const [found] = await listBotConnections(tx, botId, connectionId);
    if (!found) throw new AppError("not_found");
    return found;
  }

  const view = (workspaceId: string, c: StudioConnectionRecord): StudioConnection => ({
    id: c.id,
    botId: c.botId,
    name: c.name,
    target: c.target,
    status: c.status,
    webhookUrl: c.webhookUrl,
    subscribedEvents: c.subscribedEvents,
    // Opened only to show the last four characters (ADR-030 §2).
    signingSecrets: openSigningSecrets(keyring, { workspaceId, connectionId: c.id, stored: c.signingSecrets }).map(
      (secret) => ({ last4: secret.slice(-4) }),
    ),
    consecutiveDead: c.consecutiveDead,
    lastDelivery: c.lastDelivery ? { status: c.lastDelivery.status, at: c.lastDelivery.at.toISOString() } : null,
    createdAt: c.createdAt.toISOString(),
  });

  app.get(base, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.read");
    const rows = await db.withWorkspace(member.workspaceId, (tx) => listBotConnections(tx, botId));
    return { data: rows.map((c) => view(member.workspaceId, c)), nextCursor: null };
  });

  app.post(base, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    checkWebhookUrl(request.body);
    const body = CreateConnectionRequest.parse(request.body);
    const { created, secret } = await db.withWorkspace(member.workspaceId, async (tx) => {
      const conn = await createBridgeConnection(tx, {
        botId,
        name: body.name,
        target: body.target,
        subscribedEvents: body.subscribedEvents,
        ...(body.webhookUrl ? { webhookUrl: body.webhookUrl } : {}),
      });
      const rotation = rotateSigningSecrets([]);
      await setSigningSecrets(tx, keyring, {
        workspaceId: member.workspaceId,
        connectionId: conn.id,
        secrets: rotation.secrets,
      });
      await audit(tx, auditActor(member, request), {
        action: "connection.created",
        target: { type: "connection", id: conn.id },
        meta: { name: body.name, target: body.target, webhook: body.webhookUrl !== undefined },
      });
      return { created: await connection(tx, botId, paramsWith(request, conn.id)), secret: rotation.created };
    });
    // The only response that contains the signing secret (ADR-030 §2).
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({ ...view(member.workspaceId, created), signingSecret: secret });
  });

  app.get(`${base}/:connectionId`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.read");
    return view(member.workspaceId, await db.withWorkspace(member.workspaceId, (tx) => connection(tx, botId, request)));
  });

  app.patch(`${base}/:connectionId`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    checkWebhookUrl(request.body);
    const patch = UpdateConnectionRequest.parse(request.body);
    const updated = await db.withWorkspace(member.workspaceId, async (tx) => {
      const before = await connection(tx, botId, request);
      await updateBridgeConnection(tx, { botId, connectionId: before.id, patch });
      await audit(tx, auditActor(member, request), {
        action: "connection.updated",
        target: { type: "connection", id: before.id },
        // Field names and statuses only; the URL itself is the tenant's business.
        meta: {
          fields: Object.keys(patch),
          ...(patch.status ? { status: { from: before.status, to: patch.status } } : {}),
        },
      });
      return connection(tx, botId, request);
    });
    return view(member.workspaceId, updated);
  });

  app.get(`${base}/:connectionId/keys`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.read");
    const keys = await db.withWorkspace(member.workspaceId, async (tx) => {
      const c = await connection(tx, botId, request);
      return listConnectionKeys(tx, c.id);
    });
    return { data: keys.map(keyView), nextCursor: null };
  });

  app.post(`${base}/:connectionId/keys`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const body = CreateApiKeyRequest.pick({ name: true }).parse(request.body);
    const { key, prefix, secretHash } = generateKey("bridge");
    const record = await db.withWorkspace(member.workspaceId, async (tx) => {
      const c = await connection(tx, botId, request);
      const created = await insertApiKey(tx, {
        kind: "bridge",
        name: body.name,
        prefix,
        secretHash,
        scopes: [],
        botId,
        connectionId: c.id,
        createdBy: member.session.user.id,
      });
      await audit(tx, auditActor(member, request), {
        action: "api_key.created",
        target: { type: "api_key", id: created.id },
        meta: { name: created.name, prefix: `wk_bridge_${created.prefix}`, connectionId: c.id },
      });
      return created;
    });
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({ ...keyView(record), key });
  });

  app.delete(`${base}/:connectionId/keys/:keyId`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const keyId = IdParam.parse((request.params as { keyId: string }).keyId);
    await db.withWorkspace(member.workspaceId, async (tx) => {
      const c = await connection(tx, botId, request);
      // Only a key of this connection: another connection's key id is not_found here.
      if (!(await listConnectionKeys(tx, c.id)).some((k) => k.id === keyId)) throw new AppError("not_found");
      const revoked = await revokeApiKey(tx, keyId, deps.studio.now());
      await audit(tx, auditActor(member, request), {
        action: "api_key.revoked",
        target: { type: "api_key", id: revoked.id },
        meta: { name: revoked.name, prefix: `wk_bridge_${revoked.prefix}`, connectionId: c.id },
      });
    });
    return reply.code(204).send();
  });

  app.post(`${base}/:connectionId/signing-secrets/rotate`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const { updated, secret } = await db.withWorkspace(member.workspaceId, async (tx) => {
      const c = await connection(tx, botId, request);
      const current = openSigningSecrets(keyring, {
        workspaceId: member.workspaceId,
        connectionId: c.id,
        stored: c.signingSecrets,
      });
      const rotation = rotateSigningSecrets(current);
      await setSigningSecrets(tx, keyring, {
        workspaceId: member.workspaceId,
        connectionId: c.id,
        secrets: rotation.secrets,
      });
      await audit(tx, auditActor(member, request), {
        action: "connection.secret_rotated",
        target: { type: "connection", id: c.id },
        meta: { active: rotation.secrets.length },
      });
      return { updated: await connection(tx, botId, request), secret: rotation.created };
    });
    return reply
      .header("cache-control", "no-store")
      .send({ ...view(member.workspaceId, updated), signingSecret: secret });
  });

  app.post(`${base}/:connectionId/signing-secrets/finish-rotation`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const updated = await db.withWorkspace(member.workspaceId, async (tx) => {
      const c = await connection(tx, botId, request);
      const current = openSigningSecrets(keyring, {
        workspaceId: member.workspaceId,
        connectionId: c.id,
        stored: c.signingSecrets,
      });
      if (current.length === 0) throw new AppError("webhook_secret_missing");
      await setSigningSecrets(tx, keyring, {
        workspaceId: member.workspaceId,
        connectionId: c.id,
        secrets: endRotation(current),
      });
      await audit(tx, auditActor(member, request), {
        action: "connection.secret_rotated",
        target: { type: "connection", id: c.id },
        meta: { active: 1 },
      });
      return connection(tx, botId, request);
    });
    return view(member.workspaceId, updated);
  });

  app.get(`${base}/:connectionId/deliveries`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.read");
    const c = await db.withWorkspace(member.workspaceId, (tx) => connection(tx, botId, request));
    return deliveriesPage(db, member.workspaceId, c.id, request.query);
  });

  app.post(`${base}/:connectionId/deliveries/:eventId/replay`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const c = await db.withWorkspace(member.workspaceId, (tx) => connection(tx, botId, request));
    await replay(
      { db, now: deps.studio.now, enqueueWebhook: deps.bridge.enqueueWebhook },
      member.workspaceId,
      c.id,
      (request.params as { eventId: string }).eventId,
    );
    return reply.code(202).send();
  });

  app.post(`${base}/:connectionId/test`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const detail = await db.withWorkspace(member.workspaceId, async (tx) => {
      const c = await connection(tx, botId, request);
      return getConnectionDetail(tx, c.id);
    });
    if (!detail) throw new AppError("not_found");
    return sendTestEvent({ ...deps.bridge, now: deps.studio.now }, member.workspaceId, detail);
  });

  app.post(`${base}/:connectionId/test/messages`, async (request, reply) => {
    const { member, botId } = await scope(request, reply, "connection.manage");
    const body = TestMessageRequest.parse(request.body);
    const c = await db.withWorkspace(member.workspaceId, (tx) => connection(tx, botId, request));
    return inbound(deps.bridge, testContext(member, c), request, reply, {
      operation: "sendMessage",
      body,
      userId: testUserId(member),
      user: undefined,
      kind: "message",
      payload: { message: { type: "text", text: body.text, format: "plain" } },
      message: { payload: { type: "text", text: body.text, format: "plain" }, type: "text", externalId: undefined },
      // Builder traffic: never billed or counted as live (ADR-030 §3).
      mode: "emulator",
      externalConversationId: `studio-test-${member.session.sessionId}`,
    });
  });
}

/** The Test tab's conversation runs on the real connection, as the builder's test user. */
function testContext(member: MemberContext, c: StudioConnectionRecord) {
  return {
    workspaceId: member.workspaceId,
    connection: { id: c.id, botId: c.botId, name: c.name, target: c.target, status: c.status },
  };
}

const testUserId = (member: MemberContext) => `studio-test-${member.session.user.id}`;

/** Fastify params with the connection id set, for reading a connection right after creating it. */
function paramsWith(request: FastifyRequest, connectionId: string): FastifyRequest {
  return { ...request, params: { ...(request.params as object), connectionId } } as FastifyRequest;
}

const keyView = (k: ApiKeyRecord) => ({
  id: k.id,
  name: k.name,
  prefix: `wk_bridge_${k.prefix}`,
  createdBy: k.createdBy,
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  createdAt: k.createdAt.toISOString(),
});
