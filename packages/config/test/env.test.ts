import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ConfigError, defineEnv, loadConfig, loadConfigOrExit, Secret } from "../src/index";

const CANARY = "canary-s3cr3t-value-7f2c";

const spec = defineEnv({
  databaseUrl: {
    env: "DATABASE_URL",
    schema: z.url({ protocol: /^postgres(ql)?$/ }),
    description: "Postgres connection string for the app_rw role.",
    secret: true,
  },
  port: {
    env: "PORT",
    schema: z.coerce.number().int().min(1).max(65_535).default(3000),
    description: "Port the HTTP server listens on.",
  },
  role: {
    env: "ROLE",
    schema: z.enum(["studio", "bridge", "all"]).default("all"),
    description: "Which routes this api replica mounts.",
  },
});

const valid = { DATABASE_URL: `postgres://app_rw:${CANARY}@localhost:5432/wakeel`, PORT: "8080", ROLE: "bridge" };

const problemsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConfigError");
};

describe("loadConfig", () => {
  test("parses and coerces values", () => {
    const config = loadConfig(spec, { env: valid });
    expect(config.port).toBe(8080);
    expect(config.role).toBe("bridge");
    expect(config.databaseUrl.reveal()).toBe(valid.DATABASE_URL);
  });

  test("applies defaults for missing optional variables", () => {
    const config = loadConfig(spec, { env: { DATABASE_URL: valid.DATABASE_URL } });
    expect(config.port).toBe(3000);
    expect(config.role).toBe("all");
  });

  test("a missing variable error names the variable and says what it is", () => {
    const error = problemsOf(() => loadConfig(spec, { env: { PORT: "8080" } }));
    expect(error.problems).toEqual([{ variable: "DATABASE_URL", kind: "missing" }]);
    expect(error.message).toContain("DATABASE_URL is missing. Postgres connection string for the app_rw role.");
  });

  test("an empty string counts as missing", () => {
    const error = problemsOf(() => loadConfig(spec, { env: { DATABASE_URL: "" } }));
    expect(error.problems[0]).toEqual({ variable: "DATABASE_URL", kind: "missing" });
  });

  test("every problem is reported at once, not just the first", () => {
    const error = problemsOf(() => loadConfig(spec, { env: { PORT: "eighty", ROLE: "admin" } }));
    expect(error.problems.map((p) => p.variable)).toEqual(["DATABASE_URL", "PORT", "ROLE"]);
    expect(error.message).toMatch(/PORT is not valid: .+\. Port the HTTP server listens on\./);
    expect(error.message).toMatch(/ROLE is not valid: .*studio.*\. Which routes this api replica mounts\./);
  });

  test("an invalid secret never appears in the error", () => {
    const error = problemsOf(() => loadConfig(spec, { env: { DATABASE_URL: `mysql://u:${CANARY}@h/db` } }));
    expect(error.problems).toEqual([{ variable: "DATABASE_URL", kind: "invalid" }]);
    expect(error.message).toContain("DATABASE_URL is not valid. Postgres connection string");
    expect(error.message).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  });

  test("reads only the variables in the spec", () => {
    const config = loadConfig(spec, { env: { ...valid, UNRELATED: "x" } });
    expect(Object.keys(config).sort()).toEqual(["databaseUrl", "port", "role"]);
  });

  test("the result is frozen", () => {
    const config = loadConfig(spec, { env: valid });
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("secrets from a mounted file", () => {
  const files: Record<string, string> = { "/run/secrets/db": `${valid.DATABASE_URL}\n` };
  const readFile = (path: string) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return content;
  };

  test("<NAME>_FILE is read and the trailing newline dropped", () => {
    const config = loadConfig(spec, { env: { DATABASE_URL_FILE: "/run/secrets/db" }, readFile });
    expect(config.databaseUrl.reveal()).toBe(valid.DATABASE_URL);
  });

  test("setting both the variable and its file is an error", () => {
    const error = problemsOf(() =>
      loadConfig(spec, { env: { DATABASE_URL: valid.DATABASE_URL, DATABASE_URL_FILE: "/run/secrets/db" }, readFile }),
    );
    expect(error.problems).toEqual([{ variable: "DATABASE_URL", kind: "conflict" }]);
    expect(error.message).toContain("DATABASE_URL and DATABASE_URL_FILE are both set. Set only one.");
  });

  test("an unreadable file is reported with its path", () => {
    const error = problemsOf(() => loadConfig(spec, { env: { DATABASE_URL_FILE: "/run/secrets/nope" }, readFile }));
    expect(error.problems).toEqual([{ variable: "DATABASE_URL", kind: "unreadable_file" }]);
    expect(error.message).toContain("DATABASE_URL_FILE points to /run/secrets/nope, which could not be read (ENOENT).");
  });

  test("_FILE is ignored for variables that are not secret", () => {
    const config = loadConfig(spec, { env: { ...valid, PORT: undefined, PORT_FILE: "/run/secrets/db" }, readFile });
    expect(config.port).toBe(3000);
  });
});

describe("Secret", () => {
  test("never shows its value when printed, serialised or inspected", () => {
    const config = loadConfig(spec, { env: valid });
    expect(String(config.databaseUrl)).toBe("[redacted]");
    expect(`${config.databaseUrl}`).toBe("[redacted]");
    expect(JSON.stringify(config)).not.toContain(CANARY);
    expect(inspect(config, { depth: 5 })).not.toContain(CANARY);
    expect(config.databaseUrl).toBeInstanceOf(Secret);
  });
});

describe("loadConfigOrExit", () => {
  test("prints the problems and exits with code 1", () => {
    const lines: string[] = [];
    let code: number | undefined;
    loadConfigOrExit(spec, {
      env: {},
      stderr: (text) => lines.push(text),
      exit: (c) => {
        code = c;
      },
    });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("DATABASE_URL is missing.");
  });

  test("returns the config when it is valid", () => {
    const config = loadConfigOrExit(spec, {
      env: valid,
      stderr: () => undefined,
      exit: () => {
        throw new Error("should not exit");
      },
    });
    expect(config?.port).toBe(8080);
  });
});
