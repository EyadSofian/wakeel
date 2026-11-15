import { type DestinationStream, type Logger, pino } from "pino";

/**
 * Structured JSON logs for every service (CLAUDE.md §9: never log secrets, keys, session tokens or
 * signing secrets). Paths that commonly hold credentials are censored before a line is written;
 * values loaded as `Secret` (packages/config) already print as `[redacted]`.
 */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.secret",
  "*.apiKey",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.authorization",
];

export interface LoggerOptions {
  service: "api" | "worker" | "sandbox" | "egress" | "parser" | "tools";
  level?: string;
  /** Where lines go; stdout by default. Tests pass a stream to read them. */
  destination?: DestinationStream;
}

export type { Logger };

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
    },
    options.destination,
  );
}
