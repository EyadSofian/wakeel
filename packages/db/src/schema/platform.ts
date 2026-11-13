import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Drizzle mirrors of migration 0003 (architecture §2.3, ADR-015). The SQL file is the source of
 * truth; these definitions only type queries. A test compares the column lists with the database.
 */

const citext = customType<{ data: string; driverData: string }>({ dataType: () => "citext" });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => at("created_at").notNull().defaultNow();
const updatedAt = () => at("updated_at").notNull().defaultNow();

// Auth tables, shaped for better-auth (ADR-015). Platform tables: no workspace_id, no RLS.

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: citext("email").notNull().unique(),
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  locale: text("locale").notNull().default("en"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: at("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: at("access_token_expires_at"),
    refreshTokenExpiresAt: at("refresh_token_expires_at"),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.providerId, t.accountId), index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: at("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// Workspaces and tenant tables. Tenant tables are only ever queried through withWorkspace.

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),
  region: text("region").notNull().default("default"),
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable("memberships", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invitations = pgTable("invitations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  email: citext("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedBy: text("invited_by"),
  expiresAt: at("expires_at").notNull(),
  acceptedAt: at("accepted_at"),
  acceptedBy: text("accepted_by"),
  revokedAt: at("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  secretHash: text("secret_hash").notNull(),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  botId: text("bot_id"),
  connectionId: text("connection_id"),
  createdBy: text("created_by"),
  lastUsedAt: at("last_used_at"),
  expiresAt: at("expires_at"),
  revokedAt: at("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceSecrets = pgTable("workspace_secrets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  ip: inet("ip"),
  at: at("at").notNull().defaultNow(),
});

/** Every table in this file, for the column-agreement test and better-auth's adapter. */
export const platformTables = {
  users,
  sessions,
  accounts,
  verifications,
  workspaces,
  memberships,
  invitations,
  apiKeys,
  workspaceSecrets,
  auditLog,
} as const;
