import { z } from "zod";
import { Json } from "./common";

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

export const WorkspaceName = z.string().trim().min(1).max(100);

/**
 * `workspaces.settings`. No settings are defined yet; the schema is closed so nothing unreviewed
 * lands in the column. Add fields here, with their defaults, when a task needs one.
 */
export const WorkspaceSettings = z.strictObject({});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

/** `audit_log.meta`: what changed, as small JSON values. Never secrets, never message content. */
export const AuditMeta = z.record(z.string(), Json);
export type AuditMeta = z.infer<typeof AuditMeta>;

/** `workspace_secrets.name`: lower-case, for example `anthropic.api_key`. */
export const SecretName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "Use lower-case letters, digits, . _ or -");

// Studio sign-in API (task 1.2). Passwords: 8–128 characters (NIST SP 800-63B minimum).

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const EmailAddress = z.email().max(320);
export const Password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const SignUpRequest = z.strictObject({
  name: z.string().trim().min(1).max(200),
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
