import { sql } from "drizzle-orm";
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Drizzle mirrors of migration 0005 (task 4.1). The SQL file is the source of truth: constraints,
 * composite foreign keys and indexes live there. Sequence counters are bigint in SQL and numbers
 * here; a conversation will not reach 2^53 events.
 */
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const seq = (name: string) => bigint(name, { mode: "number" });

export const bridgeConnections = pgTable("bridge_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id").notNull(),
  name: text("name").notNull(),
  target: text("target").notNull(),
  webhookUrl: text("webhook_url"),
  signingSecrets: jsonb("signing_secrets").notNull().default(sql`'[]'::jsonb`),
  subscribedEvents: text("subscribed_events").array().notNull().default(sql`'{}'`),
  status: text("status").notNull().default("active"),
  consecutiveDead: integer("consecutive_dead").notNull().default(0),
  /** Set on the emulator's draft connection for one builder session (0007, ADR-025). */
  emulatorSessionId: text("emulator_session_id"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const endUsers = pgTable("end_users", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id").notNull(),
  connectionId: text("connection_id").notNull(),
  externalId: text("external_id").notNull(),
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
  vars: jsonb("vars").notNull().default(sql`'{}'::jsonb`),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id").notNull(),
  connectionId: text("connection_id").notNull(),
  endUserId: text("end_user_id").notNull(),
  externalId: text("external_id").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull().default("idle"),
  versionId: text("version_id"),
  state: jsonb("state").notNull(),
  stateBytes: integer("state_bytes").notNull(),
  nextInSeq: seq("next_in_seq").notNull().default(1),
  nextOutSeq: seq("next_out_seq").notNull().default(1),
  leaseOwner: text("lease_owner"),
  leaseUntil: at("lease_until"),
  leaseEpoch: seq("lease_epoch").notNull().default(0),
  lastActivityAt: at("last_activity_at").notNull().defaultNow(),
  expiresAt: at("expires_at"),
  endedAt: at("ended_at"),
  endedReason: text("ended_reason"),
  handoff: jsonb("handoff"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const inboundEvents = pgTable("inbound_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  connectionId: text("connection_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  seq: seq("seq").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  idempotencyKey: text("idempotency_key"),
  receivedAt: at("received_at").notNull().defaultNow(),
  processedAt: at("processed_at"),
  turnId: text("turn_id"),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const turns = pgTable("turns", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  botId: text("bot_id").notNull(),
  versionId: text("version_id"),
  triggerEventId: text("trigger_event_id").notNull(),
  status: text("status").notNull().default("running"),
  stepCount: integer("step_count").notNull().default(0),
  usage: jsonb("usage").notNull().default(sql`'{}'::jsonb`),
  error: jsonb("error"),
  startedAt: at("started_at").notNull().defaultNow(),
  endedAt: at("ended_at"),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  seq: seq("seq").notNull(),
  direction: text("direction").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  citations: jsonb("citations").notNull().default(sql`'[]'::jsonb`),
  turnId: text("turn_id"),
  externalId: text("external_id"),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  connectionId: text("connection_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  seq: seq("seq"),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  ephemeral: boolean("ephemeral").notNull().default(false),
  createdAt: at("created_at").notNull().defaultNow(),
});

/** Migration 0009 (task 5.2): one row per webhook delivery attempt (ADR-028). */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  connectionId: text("connection_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  outboxEventId: text("outbox_event_id").notNull(),
  seq: seq("seq"),
  ephemeral: boolean("ephemeral").notNull(),
  attempt: integer("attempt").notNull(),
  status: text("status").notNull().default("pending"),
  nextAttemptAt: at("next_attempt_at").notNull(),
  leaseUntil: at("lease_until"),
  attemptedAt: at("attempted_at"),
  responseStatus: integer("response_status"),
  error: jsonb("error"),
  durationMs: integer("duration_ms"),
  createdAt: at("created_at").notNull().defaultNow(),
});

/** Migration 0008 (task 4.7): span metadata, partitioned by month on started_at (ADR-009, ADR-026). */
export const traceSpans = pgTable("trace_spans", {
  id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  turnId: text("turn_id").notNull(),
  parentId: text("parent_id"),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  startedAt: at("started_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  location: jsonb("location").notNull().default(sql`'{}'::jsonb`),
  attrs: jsonb("attrs").notNull().default(sql`'{}'::jsonb`),
  payloadKey: text("payload_key"),
});

export const runtimeTables = {
  bridgeConnections,
  endUsers,
  conversations,
  inboundEvents,
  turns,
  messages,
  outboxEvents,
} as const;
