import { readFileSync } from "node:fs";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  can,
  checkInvite,
  checkRemoval,
  checkRoleChange,
  PERMISSION_NAMES,
  type PERMISSIONS,
  permissionsOf,
  renderPermissionTable,
} from "../src/rbac";

/**
 * Task 1.3: every permission × role. The expected grid is written out here on purpose, separately
 * from the matrix, so changing who may do what takes an edit in two places and shows in review.
 * Columns: owner, admin, builder, viewer.
 */
const EXPECTED = `
workspace.read      Y Y Y Y
workspace.update    Y Y . .
workspace.delete    Y . . .
member.read         Y Y Y Y
member.invite       Y Y . .
member.update_role  Y Y . .
member.remove       Y Y . .
api_key.read        Y Y . .
api_key.create      Y Y . .
api_key.revoke      Y Y . .
secret.read         Y Y . .
secret.write        Y Y . .
audit.read          Y Y . .
usage.read          Y Y . .
bot.read            Y Y Y Y
bot.create          Y Y Y .
bot.update          Y Y Y .
bot.delete          Y Y Y .
bot.publish         Y Y Y .
connection.read     Y Y Y .
connection.manage   Y Y Y .
conversation.read   Y Y Y Y
eval.run            Y Y Y .
`
  .trim()
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .map(([permission, ...cells]) => ({ permission: permission ?? "", cells }));

describe("permission matrix", () => {
  test("lists exactly the expected permissions, in order", () => {
    expect(PERMISSION_NAMES).toEqual(EXPECTED.map((r) => r.permission));
  });

  const cases = EXPECTED.flatMap(({ permission, cells }) =>
    WORKSPACE_ROLES.map((role, i) => [permission, role, cells[i] === "Y"] as const),
  );
  test.each(cases)("%s for %s is %s", (permission, role, allowed) => {
    expect(can(role, permission as keyof typeof PERMISSIONS)).toBe(allowed);
  });

  test("a higher role holds every permission of a lower one", () => {
    for (let i = 1; i < WORKSPACE_ROLES.length; i++) {
      const higher = WORKSPACE_ROLES[i - 1] as WorkspaceRole;
      const lower = WORKSPACE_ROLES[i] as WorkspaceRole;
      for (const p of permissionsOf(lower)) expect(can(higher, p), `${higher} ${p}`).toBe(true);
    }
  });

  test("a viewer can only read", () => {
    for (const p of permissionsOf("viewer")) expect(p).toMatch(/\.read$/);
  });

  test("docs/security/rbac.md shows the same matrix", () => {
    const doc = readFileSync(new URL("../../../docs/security/rbac.md", import.meta.url), "utf8");
    expect(doc).toContain(renderPermissionTable());
  });
});

describe("role changes", () => {
  test.each([
    // actor, from, to, owners, result
    ["owner", "viewer", "owner", 1, undefined],
    ["owner", "owner", "admin", 2, undefined],
    ["owner", "owner", "admin", 1, "last_owner"],
    ["owner", "admin", "viewer", 1, undefined],
    ["admin", "viewer", "builder", 1, undefined],
    ["admin", "builder", "admin", 1, undefined],
    ["admin", "viewer", "owner", 1, "owner_only"],
    ["admin", "owner", "admin", 2, "owner_only"],
    ["builder", "viewer", "builder", 1, "not_allowed"],
    ["viewer", "viewer", "builder", 1, "not_allowed"],
  ] as const)("%s changing %s → %s with %i owner(s): %s", (actorRole, from, to, ownerCount, result) => {
    expect(checkRoleChange({ actorRole, from, to, ownerCount })).toBe(result);
  });
});

describe("removals", () => {
  test.each([
    ["owner", "owner", 2, undefined],
    ["owner", "owner", 1, "last_owner"],
    ["owner", "viewer", 1, undefined],
    ["admin", "admin", 1, undefined],
    ["admin", "owner", 2, "owner_only"],
    ["builder", "viewer", 1, "not_allowed"],
  ] as const)("%s removing a %s with %i owner(s): %s", (actorRole, targetRole, ownerCount, result) => {
    expect(checkRemoval({ actorRole, targetRole, ownerCount })).toBe(result);
  });
});

describe("invites", () => {
  test.each([
    ["owner", "owner", undefined],
    ["owner", "viewer", undefined],
    ["admin", "admin", undefined],
    ["admin", "owner", "owner_only"],
    ["builder", "viewer", "not_allowed"],
    ["viewer", "viewer", "not_allowed"],
  ] as const)("%s inviting a %s: %s", (actor, role, result) => {
    expect(checkInvite(actor, role)).toBe(result);
  });
});
