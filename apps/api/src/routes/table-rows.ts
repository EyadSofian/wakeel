import {
  AppError,
  BotId,
  FindRowsRequest,
  ImportTableRowsRequest,
  InsertTableRowsRequest,
  PatchTableRowRequest,
  RowId,
  TableId,
  TableRowResponse,
  TableRowsPage,
  UpsertTableRowRequest,
} from "@wakeel/contracts";
import {
  appendTableRows,
  findTableRows,
  getTableRow,
  importTableCsv,
  patchTableRow,
  removeTableRow,
  type Tx,
  upsertTableRow,
} from "@wakeel/db";
import { lexicalTokens } from "@wakeel/retrieval";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireMember, type StudioDeps } from "../studio";

const params = z.object({ botId: BotId, tableId: TableId, rowId: RowId.optional() });
const find = FindRowsRequest.extend({ where: z.unknown().optional() }).strict();
const rowsResult = z.object({ data: z.array(TableRowResponse) });
const searchTerms = (text: string) => lexicalTokens(text).join(" ");

function required(id: string | undefined) {
  if (!id) throw new AppError("not_found");
  return id;
}

function revision(request: FastifyRequest) {
  const value = request.headers["if-match"];
  if (!value) throw new AppError("validation_failed", {}, { detail: "Send the current revision in If-Match." });
  return value;
}

/** All table row interactions use the parent bot and workspace as part of their scope. */
export async function tableRowRoutes(app: FastifyInstance, deps: StudioDeps) {
  const root = "/v1/workspaces/:workspaceId/bots/:botId/tables/:tableId/rows";
  async function scoped<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    writes: boolean,
    action: (tx: Tx, p: z.infer<typeof params>) => Promise<T>,
  ) {
    const { workspaceId } = await requireMember(deps, request, reply, writes ? "bot.update" : "bot.read");
    const parsed = params.safeParse(request.params);
    if (!parsed.success) throw new AppError("not_found");
    return deps.db.withWorkspace(workspaceId, (tx) => action(tx, parsed.data));
  }

  app.post(`${root}/find`, async (r, reply) => {
    const result = await scoped(r, reply, false, (tx, p) => findTableRows(tx, p, find.parse(r.body), searchTerms));
    return TableRowsPage.parse(result);
  });
  app.post(root, async (r, reply) => {
    const data = await scoped(r, reply, true, (tx, p) =>
      appendTableRows(tx, p, InsertTableRowsRequest.parse(r.body).rows, searchTerms),
    );
    return reply.code(201).send(rowsResult.parse({ data }));
  });
  app.post(`${root}/import`, async (r, reply) => {
    const data = await scoped(r, reply, true, (tx, p) =>
      importTableCsv(tx, p, ImportTableRowsRequest.parse(r.body).csv, searchTerms),
    );
    return reply.code(201).send(rowsResult.parse({ data }));
  });
  app.post(`${root}/upsert`, async (r, reply) => {
    const { row, created } = await scoped(r, reply, true, (tx, p) =>
      upsertTableRow(tx, p, UpsertTableRowRequest.parse(r.body), searchTerms, r.headers["if-match"]),
    );
    return reply
      .code(created ? 201 : 200)
      .header("etag", row.revision)
      .send(TableRowResponse.parse(row));
  });

  const item = `${root}/:rowId`;
  app.get(item, async (r, reply) => {
    const row = await scoped(r, reply, false, (tx, p) => getTableRow(tx, p, required(p.rowId)));
    return reply.header("etag", row.revision).send(TableRowResponse.parse(row));
  });
  app.patch(item, async (r, reply) => {
    const row = await scoped(r, reply, true, (tx, p) =>
      patchTableRow(tx, p, required(p.rowId), revision(r), PatchTableRowRequest.parse(r.body).values, searchTerms),
    );
    return reply.header("etag", row.revision).send(TableRowResponse.parse(row));
  });
  app.delete(item, async (r, reply) => {
    await scoped(r, reply, true, (tx, p) => removeTableRow(tx, p, required(p.rowId), revision(r)));
    return reply.code(204).send();
  });
}
