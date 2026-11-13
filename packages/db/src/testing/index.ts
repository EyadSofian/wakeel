import { randomBytes } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { newId } from "@wakeel/contracts";
import { migrate } from "../migrate";
import { bootstrapDatabase, ROLES, type RolePasswords } from "../roles";

/**
 * Test harness for integration tests against real Postgres (build plan, test levels). Starts one
 * container with the same image as docker-compose.yml, bootstraps the roles, applies every
 * migration, and hands out a connection string per role.
 */

/** Must match docker-compose.yml; a test checks. */
export const TEST_POSTGRES_IMAGE =
  "pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd";

export interface TestDatabaseUrls {
  superuser: string;
  migrator: string;
  rw: string;
  adminRo: string;
  passwords: RolePasswords;
}

export interface StartedTestDatabase {
  urls: TestDatabaseUrls;
  stop(): Promise<void>;
}

const secret = () => randomBytes(18).toString("base64url");

export async function startTestDatabase(): Promise<StartedTestDatabase> {
  const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE)
    .withDatabase("wakeel_test")
    .withUsername("postgres")
    .withPassword(secret())
    .start();

  const superuser = container.getConnectionUri();
  const passwords: RolePasswords = { app_migrator: secret(), app_rw: secret(), app_admin_ro: secret() };
  await bootstrapDatabase(superuser, passwords);

  const urls: TestDatabaseUrls = {
    superuser,
    migrator: roleUrl(superuser, { user: ROLES.migrator, password: passwords.app_migrator }),
    rw: roleUrl(superuser, { user: ROLES.rw, password: passwords.app_rw }),
    adminRo: roleUrl(superuser, { user: ROLES.adminRo, password: passwords.app_admin_ro }),
    passwords,
  };
  await migrate(urls.migrator);

  return { urls, stop: async () => void (await container.stop()) };
}

/** Copies a connection string, replacing the user, password or database. */
export function roleUrl(url: string, change: { user?: string; password?: string; database?: string }): string {
  const u = new URL(url);
  if (change.user !== undefined) u.username = change.user;
  if (change.password !== undefined) u.password = change.password;
  if (change.database !== undefined) u.pathname = `/${change.database}`;
  return u.toString();
}

/**
 * Two fresh workspaces, in both orders. Architecture §2.1: every repository test runs as tenant A
 * and as tenant B and asserts the other sees nothing. Use with `describe.each(tenantPairs())`.
 */
export function tenantPairs(): [{ owner: string; other: string }, { owner: string; other: string }] {
  const a = newId("ws");
  const b = newId("ws");
  return [
    { owner: a, other: b },
    { owner: b, other: a },
  ];
}
