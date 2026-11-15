import {
  AppError,
  BotId,
  ListTableSchemasResponse,
  NewTableRequest,
  PatchTableRequest,
  TableId,
  TableSchemaResponse,
} from "@wakeel/contracts";
import { createTable, deleteTable, getTable, listTables, type TableScope, type Tx, updateTable } from "@wakeel/db";
import { indexTokens } from "@wakeel/retrieval";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireMember, type StudioDeps } from "../studio";

const scope = z.object({ botId: BotId, tableId: TableId });
const parent = scope.pick({ botId: true });
const page = z.object({
  cursor: TableId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const searchTerms = (text: string) => indexTokens(text).join(" ");

function revision(request: FastifyRequest): string {
  const match = request.headers["if-match"];
  if (!match) throw new AppError("validation_failed", {}, { detail: "Send the current revision in If-Match." });
  return match;
}

/** Studio table schema CRUD. Row operations are implemented separately. */
export async function tableRoutes(app: FastifyInstance, deps: StudioDeps) {
  const root = "/v1/workspaces/:workspaceId/bots/:botId/tables";
  const item = `${root}/:tableId`;
  async function inTable<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    action: (tx: Tx, key: TableScope) => Promise<T>,
  ) {
    const { workspaceId } = await requireMember(
      deps,
      request,
      reply,
      request.method === "GET" ? "bot.read" : "bot.update",
    );
    const parsed = scope.safeParse(request.params);
    if (!parsed.success) throw new AppError("not_found");
    return deps.db.withWorkspace(workspaceId, (tx) => action(tx, parsed.data));
  }
  app.get(root, async (request, reply) => {
    const { workspaceId } = await requireMember(deps, request, reply, "bot.read");
    const { botId } = parent.parse(request.params);
    const { cursor, limit } = page.parse(request.query);
    const data = await deps.db.withWorkspace(workspaceId, (tx) => listTables(tx, botId, cursor, limit));
    return ListTableSchemasResponse.parse(data);
  });
  app.post(root, async (request, reply) => {
    const { workspaceId } = await requireMember(deps, request, reply, "bot.update");
    const { botId } = parent.parse(request.params);
    const body = NewTableRequest.parse(request.body);
    const table = TableSchemaResponse.parse(
      await deps.db.withWorkspace(workspaceId, (tx) => createTable(tx, botId, body)),
    );
    return reply.code(201).header("etag", table.revision).send(table);
  });
  app.get(item, async (request, reply) => {
    const table = TableSchemaResponse.parse(await inTable(request, reply, getTable));
    return reply.header("etag", table.revision).send(table);
  });
  app.patch(item, async (request, reply) => {
    const table = await inTable(request, reply, async (tx, key) => {
      const existing = await getTable(tx, key);
      const patch = PatchTableRequest.parse(request.body);
      return updateTable(tx, key, revision(request), { ...existing, ...patch }, searchTerms);
    });
    return reply.header("etag", table.revision).send(TableSchemaResponse.parse(table));
  });
  app.delete(item, async (request, reply) => {
    await inTable(request, reply, (tx, key) => deleteTable(tx, key, revision(request)));
    return reply.code(204).send();
  });
}
