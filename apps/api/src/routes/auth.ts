import type { SessionView } from "@wakeel/auth";
import { SessionResponse, SignInRequest, SignUpRequest } from "@wakeel/contracts";
import type { FastifyInstance } from "fastify";
import { requestContext, requireSession, requireStudioOrigin } from "../session";
import type { StudioDeps } from "../studio";

export type AuthRoutesOptions = Pick<StudioDeps, "auth" | "studioOrigin">;

const toResponse = (s: SessionView): SessionResponse =>
  SessionResponse.parse({ user: s.user, expiresAt: s.expiresAt.toISOString(), csrfToken: s.csrfToken });

/** `/v1/auth/*`: sign up, sign in, sign out and the current session (task 1.2). */
export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { auth, studioOrigin } = options;

  app.post("/v1/auth/sign-up", async (request, reply) => {
    requireStudioOrigin(request, studioOrigin);
    const body = SignUpRequest.parse(request.body);
    const { value, setCookie } = await auth.signUp(body, requestContext(request));
    return reply.code(201).header("set-cookie", setCookie).send(toResponse(value));
  });

  app.post("/v1/auth/sign-in", async (request, reply) => {
    requireStudioOrigin(request, studioOrigin);
    const body = SignInRequest.parse(request.body);
    const { value, setCookie } = await auth.signIn(body, requestContext(request));
    return reply.code(200).header("set-cookie", setCookie).send(toResponse(value));
  });

  app.post("/v1/auth/sign-out", async (request, reply) => {
    await requireSession(auth, studioOrigin, request, reply);
    const { setCookie } = await auth.signOut(requestContext(request));
    return reply.code(204).header("set-cookie", setCookie).send();
  });

  app.get("/v1/auth/session", async (request, reply) => {
    const session = await requireSession(auth, studioOrigin, request, reply);
    // A session response must never be cached by a browser or proxy.
    return reply.header("cache-control", "no-store").send(toResponse(session));
  });
}
