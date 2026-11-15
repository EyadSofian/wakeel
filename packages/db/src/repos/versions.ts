import { createHash } from "node:crypto";
import {
  AppError,
  BotDefinition,
  type BotManifest,
  type DefinitionIssue,
  newId,
  SCHEMA_VERSION,
  TableId,
  type ValidationContext,
  validateDefinition,
  type Workflow,
} from "@wakeel/contracts";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { botDraftDocs, bots, botVersions } from "../schema/bots";
import { users } from "../schema/platform";
import { getBot, listDraftDocs } from "./bots";
import { evalPublishStatus } from "./eval-publish";
import { listKnowledgeBases } from "./kb";
import { currentWorkspace } from "./scope";

/**
 * Versions (task 7.1, ADR-006, ADR-036): publish stores an immutable snapshot of the whole
 * definition and points the bot at it; rollback moves only the pointer; restore copies a snapshot
 * back into the draft documents.
 */

export interface VersionSummary {
  id: string;
  botId: string;
  number: number;
  label: string;
  notes: string;
  definitionHash: string;
  createdBy: string | null;
  /** The publisher's name, when the version was published by a user who still exists. */
  createdByName: string | null;
  createdAt: Date;
}

export interface Version extends VersionSummary {
  definition: BotDefinition;
}

const toSummary = (row: typeof botVersions.$inferSelect, createdByName: string | null = null): VersionSummary => ({
  id: row.id,
  botId: row.botId,
  number: row.number,
  label: row.label,
  notes: row.notes,
  definitionHash: row.definitionHash,
  createdBy: row.createdBy,
  createdByName,
  createdAt: row.createdAt,
});

const toVersion = (row: typeof botVersions.$inferSelect, createdByName: string | null): Version => ({
  ...toSummary(row, createdByName),
  definition: BotDefinition.parse(row.definition),
});

/** JSON with object keys sorted at every level, so equal values always serialise the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the definition's canonical JSON, lowercase hex (ADR-036 §2). */
export function definitionHash(def: BotDefinition): string {
  return createHash("sha256").update(canonicalJson(def)).digest("hex");
}

async function ownedTableIds(tx: Tx, botId: string): Promise<Set<string>> {
  const tables = await tx.execute(sql`select id from bot_tables where bot_id = ${botId}`);
  return new Set(tables.rows.map((row) => TableId.parse(row["id"])));
}

/** The bot's draft assembled into one definition: the manifest and its workflows, main first. */
export async function assembleDraft(tx: Tx, botId: string): Promise<BotDefinition> {
  const docs = await listDraftDocs(tx, botId);
  const manifest = docs.find((d) => d.kind === "manifest")?.doc as BotManifest | undefined;
  if (!manifest) throw new AppError("not_found", {}, { detail: `Bot ${botId} has no draft manifest.` });
  const workflows = docs.filter((d) => d.kind === "workflow").map((d) => d.doc as Workflow);
  workflows.sort((a, b) => (a.id === manifest.mainWorkflowId ? -1 : b.id === manifest.mainWorkflowId ? 1 : 0));
  return BotDefinition.parse({ schemaVersion: SCHEMA_VERSION, manifest, workflows });
}

/**
 * Publishes the draft: validates it, stores version `n + 1` and makes it live, in one transaction.
 * Any error-severity issue refuses with `definition_invalid` carrying every issue.
 */
export async function publishDraft(
  tx: Tx,
  input: { botId: string; label: string; notes?: string; userId: string | null; context?: ValidationContext },
): Promise<{ version: VersionSummary; issues: DefinitionIssue[] }> {
  // Serialise publishes of one bot, so two never take the same number.
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, input.botId)).for("update");
  await getBot(tx, input.botId);
  const definition = await assembleDraft(tx, input.botId);
  if (definition.manifest.settings.blockPublishOnFailingEvals) {
    const status = await evalPublishStatus(tx, input.botId, definition);
    if (status.failed || status.errors) throw new AppError("eval_publish_blocked");
  }
  const knowledgeBaseIds = new Set((await listKnowledgeBases(tx, input.botId)).map((b) => b.id));
  const issues = validateDefinition(definition, {
    ...input.context,
    knowledgeBaseIds,
    tableIds: await ownedTableIds(tx, input.botId),
  });
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new AppError(
      "definition_invalid",
      { count: errors.length },
      { errors: errors.map((i) => ({ path: i.path, code: i.code, message: i.message })) },
    );
  }
  const [last] = await tx
    .select({ number: botVersions.number })
    .from(botVersions)
    .where(eq(botVersions.botId, input.botId))
    .orderBy(desc(botVersions.number))
    .limit(1);
  const [row] = await tx
    .insert(botVersions)
    .values({
      id: newId("ver"),
      workspaceId: currentWorkspace,
      botId: input.botId,
      number: (last?.number ?? 0) + 1,
      label: input.label,
      notes: input.notes ?? "",
      definition,
      definitionHash: definitionHash(definition),
      createdBy: input.userId,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  await tx.update(bots).set({ publishedVersionId: row.id, updatedAt: new Date() }).where(eq(bots.id, input.botId));
  return { version: toSummary(row), issues };
}

/** Versions of a bot, newest first; `before` is the number to continue below. */
export async function listVersions(
  tx: Tx,
  botId: string,
  page: { limit: number; before?: number },
): Promise<{ data: VersionSummary[]; next: number | null }> {
  await getBot(tx, botId);
  const rows = await tx
    .select({ v: botVersions, name: users.name })
    .from(botVersions)
    .leftJoin(users, eq(users.id, botVersions.createdBy))
    .where(
      and(eq(botVersions.botId, botId), page.before === undefined ? undefined : lt(botVersions.number, page.before)),
    )
    .orderBy(desc(botVersions.number))
    .limit(page.limit + 1);
  const data = rows.slice(0, page.limit).map((r) => toSummary(r.v, r.name));
  return { data, next: rows.length > page.limit ? (data.at(-1)?.number ?? null) : null };
}

export async function getVersion(tx: Tx, botId: string, versionId: string): Promise<Version> {
  const [row] = await tx
    .select({ v: botVersions, name: users.name })
    .from(botVersions)
    .leftJoin(users, eq(users.id, botVersions.createdBy))
    .where(and(eq(botVersions.botId, botId), eq(botVersions.id, versionId)));
  if (!row) throw new AppError("not_found");
  return toVersion(row.v, row.name);
}

/** A version's definition by id alone, for the turn worker (the conversation names the version). */
export async function loadVersionDefinition(tx: Tx, versionId: string): Promise<BotDefinition> {
  const [row] = await tx
    .select({ definition: botVersions.definition })
    .from(botVersions)
    .where(eq(botVersions.id, versionId));
  if (!row) throw new AppError("not_found", {}, { detail: `Version ${versionId} does not exist.` });
  return BotDefinition.parse(row.definition);
}

/** Makes an existing version live. Only the bot's pointer changes. */
export async function rollbackTo(
  tx: Tx,
  botId: string,
  versionId: string,
): Promise<{ from: string | null; to: VersionSummary }> {
  // Serialize the published pointer with resource deletion.
  await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for("update");
  const bot = await getBot(tx, botId);
  const version = await getVersion(tx, botId, versionId);
  const knowledgeBaseIds = new Set((await listKnowledgeBases(tx, botId)).map((b) => b.id));
  const issues = validateDefinition(version.definition, { knowledgeBaseIds, tableIds: await ownedTableIds(tx, botId) });
  const missing = issues.filter((i) => i.code === "kb_unknown" || i.code === "table_unknown");
  if (missing.length)
    throw new AppError(
      "definition_invalid",
      { count: missing.length },
      {
        errors: missing.map((i) => ({ path: i.path, code: i.code, message: i.message })),
      },
    );
  await tx.update(bots).set({ publishedVersionId: version.id, updatedAt: new Date() }).where(eq(bots.id, botId));
  return { from: bot.publishedVersionId, to: version };
}

/**
 * Makes the draft equal to a version: the manifest and each of its workflows become new revisions
 * (missing workflows are created), and draft workflows the version does not have are deleted.
 */
export async function restoreVersion(
  tx: Tx,
  input: { botId: string; versionId: string; userId: string | null },
): Promise<{ removedWorkflows: string[] }> {
  const version = await getVersion(tx, input.botId, input.versionId);
  const now = new Date();
  const existing = await listDraftDocs(tx, input.botId);
  const keep = new Set(version.definition.workflows.map((w) => w.id));
  const upsert = async (kind: "manifest" | "workflow", docId: string, doc: BotManifest | Workflow) => {
    await tx
      .insert(botDraftDocs)
      .values({ workspaceId: currentWorkspace, botId: input.botId, kind, docId, rev: 0, doc, updatedBy: input.userId })
      .onConflictDoUpdate({
        target: [botDraftDocs.botId, botDraftDocs.kind, botDraftDocs.docId],
        set: { doc, rev: sql`${botDraftDocs.rev} + 1`, updatedBy: input.userId, updatedAt: now },
      });
  };
  await upsert("manifest", "manifest", version.definition.manifest);
  for (const wf of version.definition.workflows) await upsert("workflow", wf.id, wf);
  const removed = existing.filter((d) => d.kind === "workflow" && !keep.has(d.docId));
  for (const d of removed) {
    await tx
      .delete(botDraftDocs)
      .where(
        and(eq(botDraftDocs.botId, input.botId), eq(botDraftDocs.kind, "workflow"), eq(botDraftDocs.docId, d.docId)),
      );
  }
  await tx.update(bots).set({ name: version.definition.manifest.name, updatedAt: now }).where(eq(bots.id, input.botId));
  return { removedWorkflows: removed.map((d) => d.docId) };
}
