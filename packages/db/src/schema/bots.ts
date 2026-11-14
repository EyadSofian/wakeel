import { sql } from "drizzle-orm";
import { boolean, customType, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Drizzle mirrors of migrations 0004 and 0012 (tasks 2.1, 7.1). The SQL files are the source of truth. */
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const bots = pgTable("bots", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  defaultLocale: text("default_locale").notNull().default("ar"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  publishedVersionId: text("published_version_id"),
  archivedAt: at("archived_at"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const botDraftDocs = pgTable(
  "bot_draft_docs",
  {
    workspaceId: text("workspace_id").notNull(),
    botId: text("bot_id").notNull(),
    kind: text("kind").notNull(),
    docId: text("doc_id").notNull(),
    rev: integer("rev").notNull(),
    doc: jsonb("doc").notNull(),
    updatedBy: text("updated_by"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.kind, t.docId] })],
);

/** Mirror of migration 0012 (task 7.1). Immutable: app_rw can insert and read only. */
export const botVersions = pgTable("bot_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id").notNull(),
  number: integer("number").notNull(),
  label: text("label").notNull(),
  notes: text("notes").notNull().default(""),
  definition: jsonb("definition").notNull(),
  definitionHash: text("definition_hash").notNull(),
  createdBy: text("created_by"),
  createdAt: at("created_at").notNull().defaultNow(),
  publishedAt: at("published_at").notNull().defaultNow(),
});

/** Mirror of migration 0014 (task 7.3): sealed config variable values per environment. */
export const botConfigVars = pgTable(
  "bot_config_vars",
  {
    workspaceId: text("workspace_id").notNull(),
    botId: text("bot_id").notNull(),
    env: text("env").notNull(),
    key: text("key").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    keyVersion: integer("key_version").notNull(),
    isSecret: boolean("is_secret").notNull(),
    updatedBy: text("updated_by"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.env, t.key] })],
);

export const botTables = { bots, botDraftDocs, botVersions, botConfigVars } as const;
