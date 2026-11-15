import { AppError } from "@wakeel/contracts";
import type { StepError } from "./ports";

/** An `AppError` (or anything thrown) as a step error. */
export function toStepError(error: unknown, turnId: string): StepError {
  const e =
    error instanceof AppError
      ? error
      : new AppError("internal_error", { requestId: turnId }, { detail: String(error), cause: error });
  return { code: e.code, message: e.detail ? `${e.title}: ${e.detail}` : e.title, fix: e.fix };
}
