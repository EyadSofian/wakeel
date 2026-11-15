import { z } from "zod";
import { BotId, FileId, Json, NodeId, VariableId, WorkflowId } from "./common";
import { UserData } from "./event";
import { VariableScope, VariableType } from "./variable";

/**
 * Platform shapes (architecture §2.3, ADR-015): workspace roles, key kinds and the JSON columns of
 * the platform tables. Database JSON columns are parsed with these on read and on write.
 */

/** Ordered from most to least powerful. */
export const WORKSPACE_ROLES = ["owner", "admin", "builder", "viewer"] as const;
export const WorkspaceRole = z.enum(WORKSPACE_ROLES);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const ApiKeyKind = z.enum(["workspace", "bridge"]);
export type ApiKeyKind = z.infer<typeof ApiKeyKind>;

export const AuditActorType = z.enum(["user", "api_key", "system"]);
export type AuditActorType = z.infer<typeof AuditActorType>;

/** `<area>.<verb>` and deeper, lower snake case: `api_key.created`, `member.role_changed`. */
export const AuditAction = z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/, "Expected area.verb");

export const WorkspaceSlug = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/, "Use 1–48 lower-case letters, digits or dashes");

export const WorkspaceName = z.string().trim().min(1, "Enter a name").max(100, "Use 100 characters or fewer");

/**
 * `workspaces.settings`. No settings are defined yet; the schema is closed so nothing unreviewed
 * lands in the column. Add fields here, with their defaults, when a task needs one.
 */
export const WorkspaceSettings = z.strictObject({
  /** Task 6.2: the model a step uses when it names none, and the cheap one for summaries and checks. */
  defaultModel: z.string().min(1).max(100).optional(),
  utilityModel: z.string().min(1).max(100).optional(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

/** `audit_log.meta`: what changed, as small JSON values. Never secrets, never message content. */
export const AuditMeta = z.record(z.string(), Json);
export type AuditMeta = z.infer<typeof AuditMeta>;

/** `workspace_secrets.name`: lower-case, for example `anthropic.api_key`. */
export const SecretName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "Use lower-case letters, digits, . _ or -");

// Studio sign-in API (task 1.2). Passwords: 8–128 characters (NIST SP 800-63B minimum).

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const EmailAddress = z.email("Enter a valid email address").max(320, "Use 320 characters or fewer");
export const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer`);

export const SignUpRequest = z.strictObject({
  name: z.string().trim().min(1, "Enter your name").max(200, "Use 200 characters or fewer"),
  email: EmailAddress,
  password: Password,
});
export type SignUpRequest = z.infer<typeof SignUpRequest>;

export const SignInRequest = z.strictObject({
  email: EmailAddress,
  // Any length is accepted here, so a too-short password is "not correct", not a validation error.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

export const AuthUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string(),
});
export type AuthUser = z.infer<typeof AuthUser>;

/** GET /v1/auth/session and the sign-in and sign-up responses. Send `csrfToken` as `X-CSRF-Token` on mutations. */
export const SessionResponse = z.object({
  user: AuthUser,
  expiresAt: z.iso.datetime({ offset: false }),
  csrfToken: z.string(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

// Workspaces, members and invitations API (task 1.3). Lists use ADR-012's `{ data, nextCursor }`.

const isoDate = z.iso.datetime({ offset: false });

/** One entry of the workspace switcher. */
export const WorkspaceSummary = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: WorkspaceRole,
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const WorkspaceResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  region: z.string(),
  settings: WorkspaceSettings,
  createdAt: isoDate,
  updatedAt: isoDate,
  /**
   * The caller's role and what it allows, so the Studio can hide what it cannot do. An API key has
   * no role (`null`); `permissions` are then its scopes.
   */
  role: WorkspaceRole.nullable(),
  permissions: z.array(z.string()),
});
export type WorkspaceResponse = z.infer<typeof WorkspaceResponse>;

export const CreateWorkspaceRequest = z.strictObject({ name: WorkspaceName, slug: WorkspaceSlug });
export const UpdateWorkspaceRequest = z
  .strictObject({ name: WorkspaceName.optional(), slug: WorkspaceSlug.optional() })
  .refine((v) => v.name !== undefined || v.slug !== undefined, "Change at least one field");

export const MemberResponse = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: WorkspaceRole,
  createdAt: isoDate,
});
export type MemberResponse = z.infer<typeof MemberResponse>;

export const UpdateMemberRequest = z.strictObject({ role: WorkspaceRole });

export const InvitationResponse = z.object({
  id: z.string(),
  email: z.string(),
  role: WorkspaceRole,
  invitedBy: z.string().nullable(),
  expiresAt: isoDate,
  createdAt: isoDate,
});
export type InvitationResponse = z.infer<typeof InvitationResponse>;

/** Returned once, when the invitation is created. No mail is sent yet; the inviter shares the link. */
export const CreatedInvitationResponse = InvitationResponse.extend({ acceptUrl: z.url() });

export const CreateInvitationRequest = z.strictObject({ email: EmailAddress, role: WorkspaceRole });
export const AcceptInvitationRequest = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });

// API keys (task 1.4). The key itself appears once, in the create response.

export const ApiKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  /** `wk_live_<prefix>_…`: enough to recognise a key, useless to call with. */
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdBy: z.string().nullable(),
  lastUsedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type ApiKeyResponse = z.infer<typeof ApiKeyResponse>;

export const CreatedApiKeyResponse = ApiKeyResponse.extend({ key: z.string() });

export const CreateApiKeyRequest = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).min(1).max(64),
  expiresAt: isoDate.optional(),
});

// Audit log API (task 1.6). Newest first, cursor-paginated (ADR-012).

export const AuditEntryResponse = z.object({
  id: z.string(),
  at: isoDate,
  actor: z.object({ type: AuditActorType, id: z.string().nullable() }),
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string() }).nullable(),
  meta: AuditMeta,
  ip: z.string().nullable(),
});
export type AuditEntryResponse = z.infer<typeof AuditEntryResponse>;

export const ListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

// Bots and draft documents (task 2.1, ADR-006). Documents carry an integer revision sent as ETag.

/** `bots.settings`: platform settings of a bot (not its behaviour, which is the manifest). Closed until a task adds one. */
export const BotRecordSettings = z.strictObject({});

export const BotSlug = WorkspaceSlug;

export const BotResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  defaultLocale: z.string(),
  publishedVersionId: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type BotResponse = z.infer<typeof BotResponse>;

export const DraftDocSummary = z.object({
  kind: z.enum(["manifest", "workflow"]),
  docId: z.string(),
  rev: z.number().int(),
  /** Workflow name, or the bot's name for the manifest. */
  name: z.string(),
  updatedAt: isoDate,
});
export type DraftDocSummary = z.infer<typeof DraftDocSummary>;

export const BotDetailResponse = BotResponse.extend({ docs: z.array(DraftDocSummary) });

export const BotName = z.string().trim().min(1, "Enter a name").max(80, "Use 80 characters or fewer");

export const CreateBotRequest = z.strictObject({
  name: BotName,
  slug: BotSlug,
  defaultLocale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/)
    .optional(),
});
export const UpdateBotRequest = z
  .strictObject({ name: BotName.optional(), slug: BotSlug.optional() })
  .refine((v) => v.name !== undefined || v.slug !== undefined, "Change at least one field");

/** GET and PUT of a draft document. The body of a PUT is `{ doc }`; the revision travels in If-Match. */
export const DraftDocResponse = z.object({
  kind: z.enum(["manifest", "workflow"]),
  docId: z.string(),
  rev: z.number().int(),
  doc: z.record(z.string(), z.unknown()),
});
export type DraftDocResponse = z.infer<typeof DraftDocResponse>;

/* ------------------------------------------------------------------ */
/* Versions (task 7.1, ADR-006, ADR-036)                               */
/* ------------------------------------------------------------------ */

/** `POST …/bots/{botId}/versions`: publish the draft. The label is required (design system §5.8). */
export const PublishRequest = z.strictObject({
  label: z.string().trim().min(1, "Enter a label").max(80, "Use 80 characters or fewer"),
  notes: z.string().max(2_000, "Use 2,000 characters or fewer").optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const VersionSummary = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  label: z.string(),
  notes: z.string(),
  /** SHA-256 of the definition's canonical JSON (ADR-036 §2). */
  definitionHash: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: isoDate,
  /** This is the version live conversations run. */
  live: z.boolean(),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const VersionResponse = VersionSummary.extend({ definition: z.record(z.string(), z.unknown()) });
export type VersionResponse = z.infer<typeof VersionResponse>;

/** `POST …/versions/{versionId}/restore`: which draft workflows the restore deleted. */
export const RestoreResponse = z.object({ removedWorkflows: z.array(z.string()) });
export type RestoreResponse = z.infer<typeof RestoreResponse>;

/* ------------------------------------------------------------------ */
/* Config variable values (task 7.3, ADR-037)                          */
/* ------------------------------------------------------------------ */

export const ConfigEnv = z.enum(["draft", "production"]);
export type ConfigEnv = z.infer<typeof ConfigEnv>;

/** `PUT …/bots/{botId}/config/{env}/{key}`. */
export const SetConfigValueRequest = z.strictObject({
  value: z.string().max(8_192, "Use 8,192 characters or fewer"),
});

/** One environment of a config variable: set or not, and the value only when it is not secret. */
export const ConfigValueState = z.object({
  set: z.boolean(),
  value: z.string().nullable(),
  updatedAt: isoDate.nullable(),
});

/** `GET …/bots/{botId}/config`: every key the draft declares, plus stored keys it no longer declares. */
export const ConfigVariableResponse = z.object({
  key: z.string(),
  secret: z.boolean(),
  description: z.string().nullable(),
  declared: z.boolean(),
  draft: ConfigValueState,
  production: ConfigValueState,
});
export type ConfigVariableResponse = z.infer<typeof ConfigVariableResponse>;

/* ------------------------------------------------------------------ */
/* Emulator (task 4.6, ADR-025)                                        */
/* ------------------------------------------------------------------ */

/** `POST …/emulator/conversations/{externalId}/run-from`: start a new emulator run at a node. */
export const RunFromRequest = z.strictObject({
  userId: z.string().min(1).max(255),
  user: UserData.optional(),
  workflowId: WorkflowId,
  nodeId: NodeId,
});
export type RunFromRequest = z.infer<typeof RunFromRequest>;

/** One variable in the emulator's Variables tab. Sensitive values are never sent (`variable.ts`). */
export const EmulatorVariable = z.object({
  id: VariableId,
  name: z.string(),
  scope: VariableScope,
  type: VariableType,
  /** The current value, or the declared default when none is set; null when sensitive or unset. */
  value: Json.nullable(),
  sensitive: z.boolean(),
  /** For workflow scope: the workflow of the frame on top of the stack. */
  workflowId: WorkflowId.optional(),
});
export type EmulatorVariable = z.infer<typeof EmulatorVariable>;

/** `GET …/emulator/conversations/{externalId}/state`: the Variables tab and its size meter. */
export const EmulatorStateResponse = z.object({
  conversationId: z.string(),
  status: z.enum(["idle", "waiting_input", "waiting_external", "handed_off", "ended"]),
  variables: z.array(EmulatorVariable),
  /** `user.attributes`: data pushed by the bridge, here the emulator's user-data form. */
  attributes: z.record(z.string(), Json),
  stateBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});
export type EmulatorStateResponse = z.infer<typeof EmulatorStateResponse>;

/* ------------------------------------------------------------------ */
/* Files (task 8.1, ADR-039)                                           */
/* ------------------------------------------------------------------ */

export const FilePurpose = z.enum(["kb_source"]);
export type FilePurpose = z.infer<typeof FilePurpose>;

/** `POST …/files`: announce an upload. Type and size are checked against `FILE_LIMITS`. */
export const CreateFileRequest = z.strictObject({
  purpose: FilePurpose,
  name: z.string().trim().min(1, "Enter a file name").max(255, "Use 255 characters or fewer"),
  mime: z.string().min(3).max(255),
  size: z.number().int().positive(),
  botId: BotId.optional(),
});
export type CreateFileRequest = z.infer<typeof CreateFileRequest>;

export const FileResponse = z.object({
  id: FileId,
  botId: BotId.nullable(),
  purpose: FilePurpose,
  name: z.string(),
  mime: z.string(),
  size: z.number().int().positive(),
  status: z.enum(["pending", "ready"]),
  createdAt: isoDate,
});
export type FileResponse = z.infer<typeof FileResponse>;

/** A presigned request the browser sends the bytes with; the api never proxies them (ADR-039 §2). */
export const PresignedRequest = z.object({
  url: z.string(),
  method: z.enum(["PUT", "GET"]),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDate,
});
export type PresignedRequest = z.infer<typeof PresignedRequest>;

export const CreateFileResponse = z.object({ file: FileResponse, upload: PresignedRequest });
export type CreateFileResponse = z.infer<typeof CreateFileResponse>;

/* ------------------------------------------------------------------ */
/* Knowledge base sources (task 8.5, ADR-042)                          */
/* ------------------------------------------------------------------ */

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048, "Use a URL of 2,048 characters or fewer");

/** One source of documents. Crawls stay on the start URL's origin unless `sameOriginOnly` is off. */
export const KbSourceConfig = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), fileId: FileId }),
  z.strictObject({
    kind: z.literal("text"),
    title: z.string().trim().min(1, "Enter a title").max(200),
    text: z.string().min(1, "Enter some text").max(200_000, "Use 200,000 characters or fewer"),
  }),
  z.strictObject({ kind: z.literal("url"), url: httpUrl }),
  z.strictObject({
    kind: z.literal("sitemap"),
    url: httpUrl,
    maxPages: z.int().min(1).max(1_000).default(100),
  }),
  z.strictObject({
    kind: z.literal("crawl"),
    url: httpUrl,
    maxDepth: z.int().min(0).max(5).default(2),
    maxPages: z.int().min(1).max(1_000).default(100),
    sameOriginOnly: z.boolean().default(true),
  }),
]);
export type KbSourceConfig = z.infer<typeof KbSourceConfig>;

/** How often url, sitemap and crawl sources re-sync; null means only when asked. */
export const KbSyncSchedule = z.enum(["1 hour", "6 hours", "1 day", "7 days"]).nullable();
export type KbSyncSchedule = z.infer<typeof KbSyncSchedule>;
