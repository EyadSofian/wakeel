/**
 * `pnpm studio:shots [--screen <id>] [--update]` and `pnpm studio:motion [--screen <id>]`
 * (design system §8.1). Translates those flags into a Playwright run of the matching project.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [kind, ...args] = process.argv.slice(2);
if (kind !== "shots" && kind !== "motion") {
  process.stderr.write("Usage: review.ts shots|motion [--screen <id>] [--update]\n");
  process.exit(2);
}

const env: NodeJS.ProcessEnv = { ...process.env };
const playwrightArgs = ["exec", "playwright", "test", `--project=${kind}`];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") continue;
  if (arg === "--screen") {
    const id = args[++i];
    if (!id) {
      process.stderr.write("--screen needs a screen id, for example --screen gallery\n");
      process.exit(2);
    }
    env["REVIEW_SCREEN"] = id;
  } else if (arg === "--update") {
    playwrightArgs.push("--update-snapshots");
  } else {
    process.stderr.write(`Unknown option ${arg}. Use --screen <id> or --update.\n`);
    process.exit(2);
  }
}

const result = spawnSync("pnpm", playwrightArgs, {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
