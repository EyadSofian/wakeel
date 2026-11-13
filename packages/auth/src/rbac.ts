import { WORKSPACE_ROLES, type WorkspaceRole } from "@wakeel/contracts";

/**
 * Who may do what in a workspace (task 1.3, threat T7). The matrix is data: one row per permission,
 * listing the roles that hold it. `docs/security/rbac.md` shows it as a table; a test keeps the two
 * in step. Rules that depend on who the target is (owners, the last owner) are in
 * `checkRoleChange` and `checkRemoval`, not here.
 *
 * Roles, from most to least powerful:
 * - owner: everything, including other owners and deleting the workspace.
 * - admin: runs the workspace (members, keys, secrets, settings) but cannot touch owners.
 * - builder: builds and ships bots; reads members; cannot manage people, keys or secrets.
 * - viewer: reads bots, conversations and traces; changes nothing.
 */
export const PERMISSIONS = {
  "workspace.read": ["owner", "admin", "builder", "viewer"],
  "workspace.update": ["owner", "admin"],
  "workspace.delete": ["owner"],

  "member.read": ["owner", "admin", "builder", "viewer"],
  "member.invite": ["owner", "admin"],
  "member.update_role": ["owner", "admin"],
  "member.remove": ["owner", "admin"],

  "api_key.read": ["owner", "admin"],
  "api_key.create": ["owner", "admin"],
  "api_key.revoke": ["owner", "admin"],

  "secret.read": ["owner", "admin"],
  "secret.write": ["owner", "admin"],

  "audit.read": ["owner", "admin"],
  "usage.read": ["owner", "admin"],

  "bot.read": ["owner", "admin", "builder", "viewer"],
  "bot.create": ["owner", "admin", "builder"],
  "bot.update": ["owner", "admin", "builder"],
  "bot.delete": ["owner", "admin", "builder"],
  "bot.publish": ["owner", "admin", "builder"],

  "connection.read": ["owner", "admin", "builder"],
  "connection.manage": ["owner", "admin", "builder"],

  "conversation.read": ["owner", "admin", "builder", "viewer"],
  "eval.run": ["owner", "admin", "builder"],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as Permission[];

/** Whether `role` holds `permission`. */
export function can(role: WorkspaceRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly WorkspaceRole[]).includes(role);
}

/** Every permission a role holds, in matrix order. The Studio uses it to hide what a role cannot do. */
export function permissionsOf(role: WorkspaceRole): Permission[] {
  return PERMISSION_NAMES.filter((p) => can(role, p));
}

const rank = (role: WorkspaceRole) => WORKSPACE_ROLES.indexOf(role);

export type RoleChangeDenial = "not_allowed" | "owner_only" | "last_owner";

export interface RoleChange {
  actorRole: WorkspaceRole;
  /** The member's role before the change. */
  from: WorkspaceRole;
  to: WorkspaceRole;
  /** Owners in the workspace before the change. */
  ownerCount: number;
}

/**
 * Whether the actor may change a member from `from` to `to`. Only an owner may make someone an
 * owner or change an owner; the last owner can never stop being one, so a workspace always has
 * someone who can delete it or recover it.
 */
export function checkRoleChange(change: RoleChange): RoleChangeDenial | undefined {
  if (!can(change.actorRole, "member.update_role")) return "not_allowed";
  const touchesOwner = change.from === "owner" || change.to === "owner";
  if (touchesOwner && change.actorRole !== "owner") return "owner_only";
  if (change.from === "owner" && change.to !== "owner" && change.ownerCount <= 1) return "last_owner";
  // An admin may only hand out roles at or below their own.
  if (rank(change.to) < rank(change.actorRole)) return "owner_only";
  return undefined;
}

/** Whether the actor may remove a member with `targetRole`. Same owner rules as a role change. */
export function checkRemoval(input: {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  ownerCount: number;
}): RoleChangeDenial | undefined {
  if (!can(input.actorRole, "member.remove")) return "not_allowed";
  if (input.targetRole === "owner" && input.actorRole !== "owner") return "owner_only";
  if (input.targetRole === "owner" && input.ownerCount <= 1) return "last_owner";
  return undefined;
}

/** Whether the actor may invite someone with `role`: the same ceiling as a role change. */
export function checkInvite(actorRole: WorkspaceRole, role: WorkspaceRole): RoleChangeDenial | undefined {
  if (!can(actorRole, "member.invite")) return "not_allowed";
  if (role === "owner" && actorRole !== "owner") return "owner_only";
  if (rank(role) < rank(actorRole)) return "owner_only";
  return undefined;
}

/** The matrix as a Markdown table, as it appears in `docs/security/rbac.md`. */
export function renderPermissionTable(): string {
  const header = `| Permission | ${WORKSPACE_ROLES.join(" | ")} |`;
  const rule = `|---|${WORKSPACE_ROLES.map(() => ":-:").join("|")}|`;
  const rows = PERMISSION_NAMES.map(
    (p) => `| \`${p}\` | ${WORKSPACE_ROLES.map((r) => (can(r, p) ? "✓" : "")).join(" | ")} |`,
  );
  return [header, rule, ...rows].join("\n");
}
