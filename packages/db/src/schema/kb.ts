import { sql } from "drizzle-orm";
import { bigint, customType, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Drizzle mirrors of migration 0015 (task 8.1, ADR-039). The SQL file is the source of truth. */
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1024)",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});
const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => "tsvector" });
const interval = customType<{ data: string; driverData: string }>({ dataType: () => "interval" });

export const files = pgTable("files", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id"),
  purpose: text("purpose").notNull(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  status: text("status").notNull().default("pending"),
  createdBy: text("created_by"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const knowledgeBases = pgTable("knowledge_bases", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  embeddingModel: text("embedding_model").notNull(),
  embeddingDims: integer("embedding_dims").notNull().default(1024),
  indexVersion: integer("index_version").notNull().default(1),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const kbSources = pgTable("kb_sources", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kbId: text("kb_id").notNull(),
  kind: text("kind").notNull(),
  config: jsonb("config").notNull(),
  schedule: interval("schedule"),
  status: text("status").notNull().default("pending"),
  lastSyncedAt: at("last_synced_at"),
  error: jsonb("error"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const kbDocuments = pgTable("kb_documents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kbId: text("kb_id").notNull(),
  sourceId: text("source_id").notNull(),
  title: text("title").notNull().default(""),
  uri: text("uri").notNull(),
  mime: text("mime"),
  lang: text("lang"),
  contentHash: text("content_hash"),
  parsedKey: text("parsed_key"),
  status: text("status").notNull().default("pending"),
  tokenCount: integer("token_count").notNull().default(0),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const kbChunks = pgTable("kb_chunks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kbId: text("kb_id").notNull(),
  documentId: text("document_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  headingPath: text("heading_path").array().notNull().default(sql`'{}'`),
  text: text("text").notNull(),
  textNorm: text("text_norm").notNull(),
  lex: tsvector("lex").notNull(),
  embedding: vector("embedding"),
  tokenCount: integer("token_count").notNull(),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  indexVersion: integer("index_version").notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const kbIngestionJobs = pgTable("kb_ingestion_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kbId: text("kb_id").notNull(),
  sourceId: text("source_id").notNull(),
  documentId: text("document_id"),
  stage: text("stage").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  error: jsonb("error"),
  contentHash: text("content_hash"),
  startedAt: at("started_at"),
  finishedAt: at("finished_at"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const kbTables = { files, knowledgeBases, kbSources, kbDocuments, kbChunks, kbIngestionJobs } as const;
