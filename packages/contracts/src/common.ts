import { z } from "zod";

/** Stored-entity id: `<prefix>_<lowercase ULID>` (26 chars). */
export const entityId = <P extends string>(prefix: P) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`), `Expected a ${prefix}_ id`);

/** Definition-element id: `<prefix>_<10-char nanoid>`; unique within a bot, never reused. */
export const elementId = <P extends string>(prefix: P) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-Za-z]{10}$`), `Expected a ${prefix}_ id`);

export const WorkspaceId = entityId("ws");
export const BotId = entityId("bot");
export const VersionId = entityId("ver");
export const ConnectionId = entityId("conn");
export const EndUserId = entityId("eu");
export const ConversationId = entityId("conv");
export const MessageId = entityId("msg");
export const EventId = entityId("evt");
export const TurnId = entityId("turn");
export const OutboxEventId = entityId("out");
export const SpanId = entityId("span");
export const KnowledgeBaseId = entityId("kb");
export const DocumentId = entityId("doc");
export const ChunkId = entityId("chk");
export const TableId = entityId("tbl");
export const RowId = entityId("row");
// Platform (architecture §2.3, ADR-015)
export const UserId = entityId("usr");
export const SessionId = entityId("ses");
export const AccountId = entityId("acc");
export const VerificationId = entityId("vrf");
export const MembershipId = entityId("mem");
export const InvitationId = entityId("inv");
export const ApiKeyId = entityId("key");
export const SecretId = entityId("sec");
export const AuditEntryId = entityId("aud");
export const WebhookDeliveryId = entityId("dlv");

export const WorkflowId = elementId("wf");
export const NodeId = elementId("node");
export const CardId = elementId("card");
export const EdgeId = elementId("edge");
export const VariableId = elementId("var");
export const ToolId = elementId("tool");
export const ExitId = elementId("exit");
export const BranchId = elementId("br");
export const ColumnId = elementId("col");

/** A name usable as a JavaScript identifier (variables, tools, exits, workflow io). */
export const Identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,47}$/, "Use letters, digits and underscores; start with a letter");

/** Human-facing name shown in the Studio. */
export const DisplayName = z.string().trim().min(1).max(80);

/** Text that may contain `{{ expression }}` placeholders. */
export const Template = z.string().max(16_000);
export const NonEmptyTemplate = Template.min(1);

/** A single JavaScript expression evaluated against the scope objects. */
export const Expression = z.string().min(1).max(4_000);

/** Any JSON value. */
export const Json = z.json();
export type Json = z.infer<typeof Json>;

/**
 * JSON Schema (draft 2020-12 subset: type, properties, required, items, enum,
 * description, minimum, maximum, minLength, maxLength, format). Validated
 * structurally by `packages/contracts/src/json-schema.ts` at publish time.
 */
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const IsoDateTime = z.iso.datetime({ offset: true });

/** BCP 47 language tag, e.g. `ar`, `ar-EG`, `en`. */
export const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/);

/** `provider:model` key into `packages/llm/models.json`. */
export const ModelRef = z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9._:/-]+$/);

export const HttpsUrl = z.url({ protocol: /^https$/ });
export const HttpUrl = z.url({ protocol: /^https?$/ });
