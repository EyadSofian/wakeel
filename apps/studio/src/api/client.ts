import { ERRORS, type ErrorCode, Problem } from "@wakeel/contracts";

/**
 * The Studio's only way to call the api (ADR-012). Same-origin requests carry the session cookie;
 * every mutation carries the CSRF token from the session response (task 1.2). Failures become
 * `ApiError` holding the problem document, whose title and fix the screens show as they are.
 */
export class ApiError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }
  get code(): string {
    return this.problem.code;
  }
}

let csrfToken: string | undefined;

/** Set from every session response; cleared on sign-out. */
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

/** A problem for failures that never reached the api (offline, proxy down). */
function networkProblem(): Problem {
  const code: ErrorCode = "internal_error";
  return {
    type: "about:blank",
    title: ERRORS[code].title,
    status: 0,
    code,
    fix: "Check your connection and try again.",
    requestId: "",
  };
}

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken !== undefined) headers["x-csrf-token"] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(networkProblem());
  }
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const parsed = Problem.safeParse(json);
    throw new ApiError(parsed.success ? parsed.data : networkProblem());
  }
  return json as T;
}

/** Field errors from a problem, by path, for forms. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const e of error.problem.errors ?? []) if (out[e.path] === undefined) out[e.path] = e.message;
  return out;
}
