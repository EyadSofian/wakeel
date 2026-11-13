import { z } from "zod";
import { defineEnv } from "./env";

/**
 * Variables grouped by what needs them. A service spreads the groups it uses into one spec:
 * `loadConfigOrExit({ ...commonEnv, ...databaseEnv, ...apiEnv })`. Add a group in the phase that
 * first needs it (object store in Phase 8, sandbox runtime flag in Phase 3).
 */

export const commonEnv = defineEnv({
  nodeEnv: {
    env: "NODE_ENV",
    schema: z.enum(["development", "test", "production"]).default("development"),
    description: "One of development, test or production.",
  },
  logLevel: {
    env: "LOG_LEVEL",
    schema: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    description: "One of fatal, error, warn, info, debug, trace or silent.",
  },
});

export const databaseEnv = defineEnv({
  databaseUrl: {
    env: "DATABASE_URL",
    schema: z.url({ protocol: /^postgres(ql)?$/ }),
    description: "Postgres connection string for the app_rw role, for example postgres://app_rw:…@host:5432/wakeel.",
    secret: true,
  },
});

/** `pnpm db:migrate`: migrations run as app_migrator, which owns every object (ADR-004). */
export const migratorDatabaseEnv = defineEnv({
  migratorDatabaseUrl: {
    env: "MIGRATOR_DATABASE_URL",
    schema: z.url({ protocol: /^postgres(ql)?$/ }),
    description: "Postgres connection string for the app_migrator role. Used only to apply migrations.",
    secret: true,
  },
});

const rolePassword = z.string().min(16);

/**
 * `pnpm db:bootstrap`: creates the three roles. Needs a superuser (or the managed provider's admin
 * role) once per environment, and again when passwords rotate.
 */
export const bootstrapDatabaseEnv = defineEnv({
  superuserDatabaseUrl: {
    env: "SUPERUSER_DATABASE_URL",
    schema: z.url({ protocol: /^postgres(ql)?$/ }),
    description: "Postgres connection string for a superuser on the target database. Used only by db:bootstrap.",
    secret: true,
  },
  migratorPassword: {
    env: "APP_MIGRATOR_PASSWORD",
    schema: rolePassword,
    description: "Password to set for app_migrator; at least 16 characters.",
    secret: true,
  },
  rwPassword: {
    env: "APP_RW_PASSWORD",
    schema: rolePassword,
    description: "Password to set for app_rw; at least 16 characters.",
    secret: true,
  },
  adminRoPassword: {
    env: "APP_ADMIN_RO_PASSWORD",
    schema: rolePassword,
    description: "Password to set for app_admin_ro; at least 16 characters.",
    secret: true,
  },
});

export const redisEnv = defineEnv({
  redisUrl: {
    env: "REDIS_URL",
    schema: z.url({ protocol: /^rediss?$/ }),
    description: "Redis connection string, for example redis://localhost:6379.",
    secret: true,
  },
});

export const MASTER_KEY_BYTES = 32;

/** Standard base64 with padding: 32 bytes is 43 characters plus one `=`. */
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

export const masterKeyEnv = defineEnv({
  masterKey: {
    env: "MASTER_KEY",
    schema: z
      .string()
      .regex(BASE64_32)
      .transform((s) => new Uint8Array(Buffer.from(s, "base64")))
      .refine((bytes) => bytes.length === MASTER_KEY_BYTES),
    description:
      "32 random bytes encoded as base64; generate one with `openssl rand -base64 32`. Wraps per-row data keys.",
    secret: true,
  },
  masterKeyVersion: {
    env: "MASTER_KEY_VERSION",
    schema: z.coerce.number().int().min(1).default(1),
    description: "Version number of MASTER_KEY, stored with every row it encrypts. Raise it by one when rotating.",
  },
  previousMasterKeys: {
    env: "MASTER_KEYS_PREVIOUS",
    schema: z
      .string()
      .default("")
      .transform((s, ctx) => {
        const out: { version: number; key: Uint8Array }[] = [];
        for (const part of s
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "")) {
          const m = /^(\d+):([A-Za-z0-9+/]{43}=)$/.exec(part);
          if (!m) {
            ctx.addIssue({ code: "custom", message: "use version:base64 pairs separated by commas" });
            return z.NEVER;
          }
          out.push({ version: Number(m[1]), key: new Uint8Array(Buffer.from(m[2] ?? "", "base64")) });
        }
        return out;
      }),
    description:
      "Older master keys still needed to read rows not yet re-wrapped, as version:base64 pairs separated by commas. Empty unless a rotation is in progress.",
    secret: true,
  },
});

export const apiEnv = defineEnv({
  role: {
    env: "ROLE",
    schema: z.enum(["studio", "bridge", "all"]).default("all"),
    description: "Which routes this replica mounts: studio, bridge or all.",
  },
  port: {
    env: "PORT",
    schema: z.coerce.number().int().min(1).max(65_535).default(3000),
    description: "TCP port the HTTP server listens on.",
  },
  host: {
    env: "HOST",
    schema: z.string().min(1).default("127.0.0.1"),
    description: "Interface to listen on. 127.0.0.1 by default; containers set 0.0.0.0.",
  },
});

/** Studio sign-in (task 1.2, ADR-015). */
export const authEnv = defineEnv({
  authSecret: {
    env: "AUTH_SECRET",
    schema: z.string().min(32),
    description:
      "At least 32 random characters; generate with `openssl rand -base64 32`. Signs session cookies and CSRF tokens.",
    secret: true,
  },
  studioOrigin: {
    env: "STUDIO_ORIGIN",
    schema: z
      .url({ protocol: /^https?$/ })
      .transform((u) => new URL(u).origin)
      .default("http://127.0.0.1:5173"),
    description: "Origin the Studio is served from, for example https://studio.example.com. Only it may sign in.",
  },
  apiPublicUrl: {
    env: "API_PUBLIC_URL",
    schema: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
    description: "Public base URL of the api service, for example https://api.example.com.",
  },
});

/** Queues from architecture §11. */
export const QUEUE_NAMES = ["turn", "webhook", "kb-ingest", "kb-sync", "eval", "maintenance"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const queueList = z
  .string()
  .transform((s) => [
    ...new Set(
      s
        .split(",")
        .map((q) => q.trim())
        .filter((q) => q !== ""),
    ),
  ])
  .superRefine((names, ctx) => {
    if (names.length === 0) ctx.addIssue({ code: "custom", message: "list at least one queue" });
    const unknown = names.filter((n) => !(QUEUE_NAMES as readonly string[]).includes(n));
    if (unknown.length > 0) {
      ctx.addIssue({ code: "custom", message: `unknown queue ${unknown.map((n) => `"${n}"`).join(", ")}` });
    }
  })
  .transform((names) => names as QueueName[]);

export const workerEnv = defineEnv({
  queues: {
    env: "QUEUES",
    schema: queueList.default([...QUEUE_NAMES]),
    description: `Comma-separated queues this replica consumes, from: ${QUEUE_NAMES.join(", ")}. Unset means all.`,
  },
});

/**
 * Shared by the egress service and its callers (sandbox, worker). Callers send it as a bearer token;
 * the network policy is the first guard, this is the second (ADR-020).
 */
const egressToken = {
  env: "EGRESS_TOKEN",
  schema: z.string().min(32),
  description:
    "At least 32 random characters shared by the egress service and its callers; generate with `openssl rand -base64 32`.",
  secret: true,
} as const;

/** The egress service itself (task 3.1, ADR-020). */
export const egressEnv = defineEnv({
  egressToken,
  egressHost: {
    env: "EGRESS_HOST",
    schema: z.string().min(1).default("127.0.0.1"),
    description: "Interface the egress service listens on. 127.0.0.1 by default; containers set 0.0.0.0.",
  },
  egressPort: {
    env: "EGRESS_PORT",
    schema: z.coerce.number().int().min(1).max(65_535).default(4400),
    description: "TCP port the egress service listens on.",
  },
  egressRatePerMinute: {
    env: "EGRESS_RATE_PER_MINUTE",
    schema: z.coerce.number().int().min(1).default(600),
    description: "Outbound requests one workspace may make per minute through one egress replica, redirects included.",
  },
  egressRateBurst: {
    env: "EGRESS_RATE_BURST",
    schema: z.coerce.number().int().min(1).default(60),
    description: "Requests one workspace may make at once before EGRESS_RATE_PER_MINUTE applies.",
  },
});

/** Services that send tenant URLs out through egress: sandbox (3.3), worker webhook and KB fetch. */
export const egressClientEnv = defineEnv({
  egressToken,
  egressUrl: {
    env: "EGRESS_URL",
    schema: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:4400"),
    description: "Base URL of the egress service, for example http://egress:4400.",
  },
});
