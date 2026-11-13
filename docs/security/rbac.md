# Workspace roles and permissions (task 1.3)

**Status: proposed in the 1.3 PR, for Eyad's review.** The docs named the four roles (architecture §2.3) but not what each may do. This page is the proposal. The source of truth is `PERMISSIONS` in `packages/auth/src/rbac.ts`, and a test fails if this table drifts from it.

## Roles

- **Owner**: everything, including other owners and deleting the workspace. A workspace always has at least one owner (`last_owner`).
- **Admin**: runs the workspace (members, API keys, secrets, settings, audit log, usage). Cannot make anyone an owner, change an owner or remove one.
- **Builder**: builds, tests and publishes bots and manages their connections. Sees the member list. Cannot manage people, keys or secrets.
- **Viewer**: reads bots, conversations and traces. Changes nothing.

## Matrix

| Permission | owner | admin | builder | viewer |
|---|:-:|:-:|:-:|:-:|
| `workspace.read` | ✓ | ✓ | ✓ | ✓ |
| `workspace.update` | ✓ | ✓ |  |  |
| `workspace.delete` | ✓ |  |  |  |
| `member.read` | ✓ | ✓ | ✓ | ✓ |
| `member.invite` | ✓ | ✓ |  |  |
| `member.update_role` | ✓ | ✓ |  |  |
| `member.remove` | ✓ | ✓ |  |  |
| `api_key.read` | ✓ | ✓ |  |  |
| `api_key.create` | ✓ | ✓ |  |  |
| `api_key.revoke` | ✓ | ✓ |  |  |
| `secret.read` | ✓ | ✓ |  |  |
| `secret.write` | ✓ | ✓ |  |  |
| `audit.read` | ✓ | ✓ |  |  |
| `usage.read` | ✓ | ✓ |  |  |
| `bot.read` | ✓ | ✓ | ✓ | ✓ |
| `bot.create` | ✓ | ✓ | ✓ |  |
| `bot.update` | ✓ | ✓ | ✓ |  |
| `bot.delete` | ✓ | ✓ | ✓ |  |
| `bot.publish` | ✓ | ✓ | ✓ |  |
| `connection.read` | ✓ | ✓ | ✓ |  |
| `connection.manage` | ✓ | ✓ | ✓ |  |
| `conversation.read` | ✓ | ✓ | ✓ | ✓ |
| `eval.run` | ✓ | ✓ | ✓ |  |

## Rules that depend on the target

These are not in the matrix because they depend on who is being changed. Code: `checkRoleChange`, `checkRemoval` and `checkInvite`.

- Only an owner may make someone an owner, change an owner's role or remove an owner.
- An admin may only give out roles at or below admin.
- The last owner cannot be demoted or removed: `last_owner` (409).
- An invitation carries the same ceiling as a role change.

## Open points for review

- Builders cannot read API keys. A builder who wants to call the API from CI needs an admin to create the key. The alternative is to give builders `api_key.read` and `api_key.create` for workspace keys.
- Builders publish to production. If publishing should need an admin, move `bot.publish` to owner and admin only.
- Bridge keys (per connection) come under `connection.manage` (Phase 4), not `api_key.*`.
