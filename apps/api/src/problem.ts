import { BRAND } from "@wakeel/config/brand";
import { AppError, ERRORS, type ErrorCode, type FieldError, formatPath, type Problem } from "@wakeel/contracts";
import { z } from "zod";

/** RFC 9457 problem documents (ADR-012). Every API failure leaves through `toProblem`. */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function problemType(code: ErrorCode): string {
  return `${BRAND.docsUrl}/errors/${code}`;
}

/** Field errors from a zod failure, with paths written as `message.text` or `items[1].qty`. */
export function zodFieldErrors(error: z.core.$ZodError): FieldError[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), code: issue.code, message: issue.message }));
}

/** Fastify's own request errors, by their code, mapped to the catalogue. */
const FASTIFY_ERRORS: Record<string, (e: { statusCode?: number }) => AppError> = {
  FST_ERR_CTP_BODY_TOO_LARGE: () => new AppError("payload_too_large", { limit: "the request size limit" }),
  FST_ERR_CTP_INVALID_JSON_BODY: () => new AppError("validation_failed"),
  FST_ERR_CTP_EMPTY_JSON_BODY: () => new AppError("validation_failed"),
  FST_ERR_CTP_INVALID_MEDIA_TYPE: () => new AppError("validation_failed"),
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: () => new AppError("validation_failed"),
};

/**
 * Turns anything thrown in a request into an AppError. Unknown errors become `internal_error`; their
 * message never reaches the client (it may contain internals), only the log.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof z.core.$ZodError) {
    return new AppError("validation_failed", {}, { errors: zodFieldErrors(error), cause: error });
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code in FASTIFY_ERRORS) {
    const map = FASTIFY_ERRORS[code];
    if (map) return map(error as { statusCode?: number });
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  if (status === 404 || status === 405) return new AppError("not_found", {}, { cause: error });
  return new AppError("internal_error", {}, { cause: error });
}

export function toProblem(error: AppError, requestId: string): Problem {
  const params = error.code === "internal_error" ? { ...error.params, requestId } : error.params;
  const problem: Problem = {
    type: problemType(error.code),
    title: error.title,
    status: ERRORS[error.code].status,
    code: error.code,
    fix: new AppError(error.code, params).fix,
    requestId,
  };
  if (error.detail !== undefined) problem.detail = error.detail;
  if (error.errors !== undefined) problem.errors = error.errors;
  if (error.current !== undefined) problem.current = error.current;
  return problem;
}
