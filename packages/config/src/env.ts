import { readFileSync } from "node:fs";
import type { z } from "zod";

/**
 * Configuration is parsed once at boot (architecture §17). A missing or invalid variable stops the
 * process with a message that names the variable and says what it should hold. Every problem is
 * reported together, so an operator fixes the environment in one pass.
 *
 * Secrets may also come from a mounted file named by `<NAME>_FILE` (Docker and Kubernetes secrets).
 * Their values never appear in error messages, and once loaded they are wrapped in `Secret`, which
 * prints as `[redacted]` in logs, JSON and `util.inspect`.
 */

export interface EnvVar<S extends z.ZodType = z.ZodType> {
  /** Name of the environment variable. */
  env: string;
  /** Parses the raw string (or `undefined` when unset). Use `.default()` for optional variables. */
  schema: S;
  /** What the variable holds and how to set it. Shown in every error about it. */
  description: string;
  /** Never echoed; may be read from `<env>_FILE`; returned wrapped in `Secret`. */
  secret?: boolean;
}

export type EnvSpec = Record<string, EnvVar>;

export type ConfigOf<S extends EnvSpec> = {
  readonly [K in keyof S]: S[K] extends { secret: true } ? Secret<z.output<S[K]["schema"]>> : z.output<S[K]["schema"]>;
};

/** Identity helper that keeps the literal types of a spec (`secret: true`, enum values). */
export const defineEnv = <const S extends EnvSpec>(spec: S): S => spec;

const REDACTED = "[redacted]";

/** A value that must not reach logs, traces, API responses or prompts. Call `reveal()` where it is used. */
export class Secret<T> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  reveal(): T {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export type ConfigProblemKind = "missing" | "invalid" | "conflict" | "unreadable_file";

export interface ConfigProblem {
  variable: string;
  kind: ConfigProblemKind;
}

/** Thrown by `loadConfig`; `message` lists every problem, one per line. */
export class ConfigError extends Error {
  readonly problems: ConfigProblem[];
  constructor(problems: ConfigProblem[], lines: string[]) {
    super(`Configuration is not valid:\n${lines.map((l) => `  - ${l}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface LoadOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Reads a `<NAME>_FILE` path. Defaults to `fs.readFileSync(path, "utf8")`. */
  readFile?: (path: string) => string;
}

/** Parses `spec` from the environment. Throws `ConfigError` listing every problem. */
export function loadConfig<const S extends EnvSpec>(spec: S, options: LoadOptions = {}): ConfigOf<S> {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const problems: ConfigProblem[] = [];
  const lines: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [key, v] of Object.entries(spec)) {
    const fail = (kind: ConfigProblemKind, line: string) => {
      problems.push({ variable: v.env, kind });
      lines.push(line);
    };

    let raw = blankToUndefined(env[v.env]);
    if (v.secret) {
      const fileVar = `${v.env}_FILE`;
      const path = blankToUndefined(env[fileVar]);
      if (path !== undefined && raw !== undefined) {
        fail("conflict", `${v.env} and ${fileVar} are both set. Set only one.`);
        continue;
      }
      if (path !== undefined) {
        try {
          raw = readFile(path).replace(/\r?\n$/, "");
        } catch (e) {
          const code = (e as { code?: unknown }).code;
          fail(
            "unreadable_file",
            `${fileVar} points to ${path}, which could not be read (${typeof code === "string" ? code : "error"}).`,
          );
          continue;
        }
      }
    }

    const result = v.schema.safeParse(raw);
    if (result.success) {
      out[key] = v.secret ? new Secret(result.data) : result.data;
      continue;
    }
    if (raw === undefined) {
      fail("missing", `${v.env} is missing. ${v.description}`);
    } else if (v.secret) {
      // zod messages do not include the input today; not relying on that for secrets.
      fail("invalid", `${v.env} is not valid. ${v.description}`);
    } else {
      const detail = result.error.issues.map((i) => i.message).join("; ");
      fail("invalid", `${v.env} is not valid: ${stripFinalStop(detail)}. ${v.description}`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems, lines);
  return Object.freeze(out) as ConfigOf<S>;
}

export interface ExitOptions extends LoadOptions {
  /** Defaults to writing to `process.stderr`. */
  stderr?: (text: string) => void;
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Boot helper for services: loads the config or prints the problems and exits with code 1.
 * Returns `undefined` only when an injected `exit` returns instead of ending the process.
 */
export function loadConfigOrExit<const S extends EnvSpec>(spec: S, options: ExitOptions = {}): ConfigOf<S> | undefined {
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  try {
    return loadConfig(spec, options);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    stderr(`${e.message}\n`);
    exit(1);
    return undefined;
  }
}

const blankToUndefined = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v);
const stripFinalStop = (s: string) => s.replace(/\.$/, "");
