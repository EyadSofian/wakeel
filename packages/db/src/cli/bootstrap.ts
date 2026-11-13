/** `pnpm db:bootstrap`: creates or updates the database roles. Run before the first `db:migrate`. */
import { bootstrapDatabaseEnv, loadConfigOrExit } from "@wakeel/config";
import { bootstrapDatabase } from "../roles";

const config = loadConfigOrExit(bootstrapDatabaseEnv);
if (config) {
  try {
    await bootstrapDatabase(config.superuserDatabaseUrl.reveal(), {
      app_migrator: config.migratorPassword.reveal(),
      app_rw: config.rwPassword.reveal(),
      app_admin_ro: config.adminRoPassword.reveal(),
    });
    process.stdout.write("Roles app_migrator, app_rw and app_admin_ro are ready.\n");
  } catch (e) {
    process.stderr.write(`Bootstrap failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
