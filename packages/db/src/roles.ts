import pg from "pg";

/** Database roles (architecture §2.1). Their privileges are set here and in migration 0001. */
export const ROLES = {
  /** Owns every object; used only by the migration runner. */
  migrator: "app_migrator",
  /** Used by api and worker: data access only, no DDL, never bypasses RLS. */
  rw: "app_rw",
  /** Support tooling: read-only and still bound by RLS. */
  adminRo: "app_admin_ro",
} as const;
export type RoleName = (typeof ROLES)[keyof typeof ROLES];

export type RolePasswords = Record<RoleName, string>;

const ROLE_ATTRIBUTES = "login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit";
const MIN_PASSWORD_LENGTH = 16;

/**
 * Creates or updates the three roles and grants them access to the database in `superuserUrl`.
 * Needs a superuser (or the managed provider's admin role); runs once per environment before the
 * first migration and again whenever passwords rotate. Safe to run repeatedly.
 *
 * Also creates the `vector` extension, which needs elevated rights that app_migrator does not have.
 *
 * Not safe to run twice at the same moment against one cluster: roles are cluster-wide, and
 * concurrent ALTER ROLE statements fail with "tuple concurrently updated". Run it from one place.
 */
export async function bootstrapDatabase(superuserUrl: string, passwords: RolePasswords): Promise<void> {
  for (const role of Object.values(ROLES)) {
    const password = passwords[role];
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`The password for ${role} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
  }

  const client = new pg.Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await client.query("create extension if not exists vector");

    for (const role of Object.values(ROLES)) {
      const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
      const verb = exists.rowCount === 0 ? "create" : "alter";
      // Role DDL cannot take bind parameters; the password is escaped as a literal and never logged.
      await client.query(
        `${verb} role ${client.escapeIdentifier(role)} with ${ROLE_ATTRIBUTES} password ${client.escapeLiteral(passwords[role])}`,
      );
    }

    const database = client.escapeIdentifier((await client.query("select current_database() as db")).rows[0].db);
    const { migrator, rw, adminRo } = ROLES;
    await client.query(`revoke all on database ${database} from public`);
    await client.query(`grant connect on database ${database} to ${migrator}, ${rw}, ${adminRo}`);
    // app_migrator creates the app_internal schema in migration 0001.
    await client.query(`grant create on database ${database} to ${migrator}`);
    await client.query("revoke create on schema public from public");
    await client.query(`grant usage, create on schema public to ${migrator}`);
    await client.query(`grant usage on schema public to ${rw}, ${adminRo}`);
  } finally {
    await client.end();
  }
}
