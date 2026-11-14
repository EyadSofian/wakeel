import { FILE_LIMITS } from "@wakeel/config";
import {
  AppError,
  CreateFileRequest,
  type CreateFileResponse,
  FileId,
  type FileResponse,
  type PresignedRequest,
} from "@wakeel/contracts";
import { createFile, type FileRecord, getBot, getFile, markFileReady } from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditActor, requirePermission, type StudioDeps } from "../studio";

/**
 * Uploads (task 8.1, ADR-039 §2): the api announces a file and signs one PUT for its exact key,
 * type and size; the browser sends the bytes to the object store; `complete` checks what arrived.
 */

const MB = 1024 * 1024;

const toResponse = (f: FileRecord): FileResponse => ({
  id: f.id as FileResponse["id"],
  botId: (f.botId as FileResponse["botId"]) ?? null,
  purpose: f.purpose as FileResponse["purpose"],
  name: f.name,
  mime: f.mime,
  size: f.size,
  status: f.status as FileResponse["status"],
  createdAt: f.createdAt.toISOString(),
});

const invalid = (path: string, code: string, message: string) =>
  new AppError("validation_failed", {}, { errors: [{ path, code, message }] });

/** The declared type without parameters (`text/plain; charset=utf-8` → `text/plain`), lowercased. */
const baseMime = (mime: string) => (mime.split(";")[0] ?? "").trim().toLowerCase();

const fileParam = (request: FastifyRequest) => {
  const parsed = FileId.safeParse((request.params as { fileId?: unknown }).fileId);
  if (!parsed.success) throw new AppError("not_found");
  return parsed.data;
};

export async function fileRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/files";

  app.post(base, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const body = CreateFileRequest.parse(request.body);
    const limits = FILE_LIMITS.kbSource;
    const mime = baseMime(body.mime);
    if (!(limits.mimes as readonly string[]).includes(mime)) {
      throw invalid(
        "mime",
        "type_not_allowed",
        "Upload a PDF, Word, PowerPoint, Excel, HTML, Markdown, text, CSV, PNG or JPEG file",
      );
    }
    if (body.size > limits.maxBytes) {
      throw invalid("size", "too_large", `Upload a file of ${limits.maxBytes / MB} MB or less`);
    }
    const userId = ctx.type === "user" ? ctx.session.user.id : null;
    const file = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      if (body.botId) await getBot(tx, body.botId);
      const row = await createFile(tx, {
        workspaceId: ctx.workspaceId,
        botId: body.botId ?? null,
        purpose: body.purpose,
        name: body.name,
        mime,
        size: body.size,
        createdBy: userId,
      });
      await audit(tx, auditActor(ctx, request), {
        action: "file.created",
        target: { type: "file", id: row.id },
        meta: { purpose: row.purpose, mime, size: row.size },
      });
      return row;
    });
    const ttl = FILE_LIMITS.uploadUrlSeconds;
    const upload: PresignedRequest = {
      url: await deps.objectStore.presignPut(file.key, { mime, size: file.size, ttlSeconds: ttl }),
      method: "PUT",
      headers: { "content-type": mime },
      expiresAt: new Date(deps.now().getTime() + ttl * 1000).toISOString(),
    };
    const res: CreateFileResponse = { file: toResponse(file), upload };
    return reply.code(201).send(res);
  });

  app.get(`${base}/:fileId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const fileId = fileParam(request);
    return toResponse(await deps.db.withWorkspace(ctx.workspaceId, (tx) => getFile(tx, fileId)));
  });

  app.post(`${base}/:fileId/complete`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const fileId = fileParam(request);
    const file = await deps.db.withWorkspace(ctx.workspaceId, (tx) => getFile(tx, fileId));
    if (file.status === "ready") return toResponse(file);
    const head = await deps.objectStore.head(file.key);
    if (!head || head.size !== file.size || (head.mime !== undefined && baseMime(head.mime) !== file.mime)) {
      throw new AppError("upload_incomplete");
    }
    const ready = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const row = await markFileReady(tx, fileId);
      await audit(tx, auditActor(ctx, request), {
        action: "file.uploaded",
        target: { type: "file", id: row.id },
        meta: { size: row.size },
      });
      return row;
    });
    return toResponse(ready);
  });

  app.get(`${base}/:fileId/download`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const fileId = fileParam(request);
    const file = await deps.db.withWorkspace(ctx.workspaceId, (tx) => getFile(tx, fileId));
    if (file.status !== "ready") throw new AppError("upload_incomplete");
    const ttl = FILE_LIMITS.downloadUrlSeconds;
    const res: PresignedRequest = {
      url: await deps.objectStore.presignGet(file.key, { ttlSeconds: ttl, downloadName: file.name }),
      method: "GET",
      headers: {},
      expiresAt: new Date(deps.now().getTime() + ttl * 1000).toISOString(),
    };
    return res;
  });
}
