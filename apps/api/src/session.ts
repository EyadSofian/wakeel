import type { AuthService, RequestContext, SessionView } from "@wakeel/auth";
import { CSRF_HEADER } from "@wakeel/auth";
import { AppError } from "@wakeel/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Cookie sessions for the Studio API (ADR-012, threat T7).
 *
 * - Every request that changes something and carries a session cookie needs `X-CSRF-Token`.
 * - Sign-in and sign-up have no session yet, so they must come from the Studio's origin.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requestContext(request: FastifyRequest): RequestContext {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  return { headers, ip: request.ip };
}

/** Rejects a browser request from any origin but the Studio's. */
export function requireStudioOrigin(request: FastifyRequest, studioOrigin: string): void {
  const origin = request.headers.origin;
  if (origin !== studioOrigin) throw new AppError("csrf_failed");
}

/**
 * The signed-in session, or `unauthenticated`. On a mutation, also checks the CSRF token and the
 * origin. Forwards a refreshed session cookie when better-auth issues one.
 */
export async function requireSession(
  auth: AuthService,
  studioOrigin: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionView> {
  const { value: session, setCookie } = await auth.getSession(requestContext(request));
  if (setCookie.length > 0) reply.header("set-cookie", setCookie);
  if (!session) throw new AppError("unauthenticated");
  if (!SAFE_METHODS.has(request.method)) {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== studioOrigin) throw new AppError("csrf_failed");
    const token = request.headers[CSRF_HEADER];
    if (!auth.verifyCsrf(session, typeof token === "string" ? token : undefined)) throw new AppError("csrf_failed");
  }
  return session;
}
