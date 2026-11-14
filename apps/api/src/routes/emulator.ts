import {
  AppError,
  BotManifest,
  type EmulatorStateResponse,
  type EmulatorVariable,
  type Json,
  RunFromRequest,
  SendMessageRequest,
  STATE_MAX_BYTES,
  UserData,
  type Variable,
  Workflow,
} from "@wakeel/contracts";
import {
  ensureEmulatorConnection,
  findConversation,
  getBot,
  getConversation,
  getEndUser,
  listDraftDocs,
} from "@wakeel/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireMember, type StudioDeps } from "../studio";
import type { BridgeContext } from "./bridge/auth";
import { type BridgeDeps, ExternalId, inbound, sendMessageInput, updateUser } from "./bridge/index";

export interface EmulatorDeps {
  studio: StudioDeps;
  bridge: BridgeDeps;
}

const encoder = new TextEncoder();

/**
 * The Studio emulator (task 4.6, ADR-025). Every route runs as the signed-in builder, needs
 * `bot.update` (the emulator runs the draft, its code and its model calls) and works on the draft
 * connection of the builder's session for this bot, created on first use. Messages, the test user
 * and Run from here take the Bridge inbound path in-process, so their behaviour, idempotency and
 * SSE are the Bridge API's; no bridge key is created or sent to the browser.
 */
export async function emulatorRoutes(app: FastifyInstance, deps: EmulatorDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/bots/:botId/emulator";

  /** The builder's emulator connection for this bot, as a Bridge context. */
  async function context(request: FastifyRequest, reply: FastifyReply): Promise<BridgeContext> {
    const member = await requireMember(deps.studio, request, reply, "bot.update");
    const botId = z
      .string()
      .max(40)
      .parse((request.params as { botId: string }).botId);
    const connection = await deps.studio.db.withWorkspace(member.workspaceId, async (tx) => {
      // A bot of another workspace (or an archived one) is not_found, not a foreign-key error.
      await getBot(tx, botId);
      return ensureEmulatorConnection(tx, { botId, sessionId: member.session.sessionId });
    });
    return { workspaceId: member.workspaceId, connection };
  }

  app.post(`${base}/conversations/:externalConversationId/messages`, async (request, reply) => {
    const ctx = await context(request, reply);
    return inbound(deps.bridge, ctx, request, reply, sendMessageInput(SendMessageRequest.parse(request.body)));
  });

  app.post(`${base}/conversations/:externalConversationId/run-from`, async (request, reply) => {
    const ctx = await context(request, reply);
    const body = RunFromRequest.parse(request.body);
    return inbound(deps.bridge, ctx, request, reply, {
      operation: "runFrom",
      body,
      userId: body.userId,
      user: body.user,
      kind: "run_from",
      payload: { workflowId: body.workflowId, nodeId: body.nodeId },
    });
  });

  app.put(`${base}/users/:externalUserId`, async (request, reply) => {
    const ctx = await context(request, reply);
    const externalId = z
      .string()
      .min(1)
      .max(255)
      .parse((request.params as { externalUserId: string }).externalUserId);
    return updateUser(deps.bridge, ctx, externalId, UserData.parse(request.body));
  });

  app.get(`${base}/conversations/:externalConversationId/state`, async (request, reply) => {
    const ctx = await context(request, reply);
    const externalId = ExternalId.parse((request.params as { externalConversationId: string }).externalConversationId);
    return deps.studio.db.withWorkspace(ctx.workspaceId, async (tx): Promise<EmulatorStateResponse> => {
      const found = await findConversation(tx, ctx.connection.id, externalId);
      if (!found) throw new AppError("not_found");
      const [conv, docs] = await Promise.all([getConversation(tx, found.id), listDraftDocs(tx, ctx.connection.botId)]);
      const user = await getEndUser(tx, conv.endUserId);
      const manifest = BotManifest.parse(docs.find((d) => d.kind === "manifest")?.doc);
      const top = conv.state.stack.at(-1);
      const topWorkflow = top
        ? docs.filter((d) => d.kind === "workflow").find((d) => d.docId === top.workflowId)
        : undefined;
      const workflowVars = topWorkflow ? Workflow.parse(topWorkflow.doc).variables : [];

      const values: Record<Variable["scope"], Record<string, Json>> = {
        bot: {},
        user: user.vars,
        conversation: conv.state.conversationVars,
        workflow: top?.vars ?? {},
      };
      const view = (v: Variable, workflowId?: string): EmulatorVariable => ({
        id: v.id,
        name: v.name,
        scope: v.scope,
        type: v.type,
        // Never sent for a sensitive variable, not even a redacted form (variable.ts).
        value: v.sensitive ? null : (values[v.scope][v.id] ?? v.default ?? null),
        sensitive: v.sensitive,
        ...(workflowId ? { workflowId } : {}),
      });
      return {
        conversationId: conv.id,
        status: conv.state.status,
        variables: [...manifest.variables.map((v) => view(v)), ...workflowVars.map((v) => view(v, top?.workflowId))],
        attributes: user.attributes,
        stateBytes: encoder.encode(JSON.stringify(conv.state)).length,
        limitBytes: STATE_MAX_BYTES,
      };
    });
  });
}
