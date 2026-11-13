import { AppError } from "@wakeel/contracts";

const UNIQUE_VIOLATION = "23505";

/** Finds the Postgres error under Drizzle's wrapper, which keeps the driver error as `cause`. */
export function pgError(error: unknown): { code?: string; constraint?: string } | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ("code" in current && typeof current.code === "string") return current as { code: string; constraint?: string };
    current = current.cause;
  }
  return undefined;
}

/**
 * Turns a unique violation on one of `constraints` (constraint name → column shown to the user)
 * into `unique_violation`. Any other error is rethrown unchanged.
 */
export function rethrowUnique(constraints: Record<string, string>) {
  return (error: unknown): never => {
    const pg = pgError(error);
    const column = pg?.code === UNIQUE_VIOLATION && pg.constraint ? constraints[pg.constraint] : undefined;
    if (column !== undefined) throw new AppError("unique_violation", { column }, { cause: error });
    throw error;
  };
}
