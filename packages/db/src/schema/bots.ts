import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/** Drizzle mirrors of migration 0004 (task 2.1). The SQL file is the source of truth. */
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

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

export const botTables = { bots, botDraftDocs } as const;
