/** `pnpm db:migrate`: applies pending migrations as app_migrator. */
import { loadConfigOrExit, migratorDatabaseEnv } from "@wakeel/config";
import { MigrationError, migrate } from "../migrate";

const config = loadConfigOrExit(migratorDatabaseEnv);
if (config) {
  try {
    const { applied } = await migrate(config.migratorDatabaseUrl.reveal());
    process.stdout.write(applied.length === 0 ? "Already up to date.\n" : `Applied ${applied.join(", ")}.\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof MigrationError ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
